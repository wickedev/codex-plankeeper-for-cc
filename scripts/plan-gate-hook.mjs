#!/usr/bin/env node
// PreToolUse hook on ExitPlanMode: before the user is ever asked to approve a
// plan, Codex reviews it against the actual codebase (read-only sandbox in the
// project cwd). A deficient plan is denied with the review feedback as the
// reason — Claude revises the plan and calls ExitPlanMode again — so the
// review/fix loop finishes before the approval dialog appears.
//
// Allowing here means "no output": the normal permission flow (the user's
// approval dialog) proceeds untouched. This hook never emits
// permissionDecision "allow", because that would auto-approve the plan and
// skip the user entirely.
//
// Fails open by design: judge errors, timeouts, a missing codex CLI, an
// unlocatable plan text, or the iteration cap all let the plan through to the
// user with a stderr note. A broken judge can never hide a plan from the user.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { codexAvailable, runCodexJudge } from "./lib/codex.mjs";
import {
  newSessionState,
  pushHistory,
  readConfig,
  readSessionState,
  resolveJudge,
  writeSessionState
} from "./lib/state.mjs";
import { planHash, resolvePlanText } from "./lib/plan-source.mjs";
import { recentUserRequests } from "./lib/transcript.mjs";
import { parseVerdict } from "./lib/verdict.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = path.join(SCRIPT_DIR, "..", "prompts", "plan-review.md");
const JUDGE_TIMEOUT_MS = 10 * 60 * 1000;
// Consecutive judge failures tolerated before the gate stands down. Without
// this a judge that is permanently broken (no auth, usage limit) would run a
// pointless 10-minute attempt on every ExitPlanMode for the rest of the session.
const JUDGE_ERROR_CAP = 3;

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  // Opt-in capture of the raw PreToolUse payload; the field set is internal to
  // Claude Code, and this is how you check what a given version actually sends.
  const debugPath = process.env.PLANKEEPER_DEBUG_INPUT;
  if (debugPath && raw) {
    try {
      fs.appendFileSync(debugPath, `${raw}\n`);
    } catch {
      // ignore
    }
  }
  return raw ? JSON.parse(raw) : {};
}

function note(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason
      }
    })}\n`
  );
}

function reviseReason(feedback, iteration, maxIterations) {
  return (
    `Codex plan review (iteration ${iteration}/${maxIterations}): the plan was NOT approved. ` +
    `An independent reviewer with read access to this codebase found the issues below. ` +
    `Revise the plan to address each one, then call ExitPlanMode again. Do not ask the user, ` +
    `do not argue with the review, and do not start implementing.\n\n${feedback}`
  );
}

function buildPrompt(plan, state, input) {
  const template = fs.readFileSync(PROMPT_PATH, "utf8");
  const requests = recentUserRequests(input.transcript_path);
  const userRequestBlock = requests.length
    ? `The user's request (most recent messages, oldest first):\n${requests.join("\n---\n")}`
    : "";
  const previousFeedbackBlock = state.lastFeedback
    ? `Your previous review of an earlier version of this plan required these fixes — check ` +
      `whether they were addressed instead of inventing new requirements:\n${state.lastFeedback}`
    : "";
  // Function replacements so `$&`-style sequences inside plan text are inert.
  return template
    .replace("{{PLAN}}", () => plan)
    .replace("{{USER_REQUEST_BLOCK}}", () => userRequestBlock)
    .replace("{{PREVIOUS_FEEDBACK_BLOCK}}", () => previousFeedbackBlock)
    .replace("{{ITERATION}}", String(state.iterations + 1))
    .replace("{{MAX_ITERATIONS}}", String(state.maxIterations));
}

function main() {
  const input = readHookInput();
  const config = readConfig();
  if (!config.enabled) {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId) {
    return;
  }

  const plan = resolvePlanText(input);
  if (!plan) {
    note("plankeeper: could not locate the plan text; letting the plan through unreviewed.");
    return;
  }
  const hash = planHash(plan);

  let state = readSessionState(sessionId) ?? newSessionState();
  state.maxIterations = state.maxIterations ?? config.maxIterations;

  if ((state.approvedHashes ?? []).includes(hash)) {
    // Same plan re-presented (e.g. the user chose "keep planning" and Claude
    // resubmitted unchanged). Already reviewed — no reason to spend a judge run.
    note("plankeeper: this exact plan was already approved — skipping re-review.");
    return;
  }

  if (state.status === "stood-down") {
    note("plankeeper: judge stood down earlier this session; letting the plan through unreviewed.");
    return;
  }

  if (state.iterations >= state.maxIterations) {
    // Never permanently hide a plan from the user: on cap, present it as-is
    // and reset so a genuinely new plan later gets a fresh review budget.
    state.status = "capped";
    state.iterations = 0;
    state.lastDeniedHash = null;
    state.lastFeedback = null;
    writeSessionState(sessionId, pushHistory(state, "capped", `hit max iterations (${state.maxIterations})`));
    note(
      `plankeeper: review cap (${state.maxIterations}) reached without approval — presenting ` +
        `the plan to the user as-is. Check /plankeeper:status for the last feedback.`
    );
    return;
  }

  if (state.lastDeniedHash === hash && state.lastFeedback) {
    // Unchanged plan resubmitted after a REVISE: repeat the feedback without a
    // judge run. The iteration still advances, so this cannot loop past the cap.
    state.iterations += 1;
    state.status = "revising";
    writeSessionState(sessionId, pushHistory(state, "repeat-deny", `unchanged plan ${hash.slice(0, 12)}`));
    deny(
      `${reviseReason(state.lastFeedback, state.iterations, state.maxIterations)}\n\n` +
        `Note: this plan is byte-identical to the version already reviewed — it must actually change.`
    );
    return;
  }

  if (!codexAvailable()) {
    note("plankeeper: codex CLI not found; letting the plan through unreviewed.");
    return;
  }

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const settings = resolveJudge(config);
  const judge = runCodexJudge(cwd, buildPrompt(plan, state, input), {
    timeoutMs: JUDGE_TIMEOUT_MS,
    sandbox: settings.sandbox.value || "read-only",
    model: settings.model.value,
    effort: settings.effort.value
  });

  const verdict = judge.ok ? parseVerdict(judge.lastMessage) : null;
  if (!verdict) {
    const reason = judge.ok ? "unparseable verdict" : judge.error;
    state.judgeErrors = (state.judgeErrors ?? 0) + 1;
    pushHistory(state, "judge-error", reason);
    if (state.judgeErrors >= JUDGE_ERROR_CAP) {
      state.status = "stood-down";
      writeSessionState(sessionId, pushHistory(state, "stood-down", `${state.judgeErrors} consecutive judge failures`));
      note(
        `plankeeper: judge failed ${state.judgeErrors} times in a row (${reason}). Standing down ` +
          `for this session — plans go through unreviewed. Check /plankeeper:status.`
      );
      return;
    }
    writeSessionState(sessionId, state);
    note(
      `plankeeper: judge failed (${reason}); letting the plan through unreviewed ` +
        `(${state.judgeErrors}/${JUDGE_ERROR_CAP} before standing down).`
    );
    return;
  }

  state.judgeErrors = 0;
  pushHistory(state, "verdict", `${verdict.kind}: ${verdict.detail}`);

  if (verdict.kind === "APPROVE") {
    state.approvedHashes = [...(state.approvedHashes ?? []), hash].slice(-20);
    state.status = "approved";
    state.iterations = 0;
    state.lastDeniedHash = null;
    state.lastFeedback = null;
    writeSessionState(sessionId, state);
    note(`plankeeper: plan approved by Codex — ${verdict.detail}`);
    return;
  }

  // REVISE
  state.iterations += 1;
  state.status = "revising";
  state.lastDeniedHash = hash;
  state.lastFeedback = verdict.detail;
  writeSessionState(sessionId, state);
  deny(reviseReason(verdict.detail, state.iterations, state.maxIterations));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`plankeeper: ${message}\n`);
  // Exit 1 is non-blocking for PreToolUse (only exit 2 blocks), so a crashed
  // gate fails open too.
  process.exitCode = 1;
}

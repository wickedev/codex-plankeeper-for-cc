import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

// Depending on the Claude Code version, ExitPlanMode either carries the full
// plan markdown inline (`tool_input.plan`) or carries nothing and the plan
// lives in a file under ~/.claude/plans/ that the session wrote incrementally.
// Both paths are supported; the transcript scan recovers the file path for the
// second case. Matches absolute and ~-prefixed paths as they appear verbatim
// inside transcript JSONL lines (file_path fields, "Plan File Info" reminders).
const PLAN_PATH_RE = /(?:~|\/[^\s"'`\\]*)\/\.claude\/plans\/[A-Za-z0-9._-]+\.md/g;

export function normalizePlan(text) {
  return String(text).replace(/\r\n/g, "\n").trim();
}

export function planHash(text) {
  return crypto.createHash("sha256").update(normalizePlan(text)).digest("hex");
}

function expandHome(p) {
  return p.startsWith("~/") ? `${os.homedir()}${p.slice(1)}` : p;
}

// The most recent plan-file mention wins: a session can touch several plan
// files (an old plan referenced in context, then the real one being written),
// and the one ExitPlanMode is about is always the latest.
export function findPlanPathInTranscript(transcriptPath) {
  if (!transcriptPath) {
    return null;
  }
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  let found = null;
  for (const line of raw.split("\n")) {
    if (!line.includes(".claude/plans/")) {
      continue;
    }
    const matches = line.match(PLAN_PATH_RE);
    if (matches?.length) {
      found = matches[matches.length - 1];
    }
  }
  return found ? expandHome(found) : null;
}

// Resolution chain: inline tool_input.plan → plan file recovered from the
// transcript → null (the caller fails open).
export function resolvePlanText(input) {
  const inline = input?.tool_input?.plan;
  if (typeof inline === "string" && inline.trim()) {
    return inline;
  }

  const planPath = findPlanPathInTranscript(input?.transcript_path);
  if (planPath) {
    try {
      const text = fs.readFileSync(planPath, "utf8");
      if (text.trim()) {
        return text;
      }
    } catch {
      // fall through
    }
  }
  return null;
}

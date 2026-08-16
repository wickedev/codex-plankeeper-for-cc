import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findPlanPathInTranscript, planHash, resolvePlanText } from "../scripts/lib/plan-source.mjs";
import { recentUserRequests } from "../scripts/lib/transcript.mjs";
import { parseVerdict } from "../scripts/lib/verdict.mjs";

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plankeeper-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test("resolvePlanText prefers inline tool_input.plan", () => {
  const plan = "# Plan\n\nDo the thing.";
  assert.equal(resolvePlanText({ tool_input: { plan } }), plan);
});

test("resolvePlanText falls back to the most recent plan file in the transcript", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plankeeper-test-"));
  const plansDir = path.join(dir, ".claude", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const decoy = path.join(plansDir, "old-plan.md");
  const real = path.join(plansDir, "real-plan.md");
  fs.writeFileSync(decoy, "# Old plan");
  fs.writeFileSync(real, "# Real plan");

  const transcript = tmpFile(
    "transcript.jsonl",
    [
      "this line is not json {{{",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: decoy } }] }
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { file_path: real } }] }
      })
    ].join("\n")
  );

  assert.equal(findPlanPathInTranscript(transcript), real);
  assert.equal(
    resolvePlanText({ tool_input: {}, transcript_path: transcript }),
    "# Real plan"
  );
});

test("resolvePlanText expands ~ in plan paths mentioned as text", () => {
  const transcript = tmpFile(
    "transcript.jsonl",
    JSON.stringify({ type: "user", message: { content: "Plan file: ~/.claude/plans/some-plan.md" } })
  );
  // The file does not exist under $HOME, so resolution fails open to null —
  // but the path itself must be expanded, not returned with a literal ~.
  const found = findPlanPathInTranscript(transcript);
  assert.equal(found, path.join(os.homedir(), ".claude", "plans", "some-plan.md"));
});

test("resolvePlanText returns null when nothing is available", () => {
  assert.equal(resolvePlanText({ tool_input: {} }), null);
  assert.equal(resolvePlanText({ tool_input: {}, transcript_path: "/nonexistent/file.jsonl" }), null);
  const empty = tmpFile("transcript.jsonl", JSON.stringify({ type: "user", message: { content: "hi" } }));
  assert.equal(resolvePlanText({ tool_input: {}, transcript_path: empty }), null);
});

test("planHash treats CRLF and LF plans as identical, and differing plans as different", () => {
  assert.equal(planHash("a\r\nb\r\n"), planHash("a\nb\n"));
  assert.equal(planHash("  a\nb  "), planHash("a\nb"));
  assert.notEqual(planHash("a"), planHash("b"));
});

test("parseVerdict matches strict first-line prefixes only", () => {
  assert.deepEqual(parseVerdict("APPROVE: solid plan"), { kind: "APPROVE", detail: "solid plan" });
  const revise = parseVerdict("REVISE: two gaps\n1) missing tests\n2) wrong path");
  assert.equal(revise.kind, "REVISE");
  assert.ok(revise.detail.includes("1) missing tests"));
  assert.ok(revise.detail.includes("2) wrong path"));
  assert.equal(parseVerdict("The plan looks fine, APPROVE: yes"), null);
  assert.equal(parseVerdict("ACHIEVED: wrong contract"), null);
  assert.equal(parseVerdict(""), null);
});

test("recentUserRequests filters noise and keeps the latest real messages", () => {
  const transcript = tmpFile(
    "transcript.jsonl",
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/goal</command-name>" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "meta noise" } }),
      JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sidechain noise" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "not a user turn" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "first real request" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "second real request" }] } })
    ].join("\n")
  );
  assert.deepEqual(recentUserRequests(transcript), ["first real request", "second real request"]);
  assert.deepEqual(recentUserRequests("/nonexistent.jsonl"), []);
});

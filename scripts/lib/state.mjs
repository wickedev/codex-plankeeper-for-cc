import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_ROOT = path.join(os.homedir(), ".claude", "plankeeper");
const SESSIONS_DIR = path.join(STATE_ROOT, "sessions");
const CONFIG_PATH = path.join(STATE_ROOT, "config.json");

// Every iteration is a full plan rewrite, so the cap is much lower than
// goalkeeper's stop-gate cap.
export const DEFAULT_MAX_ITERATIONS = 4;

export function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { enabled: true, maxIterations: DEFAULT_MAX_ITERATIONS, ...config };
  } catch {
    return { enabled: true, maxIterations: DEFAULT_MAX_ITERATIONS };
  }
}

export function writeConfig(config) {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

// Which model judges, and how hard it thinks. Env beats config beats "let the
// codex CLI decide", so a plan can be judged by a different model than the one
// the user happens to have set in ~/.codex/config.toml — and pinning it here
// means changing that file later does not silently change the verdicts.
export function resolveJudge(config = readConfig()) {
  const pick = (envVar, configured) => {
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv) {
      return { value: fromEnv, source: `$${envVar}` };
    }
    if (configured) {
      return { value: configured, source: "config" };
    }
    return { value: null, source: "codex default" };
  };

  return {
    model: pick("PLANKEEPER_CODEX_MODEL", config.model),
    effort: pick("PLANKEEPER_CODEX_EFFORT", config.effort),
    sandbox: pick("PLANKEEPER_CODEX_SANDBOX", config.sandbox)
  };
}

function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId.replace(/[^a-zA-Z0-9-]/g, "_")}.json`);
}

export function readSessionState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionPath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function writeSessionState(sessionId, state) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(sessionPath(sessionId), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function newSessionState() {
  return {
    status: "reviewing", // reviewing | revising | approved | capped | stood-down
    iterations: 0,
    judgeErrors: 0,
    approvedHashes: [],
    lastDeniedHash: null,
    lastFeedback: null,
    history: [{ at: new Date().toISOString(), event: "tracking", detail: "session started" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function pushHistory(state, event, detail) {
  state.history = [...(state.history ?? []), { at: new Date().toISOString(), event, detail }];
  return state;
}

export function latestSessionState() {
  try {
    const files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(SESSIONS_DIR, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? JSON.parse(fs.readFileSync(files[0], "utf8")) : null;
  } catch {
    return null;
  }
}

import fs from "node:fs";

// Slash-command echoes, hook noise, and interrupt markers all arrive as user
// entries; none of them are the user's actual request.
const NOISE_PREFIXES = [
  "<command-name>",
  "<local-command",
  "<system-reminder",
  "<task-notification",
  "[Request interrupted",
  "Caveat:"
];

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

// Returns the last few real user messages from the session transcript, oldest
// first, so the judge can review the plan against what the user actually asked
// for. Best-effort: any failure returns [] and the judge reviews the plan on
// its own merits.
export function recentUserRequests(transcriptPath, { limit = 3, maxChars = 4000 } = {}) {
  if (!transcriptPath) {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const requests = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"user"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) {
      continue;
    }
    const text = textOf(entry.message?.content).trim();
    if (!text || NOISE_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      continue;
    }
    requests.push(text);
  }

  const recent = requests.slice(-limit);
  const perMessage = Math.max(200, Math.floor(maxChars / Math.max(1, recent.length)));
  return recent.map((text) =>
    text.length > perMessage ? `${text.slice(0, perMessage)}\n[…truncated]` : text
  );
}

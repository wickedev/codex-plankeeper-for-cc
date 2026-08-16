# codex-plankeeper-for-cc

A Claude Code plugin that puts an **independent Codex review between plan mode and you**.
Every plan Claude tries to present is first reviewed by the Codex CLI against the **actual
codebase** — not the conversation. A deficient plan is sent back with concrete fixes and Claude
revises it automatically; by the time you see the approval dialog, the plan has already passed
an independent review.

Sibling of [codex-goalkeeper-for-cc](https://github.com/wickedev/codex-goalkeeper-for-cc),
which gates *goal completion* at stop time. Plankeeper gates *plan quality* at submission time.

## Why

A plan is judged by the same model that wrote it — until now. Claude's plans routinely name
files, functions, and assumptions it has not re-verified, and the first person to notice is
you, mid-review, or worse: the implementation. Plankeeper hands the plan to a different
vendor's model with read-only access to the real repository. It checks the load-bearing claims
itself (does that function exist? is that assumption true? is anything the user asked for
silently missing?) and refuses to let a plan reach you until the material defects are fixed.

The review/fix loop is fully automatic. You are never asked to approve a plan that has not
been reviewed, and a broken reviewer can never hide a plan from you (see failure policy).

## How it works

```
Claude (plan mode) ── calls ExitPlanMode
        │
        ▼  PreToolUse hook ("Codex is reviewing the plan…")
   plan-gate-hook.mjs
        ├─ disabled / no plan text / codex missing / cap hit → let through (fail-open)
        ├─ identical plan already approved this session      → let through instantly
        ├─ identical plan already rejected this session      → re-deny with cached feedback (free)
        └─ codex exec, read-only sandbox, project cwd
              ├─ APPROVE: … → let through → the user sees the approval dialog
              └─ REVISE: 1) … 2) … → deny; the feedback becomes Claude's instruction
                                      → Claude revises the plan → ExitPlanMode again → loop
```

Key mechanics:

- **Deny feeds Claude, not you.** A PreToolUse deny reason is delivered to Claude as feedback,
  so the revise-retry loop needs no extra hooks and never interrupts you.
- **Allowing means staying silent.** The hook never emits an "allow" decision — that would
  auto-approve the plan and skip your dialog. It just steps aside and the normal approval flow
  proceeds.
- **Plan discovery is version-tolerant.** Depending on the Claude Code version, ExitPlanMode
  carries the plan inline (`tool_input.plan`) or the plan lives in a file under
  `~/.claude/plans/` that the session wrote incrementally. The hook tries the inline field
  first, then recovers the most recent plan-file path from the session transcript.
- **Hash caches keep it cheap.** An approved plan is remembered by content hash and re-passes
  instantly (e.g. after "No, keep planning" with no changes). A rejected plan resubmitted
  byte-identical is re-denied from cache without a judge run.
- **Anti-perfectionism is in the judge's contract.** APPROVE is the default verdict; REVISE is
  reserved for concrete, material defects, and on later iterations the judge is told to check
  that its previous feedback was addressed rather than move the goalposts. Every REVISE costs
  a full plan rewrite, and the prompt says so.

## Install

```
/plugin marketplace add wickedev/codex-plankeeper-for-cc
/plugin install plankeeper@codex-plankeeper-for-cc
```

Requirements:

- Claude Code with plan mode and PreToolUse hooks (verified against v2.x, Aug 2026)
- Node.js (any recent version; the plugin has zero dependencies)
- [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex --version`
  must work)

## Commands

| Command | What it does |
| --- | --- |
| `/plankeeper:status` | Gate state, judge settings and their sources, latest verdict |
| `/plankeeper:on` / `/plankeeper:off` | Enable / disable the gate |
| `/plankeeper:model [slug\|default]` | Pin the judge model, or inherit `~/.codex/config.toml` |
| `/plankeeper:effort [level\|default]` | Pin the judge reasoning effort (`none`…`ultra`) |

## Configuration

`~/.claude/plankeeper/config.json` (all keys optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the gate |
| `maxIterations` | `4` | Review rounds per session before the plan goes through as-is |
| `model` | unset | Judge model; unset inherits `~/.codex/config.toml` |
| `effort` | unset | Judge reasoning effort; unset inherits the model default |
| `sandbox` | `read-only` | Codex sandbox mode for the judge run |

Environment overrides (beat the config file): `PLANKEEPER_CODEX_MODEL`,
`PLANKEEPER_CODEX_EFFORT`, `PLANKEEPER_CODEX_SANDBOX`. Set `PLANKEEPER_DEBUG_INPUT=<file>` to
capture raw hook payloads — the field set is internal to Claude Code, and this is how you
re-validate the plan-discovery chain after an upgrade.

Per-session state lives in `~/.claude/plankeeper/sessions/<session_id>.json`.

## Failure policy

**Fail-open, everywhere.** Missing codex CLI, judge error or timeout, an unparseable verdict,
an unlocatable plan text, the iteration cap, three consecutive judge failures (the gate then
stands down for the session) — every failure path lets the plan through to your approval
dialog with a note on stderr. The one thing a broken judge can never do is prevent you from
seeing a plan.

## Caveats

- Each review is a real Codex run: ExitPlanMode is held open for the duration (roughly
  30–120 s at `medium` effort). The hash caches ensure you never pay twice for the same plan.
- The plan-file fallback reads the session transcript, whose format is internal to Claude
  Code. If an upgrade breaks it, the gate degrades to fail-open (plans go through unreviewed)
  — use `PLANKEEPER_DEBUG_INPUT` to re-check what the new version sends.
- Coexists cleanly with goalkeeper: different hook events (PreToolUse vs Stop /
  UserPromptSubmit), different state roots (`~/.claude/plankeeper` vs `~/.claude/goalkeeper`),
  no shared files. There is deliberately no UserPromptSubmit hook here — PreToolUse fires on
  every ExitPlanMode attempt, so nothing needs re-arming.

## Development

```
node --test          # unit tests: plan discovery, hashing, verdict parsing, transcript filtering
```

---
description: Show the plankeeper gate state and the latest Codex plan verdict
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-ctl.mjs" status
```

Relay the output to the user. Add context for two statuses: `capped` means the review loop hit
its iteration limit and the plan was shown to the user without Codex approval; `stood-down`
means the judge failed repeatedly (auth, usage limit, timeouts) and the gate stopped reviewing
for that session. Both reset with a new session, and `/plankeeper:on` re-enables a disabled gate.

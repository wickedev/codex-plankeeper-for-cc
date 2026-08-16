---
description: Enable the Codex plan review gate for plan mode
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-ctl.mjs" on
```

Confirm to the user: from now on, every plan presented from plan mode is independently reviewed
by Codex against the actual codebase, and only an approved (or capped-out) plan reaches the
approval dialog.

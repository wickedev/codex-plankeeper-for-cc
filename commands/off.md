---
description: Disable the Codex plan review gate for plan mode
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-ctl.mjs" off
```

Confirm to the user: the Codex plan review layer is off. Plans go straight to the approval
dialog as they normally would.

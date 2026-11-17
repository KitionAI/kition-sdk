---
name: drafts-list
description: "List the kit drafts in this project: files an agent edited as drafts (draft: true), with each draft's state (ready or open) and whether the file changed since the draft began (stale). Use when the user asks which drafts there are or what an agent left for review."
---

List the drafts with the Bash tool:

```sh
KITION_KITS_MCP="${user_config.kits_mcp}" KITION_KITS_DIR="${user_config.kits_dir}" KITION_KIT_REPOS="${user_config.kit_repos}" "${CLAUDE_PLUGIN_ROOT}/scripts/kits-mcp.sh" drafts list --workspace "${CLAUDE_PROJECT_DIR}"
```

It prints JSON. Show the person each draft's file, `state` and `stale`, and say that they review a
draft with `/kition-kits:drafts-compare <file>`, then keep it with `/kition-kits:drafts-merge <file>`
or drop it with `/kition-kits:drafts-discard <file>`. Merging and discarding are the person's
decisions (KHP A14): never run them yourself.

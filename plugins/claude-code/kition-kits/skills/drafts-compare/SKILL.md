---
name: drafts-compare
description: "Show what merging a kit draft would change in its file, with previews of both sides. Use when the user wants to review a draft before deciding to merge or discard it."
argument-hint: "<file> [--previews]"
---

Compare the draft of the file the person named (`$ARGUMENTS`) with the file, with the Bash tool.
Quote the path:

```sh
KITION_KITS_MCP="${user_config.kits_mcp}" KITION_KITS_DIR="${user_config.kits_dir}" KITION_KIT_REPOS="${user_config.kit_repos}" "${CLAUDE_PLUGIN_ROOT}/scripts/kits-mcp.sh" drafts compare <file> --previews --workspace "${CLAUDE_PROJECT_DIR}"
```

It prints JSON: what the merge would change and, with `--previews`, a rendering of each side. Tell the
person what changes, and that they keep it with `/kition-kits:drafts-merge <file>` or drop it with
`/kition-kits:drafts-discard <file>`. Don't merge or discard it yourself (KHP A14).

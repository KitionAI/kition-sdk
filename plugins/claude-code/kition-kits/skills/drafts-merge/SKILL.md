---
name: drafts-merge
description: "Merge a kit draft into its file: the person keeps what the agent drafted."
argument-hint: "<file> [--overwrite]"
disable-model-invocation: true
---

The person asked to merge the draft of `$ARGUMENTS`. Run, with the Bash tool and the path quoted:

```sh
KITION_KITS_MCP="${user_config.kits_mcp}" KITION_KITS_DIR="${user_config.kits_dir}" KITION_KIT_REPOS="${user_config.kit_repos}" "${CLAUDE_PLUGIN_ROOT}/scripts/kits-mcp.sh" drafts merge <file> --workspace "${CLAUDE_PROJECT_DIR}"
```

If it answers `stale`, the file changed since the draft began: tell the person, and only add
`--overwrite` when they asked for it in `$ARGUMENTS` or say so now. Report the result as it is.

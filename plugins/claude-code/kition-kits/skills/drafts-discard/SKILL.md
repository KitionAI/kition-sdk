---
name: drafts-discard
description: "Discard a kit draft: drop what the agent drafted and leave the file as it is."
argument-hint: "<file>"
disable-model-invocation: true
---

The person asked to discard the draft of `$ARGUMENTS`. Run, with the Bash tool and the path quoted:

```sh
KITION_KITS_MCP="${user_config.kits_mcp}" KITION_KITS_DIR="${user_config.kits_dir}" KITION_KIT_REPOS="${user_config.kit_repos}" "${CLAUDE_PLUGIN_ROOT}/scripts/kits-mcp.sh" drafts discard <file> --workspace "${CLAUDE_PROJECT_DIR}"
```

Report the result as it is. The file itself is not changed.

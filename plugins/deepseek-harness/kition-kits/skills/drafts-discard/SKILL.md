---
name: drafts-discard
description: "Discard a kit draft: drop what the agent drafted and leave the file as it is."
disable-model-invocation: true
---

The person asked to discard the draft of the file they named after `/drafts-discard` in their
message. Run, with the bash tool, the launcher `../../bin/kits-mcp.mjs` relative to this skill's
base directory (give its full path) and the file's path quoted:

```sh
node <base directory>/../../bin/kits-mcp.mjs drafts discard <file> --workspace "${KITION_WORKSPACE:-$PWD}"
```

Report the result as it is. The file itself is not changed.

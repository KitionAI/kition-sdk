---
name: drafts-merge
description: "Merge a kit draft into its file: the person keeps what the agent drafted."
disable-model-invocation: true
---

The person asked to merge the draft of the file they named after `/drafts-merge` in their message.
Run, with the bash tool, the launcher `../../bin/kits-mcp.mjs` relative to this skill's base
directory (give its full path) and the file's path quoted:

```sh
node <base directory>/../../bin/kits-mcp.mjs drafts merge <file> --workspace "$PWD"
```

If it answers `stale`, the file changed since the draft began: tell the person, and only add
`--overwrite` when they wrote it after `/drafts-merge` or say so now. Report the result as it is.

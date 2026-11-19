---
name: drafts-compare
description: "Show what merging a kit draft would change in its file, with previews of both sides. Use when the user wants to review a draft before deciding to merge or discard it."
---

Compare the draft of the file the person named (after `/drafts-compare` in their message, or the
file they asked about) with the file, with the bash tool. The launcher is `../../bin/kits-mcp.mjs`,
relative to this skill's base directory; give its full path, and quote the file's:

```sh
node <base directory>/../../bin/kits-mcp.mjs drafts compare <file> --previews --workspace "${KITION_WORKSPACE:-$PWD}"
```

It prints JSON: what the merge would change and, with `--previews`, a rendering of each side. Tell the
person what changes, and that they keep it with `/drafts-merge <file>` or drop it with
`/drafts-discard <file>`. Don't merge or discard it yourself (KHP A14).

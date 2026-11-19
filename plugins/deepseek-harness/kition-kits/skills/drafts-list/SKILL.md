---
name: drafts-list
description: "List the kit drafts in this project: files an agent edited as drafts (draft: true), with each draft's state (ready or open) and whether the file changed since the draft began (stale). Use when the user asks which drafts there are or what an agent left for review."
---

List the drafts with the bash tool. The launcher is `../../bin/kits-mcp.mjs`, relative to this
skill's base directory; give its full path:

```sh
node <base directory>/../../bin/kits-mcp.mjs drafts list --workspace "${KITION_WORKSPACE:-$PWD}"
```

It prints JSON. Show the person each draft's file, `state` and `stale`, and say that they review a
draft with `/drafts-compare <file>`, then keep it with `/drafts-merge <file>` or drop it with
`/drafts-discard <file>`. Merging and discarding are the person's decisions (KHP A14): never run
them yourself.

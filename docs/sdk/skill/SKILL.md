---
name: kition-kits
description: Create, edit and check files with Kition's kit tools over MCP (kition-kits-mcp). Markdown notes (md) with the published Note kit, and the file types of any other Kition kit the server has installed. Use when a task asks to create, change, or verify such a file in the workspace and the server's `kit_*` or `<prefix>_*` tools are available.
---

# Kition kits

Kition's kits MCP server (`kition-kits-mcp --workspace <folder>`, or `npx -y @kition/kits-mcp
--workspace <folder>` once that package is on npm) edits files in the workspace folder that you
should not write as plain text. Each installed kit's tools start with its prefix. Only the Note
kit is published so far: `note` (md, markdown). The prefixes of Kition's other kits, which are
not published yet, are `doc` (docx), `sheet` (xlsx), `slide` (pptx), `pdf`, `photo` (psd),
`vector` (svg), `film`, `motion`, `table`, `board`, `cad` (dxf), `layout` (idml), `design`,
`html` and `scene`. With `--unified` (the Claude Code plugin's default) one set serves every
kit, chosen by the file's extension: read `kit` for `<prefix>` below (`kit_inspect`, `kit_run`,
...).

1. **Look first.** `<prefix>_inspect { path }` shows the document (and a preview). Read before
   you edit.
2. **Find commands.** `<prefix>_commands { path, query }` searches by keywords; use the ids and
   parameter notes it returns, never guessed ones.
3. **Edit.** `<prefix>_run { path, steps: [{ command, params }] }` runs steps in order and saves.
   For many small changes to objects, `<prefix>_query` then `<prefix>_batch`. A new file:
   `<prefix>_create { path }`. Another format: `<prefix>_export { path, to }`.
4. **Check.** `<prefix>_check { path }` after every edit. Fix each `error`, then `warning`
   diagnostic and check again; match on `code`, not on the message.
5. **On failure** read `error.code` and `error.index`: `not-found` (wrong id or path),
   `read-only`, `unknown-command` (search again), `invalid-params`, `conflict` (others changed
   what you act on: read again with the `revision` it gives).

Paths are relative to the workspace folder; paths outside it are refused. With `draft: true` (or
a server started with `--drafts`) your edits go to a draft: finish with `<prefix>_draft_ready`;
only the person merges or discards it. When Kition serves the tools (`POST /v1/mcp/kits`), a
file open in a person's kit editor is edited live; never write these files any other way.

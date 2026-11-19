---
name: note-editing
description: "Create, inspect, edit and check a note (Markdown (.md)) with the Kition Note kit's tools: text, headings, lists, tasks, tables, properties, links, comments, templates, and more; `text.insert` adds text. Use when the user asks to make, read, change, review or fix Markdown (.md) files in this project."
---

<!-- Generated from kition-note agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`note_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`note_run` is `mcp__kition__kit_run`, `note_check` is `mcp__kition__kit_check`).
They load on demand: before the first call, add the ones you need with
`mcp__kition__load_tools`, for example `{"tools": ["kit_inspect", "kit_commands", "kit_run", "kit_check"]}`.
With KITION_KITS_UNIFIED=false they are `mcp__kition__note_<action>`. Paths are relative to the
workspace folder.

# Note kit

The Note kit opens, edits and checks Markdown notes (`.md`): headings, lists, tasks, tables,
callouts, front-matter properties, links, embeds and comment threads. The file is plain Markdown:
what you edit is its text, and every command keeps the rest of the file byte for byte. An agent can
insert, find and replace text, edit sections, tasks, tables and properties, and check the note for
broken links and anchors, unclosed fences, bad front matter, skipped heading levels and tables with
uneven columns.

## Tools

The kit's prefix is `note`. Its tools are:

| Tool | Does |
|---|---|
| `note_inspect` | The note as JSON (outline of heading lines, properties, tables, tasks, links, comment threads and word count), with a preview |
| `note_query` | Reads objects of the object model by id, or by following fields from the root: sections (with their subsections, tasks, tables and links), tasks, tables, links, properties and comment threads |
| `note_commands` | Finds commands by keywords (`task`, `table cell`, `section`, `property`, `text`), each with its parameter schema. At most 12 answers; use more specific words when it says "showing 12" |
| `note_run` | Runs 1 to 50 command steps `{command, params}` in order; it stops at the first failure and saves after the last step |
| `note_batch` | Runs one batch of object-model operations: a task's `checked`, a section's `level` or its deletion (run as `task.toggle`, `heading.setLevel`, `section.delete`) |
| `note_check` | What is wrong with the note, as diagnostics |
| `note_create` | Makes a new, empty `.md` note |
| `note_export` | Writes the note to a new HTML or PDF file |
| `note_draft_ready`, `note_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the note's path in the workspace. With `draft: true` your edits go to your
draft of the note and leave the file as it is; only the person merges or discards a draft. Without
it, edits are live. `note_export {path, to, format}` writes the note to a new file and leaves it as
it is: `html` (a standalone page of the reading view, with its stylesheet) or `pdf` (Letter pages
with one-inch margins); it never replaces a file.

## Addressing and coordinates

- **Lines count from 1.** [`task.toggle`](/kits/note/commands/task.toggle/) `{line}`,
  [`heading.setLevel`](/kits/note/commands/heading.setLevel/) `{line}` and the outline in
  `note_inspect` all use the line as the file shows it.
- **Text positions count from 0**, in Unicode scalar values by default (`unit: "scalar"`; `utf16`
  counts UTF-16 code units, as the editor does). Get them from
  [`text.find`](/kits/note/commands/text.find/) `{find}`, which answers `from`, `to` and `line` for
  each match; do not count characters yourself.
- **Headings are paths** of their plain text from the top: `["Launch plan", "Tasks"]` is the
  `## Tasks` under `# Launch plan`. Use the path, or `line`, in `section.*`,
  [`block.append`](/kits/note/commands/block.append/),
  [`tasks.list`](/kits/note/commands/tasks.list/) and
  [`table.create`](/kits/note/commands/table.create/).
- **Tables count from 0** in the note, in document order (`table: 0` is the first). Inside a table,
  `row` and `column` count from 0 and **row 0 is the header**, so the first body row is `row: 1`.
  [`table.read`](/kits/note/commands/table.read/) answers the header and the body rows separately;
  [`table.insertRow`](/kits/note/commands/table.insertRow/) `{at}` uses the same numbering.
- **Properties** are front-matter keys: [`property.set`](/kits/note/commands/property.set/)
  `{key, value}`, where a list is an array of strings.
- **Ids** name the note's sections, tasks, tables, properties and links while the server holds it
  open: [`projection.read`](/kits/note/commands/projection.read/) lists them (`section:3`,
  `task:2`, `table:1`, `property:1`, `link:4`). `section.*`, `heading.setLevel`, `block.append`
  and `tasks.list` take a section's id as `section` (`section.move` also `toSection`),
  `task.toggle` a task's as `task`, instead of a heading path or line. They are objects of the
  object model too (`Section`, `Task`, `Table`, `Link`, `Property`), computed from the text and
  never stored: `note_query` reads them, and receipts and `others` name what changed by them (a
  section's own text, up to its first subsection, is its `body`).

### What an id promises

An id is the server's name for one object, never text of the file:

- Opening the note gives ids in document order (`section:1` is the first heading).
- Every change the server sees is followed: an object keeps its id while the place it starts at
  survives the change (a section renamed, edited, or with lines added above it), or when its text,
  or else its name, is found again alone elsewhere (a section moved). A new object gets a number
  never used before; an object not found again is gone, and its id names nothing (`not-found`).
- When another program changes the file, the server reads it again and finds each object again
  the same way; an object it can tell from look-alikes only by a guess (two sections with the same
  heading path, one deleted; one found only where it started, with another name and other text)
  is *unproven*, and a write naming it with an earlier `basis` is refused `unknown`.
- Ids are not saved: after the note is closed or the server restarts, they are given again in
  document order. Read them again with `projection.read` after such a gap.

## Writes with `basis`: what each one rests on

Pass the `revision` of your last answer as `basis` on every `note_run`. Another writer (the person,
another agent, a program saving the file) may change the note in between; the server then checks
your write against what it rests on, and refuses it with `conflicts` (`relocated`, `changed`,
`deleted`, `unknown`) instead of writing over their change. A refused write changed nothing:
`note_inspect` (or read what `others` says), then decide again with the new `revision`.

The note's object model is the root `note`, whose `body` is the whole file, the comment threads,
and the projection's objects computed from the body. Headings, list items, tasks, tables,
properties and links are text in the body: a write names its place in the text (by position,
line, number, occurrence, name, or an id of the projection above), and that place is what it
rests on. A run's later step is checked on the note as the run's earlier steps leave it.

| A write names its place by | Examples | Refused when another writer | Applies when they |
|---|---|---|---|
| position | `text.insert {at}`, `text.replace {from, to}`, `link.insert {at}`, `comment.add {from, to}` | inserted or deleted text before it (`relocated`), or edited the range itself (`changed`) | changed only text after it, or text before it without changing its length: a position holds the characters at it, not the section around them |
| line | `task.toggle {line}`, `heading.setLevel {line}`, `section.* {line}`, `link.update {line, index}` | added or removed lines above it (`relocated`), or edited that line (`changed`) | changed text below it (a line added right below it too), or above it without a line break |
| id | `section.* {section}`, `section.move {toSection}`, `heading.setLevel {section}`, `task.toggle {task}` | edited what it replaces (`changed`; a task's whole line, a heading's level marker), deleted it (`deleted`), or made it unproven (`unknown`) | renamed or moved it (a section's heading line is its name), or changed anything else |
| table number | `table.* {table}` | inserted or removed a table before it (`relocated`), or edited that table (`changed`; `table.deleteRow` and `table.moveRow` only the rows they delete or move, `table.align` only the column's alignment) | changed other tables or text |
| occurrence | `text.findReplace {find, occurrence}`, `comment.add {quote, occurrence}`, `property.delete {occurrence}` | added or removed a match before it (`relocated`), or edited the match (`changed`) | changed text elsewhere |
| name | `section.* {heading}`, `block.replace {blockId}`, `task.toggle {blockId}`, `property.* {key}` | renamed it away, gave the name to other text, or deleted it (`relocated`), or edited what the write replaces (`changed`) | moved it (the name finds the same text), or changed anything else |
| nothing (the note's end) | `block.append`, `table.create` without `heading` or `line` | wrote at the end too (`changed`) | changed text before the end |
| the whole note | `note.write`, `file.setLineEndings` | changed anything in the note | changed only comments |
| a comment thread's id | `comment.reply {thread}`, `comment.resolve {thread}` | deleted the thread (`deleted`); `comment.resolve` also when they resolved or reopened it (`changed`) | changed the note's text |
| an object of the object model | `note_batch` `set` of a task's `checked` or a section's `level`, `delete` of a section | changed that field, or what the command it runs as rests on (as above) | changed anything else |
| the step it takes back | `edit.undo`, `edit.redo` | changed what that step wrote: the note's text anywhere, or a comment thread's field it wrote (`changed`) | changed nothing the step wrote |

A write that names a section (by heading path, line or id: `section.*`, `block.append`,
`table.create` with `heading`) also rests on where it lands among the headings: the level of the
heading that ends the section, and of the headings between its heading and where it writes. When
another writer demotes the heading that ended it (the section now takes in the next one), promotes
one inside it, or adds a subsection where the write lands, it is refused `changed`; a heading
renamed, or text edited inside the section, does not move it.

`section.move` by heading paths or ids applies after an edit inside the moved section: the section
moves with that edit. Prefer ids and names (heading paths, block ids, keys) over lines and
positions when others may be editing: they follow their text when lines move, and an id follows a
renamed section too.

Limits of these checks:

- Comment threads are not in the `.md`. When a program saves the file while you work, the server
  reads it again and keeps the threads, each found again by the text it quotes; a thread whose text
  is gone stays (`comment.threads` says `gone`), and `others` says so on the note's change
  (`comment thread … orphaned`). When the server has restarted, the threads are gone: a write
  naming one is refused `unknown`.
- A write by no place (`block.append`, `table.create` at the note's end) after others changed the
  note is compared on the note's text at your `basis`.
- `edit.undo` and `edit.redo` hold the note's text whole: while the person edits the open note,
  any change of the text refuses your undo. Headless, another agent's step refuses your undo. A
  file changed by another program is read again into the same session: your steps stay, and after
  you observe again `edit.undo` takes back only your own steps and keeps the program's change.
- Every write that changes the body holds the note's line-ending style, even one that inserts no
  line break.
- While the person has the note open in the editor, the server does not ask the note what a write
  rests on: a write by place is checked there only against others' deletions and moves of stored
  objects, not against their changes of the text. Pass `expected` where a command takes it.
- A line over 64K characters, or a note rewritten almost whole, is compared line by line: an
  edit anywhere in such a line counts as touching a write in it.
- `others` and receipts tell a change of the note as a change of the root's `body` (an
  80-character excerpt and the length) and of the projection's objects it changed, by their ids
  (`section:6` `body`, `task:1` `checked`; created and deleted ones too).
  [`text.read`](/kits/note/commands/text.read/) to see the text.
- Through the object model only a task's box, a heading's level and a section's deletion are
  writable; tables, links and properties are read-only there, and `note_batch` refuses a raw write
  of the body: use the commands. A raw write of a comment thread's or comment's fields applies and
  rests on the field it writes; a reply to a thread deleted since your `basis` is refused
  `deleted`.

## Workflow

1. `note_inspect` to see the structure.
2. `note_commands` with a few keywords to find the command and its parameters. Use the exact id it
   returns and follow its parameter schema; never guess a command id. An unknown id fails with the
   nearest commands listed.
3. `note_run` a few steps. Pass `expected` to [`table.setCell`](/kits/note/commands/table.setCell/),
   [`text.replace`](/kits/note/commands/text.replace/) or
   [`text.delete`](/kits/note/commands/text.delete/) when you know the current text, so a stale
   position fails instead of changing the wrong text.
4. `note_check`, then fix what it reports. A diagnostic with `fix` names the command and params
   that repair it.
5. `note_inspect` again to confirm the result.

## Example 1: add a task and check one off

The note has `## Tasks` with `- [x] Draft the announcement` and `- [ ] Book the review meeting`.

```json
note_run {"path": "plan.md", "steps": [
  {"command": "text.find", "params": {"find": "- [ ] Book the review meeting"}}
]}
```

It answers `{"count": 1, "matches": [{"from": 292, "line": 20, "to": 321, ...}]}`. Insert after the
item, then check off line 20:

```json
note_run {"path": "plan.md", "steps": [
  {"command": "text.insert", "params": {"at": 321, "text": "\n- [ ] Send the invite to the ten teams"}},
  {"command": "task.toggle", "params": {"line": 20, "done": true}}
]}
note_check {"path": "plan.md"}
```

The list now reads `- [x] Draft the announcement`, `- [x] Book the review meeting`,
`- [ ] Send the invite to the ten teams`, and the check finds nothing wrong.

## Example 2: change a table and a property

```json
note_run {"path": "plan.md", "steps": [
  {"command": "table.read", "params": {"table": 0}}
]}
```

It answers `{"header": ["Week", "Milestone"], "rows": [["1", "Beta build"], ["2", "Feedback round"]], ...}`.
The body rows are table rows 1 and 2 (row 0 is the header):

```json
note_run {"path": "plan.md", "steps": [
  {"command": "table.insertRow", "params": {"table": 0, "at": 3, "cells": ["3", "General availability"]}},
  {"command": "table.setCell", "params": {"table": 0, "row": 2, "column": 1, "text": "Feedback round (two weeks)", "expected": "Feedback round"}},
  {"command": "property.set", "params": {"key": "status", "value": "review"}}
]}
note_check {"path": "plan.md"}
```

The table gains `| 3 | General availability |`, the second row reads `Feedback round (two weeks)`,
the front matter says `status: review`, and the check finds nothing wrong.

## Pitfalls

- **Lines move** when you insert text above them: read them again
  ([`tasks.list`](/kits/note/commands/tasks.list/), [`text.find`](/kits/note/commands/text.find/))
  after an edit instead of adding up.
- **Extending a list:** [`section.insert`](/kits/note/commands/section.insert/)
  `{position: "end"}` adds a new block, separated by a blank line, so a list item added that way
  starts a new list. To extend a list, [`text.find`](/kits/note/commands/text.find/) its last item
  and [`text.insert`](/kits/note/commands/text.insert/) at its `to` with `"\n- item"`.
- **Front matter:** [`text.insert`](/kits/note/commands/text.insert/) at 0 puts text above the front
  matter, which then stops being front matter. Insert after the properties block (find the first
  heading or paragraph).
- **Selection commands:** editor commands that act on a selection
  ([`format.bold`](/kits/note/commands/format.bold/), [`list.task`](/kits/note/commands/list.task/),
  [`edit.indent`](/kits/note/commands/edit.indent/), …) are not offered to agents; use the text, section, table and property commands.
- **A failed step** names its index and the reason, for example
  `out-of-range: the note has 34 lines`. The kit undoes the steps before it, so the note is as it
  was before the call and nothing is saved: fix the failing step and send the whole run again.

## Checks

`note_check` lists what is wrong with the note. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/note/checks/).

The check reports broken links, embeds and anchors, unclosed code fences, front matter that does
not parse or repeats a key, skipped heading levels, and tables whose rows have more or fewer cells
than the header.

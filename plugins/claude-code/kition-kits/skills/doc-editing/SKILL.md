---
name: doc-editing
description: "Create, inspect, edit and check a doc (.docx) with the Kition Doc kit's tools: typing, styles, fonts, paragraphs, lists, tables, pictures, headers and footers, references, review, and more. Use when the user asks to make, read, change, review or fix .docx files in this project."
---

<!-- Generated from kition-doc agent/guide.md by kition-sdk tools/claude-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
`doc_<action>` tools this guide names are `kit_<action>`, routed by the file's extension
(`doc_run` is `kit_run`, `doc_check` is `kit_check`). With "unified" off they are named as
written. Paths are relative to the project folder.

# Doc kit

The Doc kit opens, edits and checks Word documents (`.docx`) with Word's commands. An agent can type
and select text, apply styles, fonts and paragraph formatting, make lists and tables, insert
pictures, edit headers and footers, references and tracked changes, check the document for broken
links and references, and export it to PDF or PNG.

## Tools

The kit's prefix is `doc`. Its tools are:

| Tool | Does |
|---|---|
| `doc_inspect` | The document as JSON (its blocks, their indexes and texts, the page and the word count), with a preview |
| `doc_query` | Reads objects of the document's object model by id, or by following fields from the root |
| `doc_commands` | Finds commands by keywords, each with its parameter schema |
| `doc_run` | Runs a list of command steps |
| `doc_batch` | Runs one batch of object-model operations |
| `doc_check` | What is wrong with the document, as diagnostics |
| `doc_create` | Makes a new `.docx` document |
| `doc_export` | Writes the document to a new PDF or PNG file |
| `doc_draft_ready`, `doc_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the document's path in the workspace. With `draft: true` your edits go to
your draft of the document and leave the file as it is; only the person merges or discards a draft.

## Addressing and coordinates

- The **body** is a list of **blocks**: paragraphs and tables. `doc_inspect` lists them as
  `content.paragraphs`, each with its `index` (counted from **0**), `style` (`Heading1`, `Normal`,
  …), `type` (`paragraph` or `table`) and `text`. A table shows as one block with empty `text`;
  read its cells with `doc_query`.
- Most editing commands act on the **selection**. Set it with
  [`select.range`](/kits/doc/commands/select.range/):

  ```json
  { "command": "select.range", "params": { "anchor": { "block": 1, "off": 0 }, "focus": { "block": 1, "off": 5 } } }
  ```

- `block` is the index of a body paragraph, counted from 0, as `doc_inspect` lists it.
- `off` is a **byte offset** into the paragraph's text (UTF-8), counted from 0. The end of a
  paragraph is its text's byte length. A caret is a selection whose `anchor` equals its `focus`.
- Inside a table, or in another story, give the full path:
  `{ "story": "body", "path": [table, row, cell, paragraph], "off": n }`, every position counted
  from 0. `{ "path": [...] }` without `story` is refused.
- Every paragraph has a stable **id** (`p` and eight hex digits, its `w14:paraId`), kept in the
  file: `doc_inspect` lists it as `blocks[].id`, `doc_query` (`follow: "body"`) and every receipt
  name the paragraph by it. A table is `t` and its first row's id, a row `r` and its own, a
  drawing object (shape, text box, group, chart) and a picture its number (the file's
  `wp:docPr/@id`), as `drawing.*` take a drawing object's; an equation its number from 1000001
  (its place among the document's equations); a comment `comment:` and its durable id (kept in
  the file), a thread `thread:` and its first comment's (`comment.threads` lists them as
  `toolId`; the comment commands take them, or `c<n>`); a header, footer, note or text box
  `part:` and what a save keeps of it (`part:header-1-default`: section 1's default header;
  `part:footnote-2`; `part:textbox-7`, the text box of shape 7). A position may name its
  paragraph by id instead of index: `{ "para": "p1A2B3C4D", "off": 5 }`. A step's `on` takes
  paragraph ids (it selects them whole) or the numbers of drawing objects, pictures and
  equations.
- A paragraph's text is split into **runs** with the same formatting. You never address runs:
  select text, then run a formatting command, and the kit splits runs for you.
- Headers, footers, footnotes and endnotes are separate **stories** (`parts` in `doc_query`).
- Page size and margins are in **points** (`lastSection` in `doc_query`).
- Every `doc_run` step answers the selection it left (`result.anchor`, `result.focus`), so you can
  check where the next step will act.
- Diagnostics' `target` has the page (counted from 1) and a `path`, such as `body:3/0/0/0`.

## Workflow

1. `doc_inspect` the document: blocks, their indexes and texts, the page, the word count, and a
   preview.
2. Find the command: `doc_commands { "query": "bold" }`. Use two or three specific words
   (`insert table`, `heading style`); a broad query answers the first 12 of many. Use the exact id
   it returns and follow its parameter schema; never guess a command id.
3. Run small batches with `doc_run { "steps": [...] }`: select, then act. A run saves when it
   succeeds.
4. `doc_check`, then fix what it reports.
5. `doc_inspect` again to confirm the text, and look at the preview.

## Common tasks

- `doc_query { "select": "root" }` returns the whole object model: `body` (block ids), `styles`,
  `settings` (theme fonts), `lastSection` (page size and margins in points). It is large; ask for
  the objects you need.
- New paragraph at the caret: [`text.newParagraph`](/kits/doc/commands/text.newParagraph/).
- Text at the caret: [`text.insert`](/kits/doc/commands/text.insert/) `{ "text": "..." }`.
- Bold the selection: [`format.bold`](/kits/doc/commands/format.bold/).
- Table at the caret: [`insert.table`](/kits/doc/commands/insert.table/) `{ "rows": 2, "cols": 2 }`.

## Example 1: bold a word and add a sentence

The document has `Quarterly report` (block 0, Heading1), `Sales rose in every region.` (block 1)
and `The team thanks everyone involved.` (block 2).

```json
doc_run {
  "path": "report.docx",
  "steps": [
    { "command": "select.range", "params": { "anchor": { "block": 1, "off": 0 }, "focus": { "block": 1, "off": 5 } } },
    { "command": "format.bold", "params": {} },
    { "command": "select.range", "params": { "anchor": { "block": 2, "off": 34 }, "focus": { "block": 2, "off": 34 } } },
    { "command": "text.insert", "params": { "text": " Next quarter's targets follow." } }
  ]
}
```

It answers `Ran 4 commands on report.docx (saved)`. `doc_inspect` then shows block 2 as
`The team thanks everyone involved. Next quarter's targets follow.` and `doc_check` answers
`the kit found nothing wrong`.

## Example 2: a table after a paragraph, with a header row

```json
doc_run {
  "path": "report.docx",
  "steps": [
    { "command": "select.range", "params": { "anchor": { "block": 2, "off": 34 }, "focus": { "block": 2, "off": 34 } } },
    { "command": "text.newParagraph", "params": {} },
    { "command": "insert.table", "params": { "rows": 2, "cols": 2 } },
    { "command": "select.range", "params": { "anchor": { "story": "body", "path": [3, 0, 0, 0], "off": 0 }, "focus": { "story": "body", "path": [3, 0, 0, 0], "off": 0 } } },
    { "command": "text.insert", "params": { "text": "Region" } },
    { "command": "select.range", "params": { "anchor": { "story": "body", "path": [3, 0, 1, 0], "off": 0 }, "focus": { "story": "body", "path": [3, 0, 1, 0], "off": 0 } } },
    { "command": "text.insert", "params": { "text": "Sales" } }
  ]
}
```

[`insert.table`](/kits/doc/commands/insert.table/) answers `{ "table": [3] }`: the table is block 3,
and the empty paragraph the caret was in follows it as block 4. Cell paths are
`[3, row, cell, 0]`. Afterwards `doc_check` may report `doc.font-substituted` (info) for the new
cells' theme font; that is expected.

## Pitfalls

- **New paragraphs:** [`text.insert`](/kits/doc/commands/text.insert/) with `"\n"` puts a
  line-break character inside the paragraph. It does not make a new paragraph. Use
  [`text.newParagraph`](/kits/doc/commands/text.newParagraph/) at the caret.
- **Offsets after an edit:** inserting text moves every later offset in that paragraph. Use the
  `result.anchor` the step answered, or `doc_inspect` again, rather than recomputing by hand.
- **A failed step:** `doc_run` stops at the first failing step (`error.index`) and undoes the
  steps before it, so the document is as it was before the call and nothing is saved. Fix the
  failing step and send the whole run again.
- **Styles or direct formatting:** for a heading, apply the style (search `heading style`) rather
  than bold and a larger size; tables of contents and navigation read the style.
- **Files:** the kit works only on the files of its workspace, through the host, and starts no
  program. Commands that name a file by its path (inside `doc_run`, a macro or a batch too) and Read
  Aloud are refused; the host opens, saves and exports. Links a document holds (linked pictures,
  an attached template, a mail merge data source, `INCLUDETEXT` and the other fields) are never
  followed: they stay as they are.

## When others change the document

Pass `basis` (the `revision` of your last answer) with every write. The write is refused with a
`conflict` when someone changed what it rests on since, and applies when they changed something
else (`others` says what). What a write rests on:

- **A position** (`select.range`, `caret.set`): the paragraph it names, and its text **before and
  inside** the range, not after it. By index (`block`, a cell `path`) also the paragraph's place:
  a paragraph inserted or deleted above it refuses the write (`relocated`); by id (`para`) its
  place does not matter. An edit before the range refuses (`relocated`: the offsets name other
  characters), one inside it refuses (`changed`), one after it applies. A range across paragraphs
  holds the whole text of every paragraph but the last. A cell path holds its table's and row's
  place and the row's cells up to the one it names, not the other cells' text. A position in a
  header, footer, note or text box by its part number holds that the number still names the same
  part (another program's save may renumber parts); by the paragraph's id it is followed.
- **A step with no position of its own** acts on the selection the call started with (the caret
  at the start of the document unless a person moved it): that selection is held as a position
  by index, unless an earlier step of the run selected.
- **A step with `on`**: a character command (`format.*`, `font.*`) holds the formats the named
  paragraphs' characters carry (typing in them applies; a word of them bolded refuses); a
  paragraph command (`para.*`) holds their paragraph properties.
- **`para.text`** (by `index`): the paragraph at that index, its characters, and the formatting
  of its last character (the new text takes it). **`para.insert`** (`after`/`before`): the
  paragraph's place and properties, and what Enter reads at its end: whether it is empty, what
  AutoCorrect does to its last word, its last character's formatting, its style's `next`.
- **A style by name** (`style`, `basedOn`, `next`): that style (a change of another style applies).
- **`drawing.*` by number**, **`doc_batch`**: what they name, every field of it (a batch `set`: the
  field it replaces). `drawing.erase` holds the ink strokes its path takes; `drawing.ink` and
  `drawing.erase` need `placement.page`, and `drawing.ink` every stroke's `tool`, `color` and
  `width` (the caret's page and the editor's pen are not yours).
- **Every write**: whether changes are tracked (`settings.trackChanges`); while they are, the
  document's revisions (what you type, delete or format becomes a revision numbered there).
- **The clipboard** is not yours: `edit.paste`, the clipboard history, Paste Formatting and the
  plain-text or special pastes given no content are refused unless your call copied first
  (`edit.copy`, `edit.cut`, `edit.copyFormat`); give the content instead (`edit.pasteText`
  `{text}`, `edit.pasteSpecial` `{html}`).
- **Document properties**: a Title or Author field, a cover page and a title header hold the
  property they read, never the save stamp another program's save changes.
- **Tables a selection touches**: a cut across a table, Accept/Reject, Tab, Shift+Tab and Backspace
  into a table hold the table whole.
- **Pictures, equations, comments, parts** (C8-doc-6): a picture command holds the picture by its
  number (and the media it shows); an equation command the equation it edits (at the caret or
  being edited); a comment command the comment and thread it names (their comments, a resolved
  flag), and another program's change of a thread through the paragraph its range starts in;
  Replace in a header, footer or note that story's paragraphs and paragraph list only; a header
  or footer a command replaces whole that it is there; a command reading every story each
  part's paragraph list.
- **The editing mode** (an equation being edited, a column selection) is editor state: it is put
  back after each call, so another agent's or the person's mode is never yours. Enter it in the
  same run (`equation.edit`) before the commands that type in it; a step with `on` is in no mode.
- **Paragraph and drawing reads** (C8-doc-6): splits hold the paragraph properties they copy
  and the next style they resolve; joins and sorts hold the complete text they consume. List
  continuation holds neighboring paragraphs and their containing lists. Drawing moves hold
  their source and destination anchors; grouping includes every picked member. Page-point
  operations hold private layout facts; ink holds page counts or stroke geometry even when
  the current eraser hit set is empty. Mail merge consumes the `mergeSource` external input.

A write by commands stamps the document as Word's save does (`core.modified`,
`core.lastModifiedBy`, `core.revision`), and its receipt names that change of `document`; a
`doc_batch` is not stamped.

What each family of commands rests on besides what its step names:

| Family | Rests on besides the step's own objects |
|---|---|
| `format` | the selected paragraphs' styles and their runs' character styles, the styles they are based on, the document defaults, each paragraph's style |
| `para` | as `format`, and the paragraphs' whole properties; numbering commands: the list definitions, selected paragraphs and their neighbors |
| `table` | the table the selection is in (grid, properties) and each row's and cell's properties; a table style without a name: the styles |
| `insert` | tracked changes; cross-references, captions, tables of contents, indexes, Quick Parts, fields: every paragraph's text and properties and the document |
| `references`, `mailings` | every paragraph's text and properties and the document |
| `review` | the tracked-change commands: the document's revisions and comments; the comment commands: the comments; Track Changes and Restrict Editing: the settings |
| `comment` | the comments |
| `layout`, and the commands that find the selection's section (`design.pageBorders`, `arrange.align`, `arrange.position`, `table.autofit`, `table.fromText`, `table.quick`, `table.draw`, `insert.header`, `insert.footer`, `insert.removeHeader`, `hf.position`) | the last section's properties, the selected paragraphs' properties, and the section breaks from the selection to the end of its section |
| `arrange`, `shape`, `picture` on the selected drawing object | the object (`arrange`: where it is and how it wraps; `shape.effects`: its look; the other `shape` commands only that it is there); `picture`: the media; and the drawing objects and pictures of the selected paragraphs as a whole, so another program's rotation, resize or crop of one refuses |
| `design` | the page colour and the watermark: the settings; the paragraph spacing: the styles; the others: the whole document's content |
| `styles` | the style it names, else all styles |
| `edit` | replace: every paragraph's text and properties |
| `equation` | converting every equation: every paragraph |
| `text`, `drawing`, `draw`, `file`, `document`, `hf`, `list` | tracked changes; `hf`: the parts; `list`: the list definitions and neighboring paragraphs; drawing/ink: the consumed anchors, object/id indexes and layout facts |

Besides, a command holds the document-wide fields its code reads (C8-doc-4): the section's page
(tables, pictures, text boxes, headers and footers, tables of contents and indexes: their width
and place), the parts (notes, comments, text boxes, headers), the comments, the list definitions,
the media, the sources, the custom properties; the styles where nothing narrower holds them.

Every write command's handler and the engine edit behind it have an independent reading in
`bindings/wasm/tests/declarations_independent.rs`. The comparison checks each code path's
resolved objects, fields, places and editor inputs against its declaration, with decreasing
floors for conservative excess holds. The frozen catalogue has no held-less difference; this
measures the listed paths rather than proving every possible input.

The guard uses the public SDK revision `45bf9625`. Receipt objects retain their public
structure while private names and values stay hidden.

File rereads use the SDK's complete object inventory, including inline objects referenced only
by text marks. Proven public changes appear in `others`; private fingerprints remain private.
Formatting by paragraph ID compares historical marks without depending on its body index.
Rereads import the saved-file difference into the live replica, preserving undo and following
the active selection. A missing active paragraph or drawing identity refuses replacement.

Where the guard is blind or too strict:

- Lists (`num`), styles, cells and media have no tool ids: a list by `num` is held only through
  the list definitions; bitmap adjustments also hold the root's `media` because deduplication
  scans the collection. An equation's number is its
  place: an equation inserted before it renumbers it (a write naming the old number refuses). A
  comment's session number (`c0`) is not stable across another program's save: name comments by
  their tool ids.
- No held-less difference remains in the independent catalogue. This is a declaration
  measurement, not proof of every possible input. File-path commands remain refused for agents;
  the comparison excludes their unavailable file facts. Clipboard commands require a copy in
  the same call. Ordinary private facts are eager: layout is recomputed after each write or
  reread, and positioned drawing/ink insertion projects a temporary command to find its anchor.
- Conservative excess holds remain in editor inputs, paragraph text, document fields, indexed
  places and object fields. Some families hold complete collections or properties even when a
  specific branch consumes less. Comments by id, Track Changes, Restrict Editing, mail merge
  records and a paragraph inserted by index read no selection and hold none.
- Shape arrangement holds the selected object's consumed frame fields; other shapes in the
  same paragraph do not cause a conflict. Named objects do not hold their paragraph's index.
  Shape and picture property commands retain broader assigned-value protection.
- Eraser paths conservatively refuse changes whose historical geometry cannot be rebuilt.
- A paragraph cut and pasted by another agent on the same server refuses: a range by its id
  reads as `deleted`, a step with `on` as `unknown`.
- A step with `on` naming a paragraph joined into the one before refuses with `changed` (the
  intended reason is `deleted`); a cell path after a row inserted above it on the same server
  refuses with `changed` (intended: `relocated`).

## Checks

`doc_check` lists what is wrong with the document. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/doc/checks/).

- `doc.font-substituted` (info): a font, often the theme's Aptos, isn't installed here. The file
  keeps the font; only the preview and line breaks use a substitute. Don't change fonts to silence
  it unless asked.
- `doc.tracked-changes` (info): if `settings.trackChanges` is on, your edits become tracked
  revisions, and this code reports them. Its `fix`
  [`review.acceptAll`](/kits/doc/commands/review.acceptAll/) accepts every revision, so run it only
  when the person asked for that.

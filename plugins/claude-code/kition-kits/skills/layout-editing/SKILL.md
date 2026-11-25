---
name: layout-editing
description: "Create, inspect, edit and check a page layout (.klayout) with the Kition Layout kit's tools: pages, frames, text, styles, swatches, tables, and more. Use when the user asks to make, read, change, review or fix .klayout files in this project."
---

<!-- Generated from kition-layout agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
`layout_<action>` tools this guide names are `kit_<action>`, routed by the file's extension
(`layout_run` is `kit_run`, `layout_check` is `kit_check`). With "unified" off they are named as
written. Paths are relative to the project folder.

# Layout kit

The Layout kit opens, edits and checks page layouts for print and screen (`.klayout`; IDML files
open as imports). Pages hold frames, text flows through threaded text frames as stories, and a live
preflight reports what would go wrong in print. An agent can make and arrange frames, write and
format text, manage swatches and styles, place graphics, check the document with the preflight, and
export it to PDF, PNG, JPEG, HTML, IDML or EPUB.

## Tools

The kit's prefix is `layout`. Its tools are:

| Tool | Does |
|---|---|
| `layout_inspect` | The document as JSON (pages, items with ids and bounds, stories, swatches and styles), with a preview on request: the whole layout, or with `target` one page (`{page}`, from 1), spread (`{spread}`, from 0) or object (`{path: "item:<id>"}`, as a diagnostic names it) |
| `layout_query` | Reads objects of the document's object model by id, or by following fields from the root |
| `layout_commands` | Finds commands by keywords, each with its parameter schema |
| `layout_run` | Runs a list of command steps |
| `layout_batch` | Runs one batch of object-model operations |
| `layout_check` | The live preflight: what is wrong with the document, as diagnostics |
| `layout_create` | Makes a new `.klayout` document |
| `layout_export` | Writes the document to a new PDF, PNG, JPEG, HTML, IDML or EPUB file |
| `layout_draft_ready`, `layout_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the document's path in the workspace. With `draft: true` your edits go to
your draft of the document and leave the file as it is; only the person merges or discards a draft.

## Addressing and coordinates

- A document has **spreads** of **pages**, **layers**, **swatches**, and paragraph and character
  **styles**. `settings.intent` is `print`, `web` or `mobile`; a print document is checked for
  print problems (RGB colour, image resolution).
- Page items are text frames, graphic frames, rectangles, ellipses, polygons, lines and groups. A
  text frame shows part of a **story**; a story can thread through several frames.
- Coordinates are **points** in spread coordinates: `(0, 0)` is the top-left corner of the spread's
  first page, `x` grows right and `y` grows **down**. A rectangle is `[x0, y0, x1, y1]`.
- A `spread` parameter counts spreads from **0**. Diagnostics' `target.page` counts pages from
  **1**.
- Items and stories are named by numeric **ids**: `layout_inspect` lists `spreads[].items[]` (each
  with `id`, `kind`, `bounds`, and `story` for text frames) and `stories[]` (each with `id`,
  `frames` and `overset`). [`frame.add`](/kits/layout/commands/frame.add/) answers `{id}` and,
  for a text frame, `{id, story}`.
- Ids are stored in the document: an object keeps its id when the document is saved and opened
  again, in another session, and in your draft. Two people who
  each make an object at the same moment may get one id; after their edits merge, the newer
  object has the next free id, so read the ids of objects you just made from `completed[].result`.
- Query, batch, and declared command object parameters share tool addresses. Spreads, pages,
  layers, items, stories and assets use their stored numeric `number` (a decimal string is also
  accepted). Guides, sections, inlines, tables, rows, columns, cells, styles, swatches, opaque
  records and comments use their immutable `address`. The root is `layout`. An integer in a
  parameter is an object address only when that command declares it as one.
- Style and swatch lookups accept names or their queried addresses. A name that two definitions of
  the family share (a swatch in a colour group, for example) is refused: name one by its address. A style address must belong
  to the command's style family. Newly assigned names are values, not lookups. Local table and
  note numbers are places within their holder, not global object ids; table places currently
  resolve through the story/cell selection. Stable-address command support for local notes and
  settings records is incomplete; use query/batch addresses for those records.
- Diagnostics name an item as `target.path` `item:<id>`.
- Commands that take `ids` act on those items; without `ids` they act on the selection. Character
  formatting ([`text.char`](/kits/layout/commands/text.char/)) acts on selected text: select it
  first with [`text.select`](/kits/layout/commands/text.select/) `{story, anchor, focus}`, where
  `anchor` and `focus` are UTF-8 byte offsets in the story, counted from 0.

## Workflow

1. `layout_inspect {path}`: pages, items with ids and bounds, stories (with `overset`), swatches
   and styles; `preview: true` for a picture of the layout, `target` for one page, spread or object.
2. `layout_commands {path, query}`: find commands by keywords (`"text frame create"`,
   `"fill swatch"`, `"align page"`). Use the exact id it returns and follow its parameter schema;
   never guess a command id.
3. `layout_run {path, steps}` a few steps per call. A failing step stops the call and the kit undoes
   the steps before it, so the document is as it was before the call and nothing is saved: read
   `error.index` for the failing step, fix it, and send the whole run again. A call that succeeds
   saves the document (`save` defaults to `true`).
4. `layout_check {path}`: the live preflight. Fix what it reports and check again.
5. `layout_inspect {path, preview: true}` to look at the result.

## Observations and stale writes

Keep the `revision` returned by an observation and pass it as `basis` on the subsequent write.
The default `premise` guard checks the facts that call holds against the observed revision.
Unrelated outside changes can apply; the receipt's `others` describes those changes. A refusal
reports `deleted`, `relocated`, `changed` or `unknown`. Observe again before deciding how to
retry. `epoch` refuses every outside document change; `off` permits stale writes.

Commands publish typed object/name parameters, place parameters, and editor state in `reads`.
Raw model batches must leave text frames linked to stories and groups with tree children;
inconsistent content conversions refuse atomically before merge repair runs.
An explicit `on` supplies an item selection for the call. Layout has no implicit current page
or time: use each command's explicit page/spread parameters. A call saves and restores the
selection (including text/cells/anchors), active layer, tool, preferences, clipboards, repeat
history, loaded cursor and auxiliary session state. A live gesture/data preview cannot accept
an explicit call context. Tool gesture internals are not serialised.

These are the currently audited per-call premises, implemented in `bindings/wasm/src/place.rs`:

| Commands | Facts held |
|---|---|
| `object.rename`, `fill`, `opacity`, `label`, `altText`, `lock`, `hide`, `setFlags`, `attributes`, `transparencyGroup`, `setLayer`; `layer.set` | The fields written, without placement. Fill holds swatch and tint; opacity also holds blend when supplied. Referenced swatches/layers are declared objects. |
| Non-copy `transform.move` | Target lock and transform/ownership placement; ancestor transforms/ownership. `toSpread` also holds the destination spread and its index window. An unrelated target property may change. |
| `object.align` with `to` page, margins or spread | The targets, and the size, margins and place of the page under them (every page of the spread for `spread`). |
| `arrange.group` | Members' layer, transform and ownership placement. Only top-level members in one spread are accepted. |
| `xml.deleteTag` | The set of items tagged with the name (an item another writer tagged or created tagged refuses `relocated`; one untagged, deleted or tagged otherwise does not), the tag's definition and the style-to-tag mappings. |
| `form.set` without `name` | The existing form fields' names, which the default name avoids: another writer's new or renamed field on an existing item refuses. A new item created as a form field after the observation is not held (the command has no place parameter for the guard to ask about); the name chosen is still unused when the write runs. |
| Writes that map spread coordinates into an item or its path out to the spread (`path.split`, `path.erase`/`smooth`/`addAnchor`/`appendAnchor`/`moveAnchors`, `path.convertAnchor` with `to`, `object.gradientFeather`/`object.gradient` with `from`/`to`, `object.makeCompoundPath`, `object.pathfinder`, `anchored.insert`, `object.caption`, `edit.pasteInto`, `transform.set`, `text.placeCaret`, `table.dropCells`) | Each ancestor group's transform and place, besides the target. |
| `layout.deleteAlternate`, `layout.addAlternate` | Deletion: the layout's pages (its `name` is a place), their items, stories, assets and parents, and the sections. Creation: the source layout's pages, their items, stories, assets and parents, the sections and the spread list (a page added anywhere refuses). |
| `liquid.pageRule`, `page.background` without `pages`; `page.transition` with `all` | Every page's stored fields and the spread list: a page another writer adds or changes refuses. |
| `data.source.remove`, `data.placeholder.add` | The data sources (`settings.dataMerge.sources`); the placeholder's story or item as named. |
| `layer.move` | Source placement and destination list gap in stored order, accounting for removal of the source. |
| `layer.new`, `layer.others`, `layer.deleteUnused` | Creation holds the layer count used for naming/color. Others holds the sorted layer identity set and affected flags, leaving an excluded layer's other fields free. Unused deletion holds layer and used-layer identity sets, plus the first stored layer when none is used. Reordering does not refuse when only count or membership matters. |
| `layer.delete`; `object.setLayer` | Deletion holds the layer, every item on it and `~layerItems`, the set of items the engine deletes with it; that set is also a place of the layer (its `id`), so an item another writer changes on the layer, moves onto it or creates on it refuses, and one put on another layer does not. Assigning a layer holds the layer's stored fields, not its items. |
| A `spread` counted from 0 that a command creates or acts in (`frame.add`, `line.add`, `path.add`, `file.place`, `guide.add`, `layout.addGuides`, ...); `button.set` `page`; `toc.generate`, `index.generate`, `file.place` `page`; `page.transition` `pages` or `spread`; `liquid.pageRule` and `page.background` `pages` | The counted spread and page prefix (an insertion or deletion before refuses `relocated`) and the addressed spread's or page's identity. `gap.move`'s `spread` holds the prefix spreads' places but not an insertion before them (a `within` window beside `covers` is not checked at this pin). |
| `state.show`/`rename` `index`, `path.deleteAnchor`/`convertAnchor` `anchor`/`subpath`, `path.moveAnchors` `anchors`, `anchored.options`/`release` `index`, `xref.setFormat` `index`, `text.select` `anchor`/`focus` | The object the position counts in (item or story), whole. |
| `guide.move`, `guide.delete`, `guide.liquid` | The counted spread and page prefix, and the guide at that index on its page, including every guide before it (guides are stored by position); a parent spread named by its prefix also holds that prefix and name. Move/delete also hold the layer's effective visible/unlocked/show-guides predicate. |
| `edit.replaceObjects` | Matched target fields and query membership, evaluated by the engine's shared matcher against historical scalar facts. Layer names and typed addresses use one resolver. |
| Parent application and page insertion | Parent prefix or full label identity, not its definition. The omitted insertion parent holds the first parent's identity and list position. |
| Page-number writes (`pages.insert/delete/move/applyParent/toSpread`, page size, margins, section, overrides); spread duplicate/shuffle/rotation | Resolved page/spread, the identities and placement of the prefix counted by the address, and insertion windows. Page deletion also holds the removed items, their stories/assets and `~pageItems`, the set of items the engine deletes with the page, so an item another writer puts on the page refuses; other page writes hold the page's stored fields, not its items. Page source and reshuffling dependencies are still being reviewed. |
| `story.replaceRange`, `spelling.change`, `anchored.insert` with `story` and `pos` | Offsets are UTF-8 **byte offsets**, not character counts, and a positional address: the write rests on the story's text before and inside its range, not on text after it. Another writer's edit before the range or inside it refuses `relocated` (inside is reported as `relocated`, not `changed`); an edit after the range applies. A change whose place a change set cannot tell refuses `relocated` with `place.unknown`: a formatting-only change anywhere in the story, and an insertion into repeated text that could have been made at or before the range's end. Change sets give a story over 80 characters as an excerpt: the kit finds the observed text among the texts its process held (opened, changed, inspected); when it held none or several that fit (after a restart of the kit, or past its memory budget) the write refuses with `place.unknown`. Anchored objects, notes and tables inside the range are held whole. |
| Other text editing and formatting | Resolved stories, whole, including text and owned content: an edit anywhere in the story refuses. This includes `text.select` with `anchor`/`focus` and the selection-based writes after it. Formatting selected frames, also one frame of a threaded story, acts on the whole story, not just the text visible in that frame, and so holds the whole story. Point-to-caret reflow dependencies remain under review. |
| Copy/cut/clear, content conversion, duplicate, copy-move, step and repeat, outlines, spread duplicate, library/conveyor collection; update linked story | Source descendants and their referenced stories/assets; linked updates also hold the source parent story. Outlines hold used paragraph, character, table and cell styles, including based-on chains and nested styles. A clipboard already copied in the session is a frozen source. |
| Named styles and swatches | The resolved definition's name for applications/references (also `toc.generate`'s `styles` and `entries[].style`), its content for edits/deletes. Five read-only scoped style lookup keys are maintained for commands with a fixed family, including direct model batches. `style.group` and `style.exportTag` still use the SDK's generic name check and can falsely refuse after a same-spelling rename in another family. |
| `object.gradient` | The target and the current fill's swatch definition: changing a gradient copies and modifies its current stops, rather than merely assigning a style identity. |
| Hyperlink record edits/deletes; placeholder removal | The settings entry selected by its stored id, rather than a same-valued global object number. |
| Bookmark rename/delete | The settings bookmark prefix counted by the index. |
| `file.applyTemplate`; `font.replace`; destructive `text.pathOptions` | Templates hold the whole replaced document. Font replacement conservatively holds all stories and, unless disabled, paragraph/character/composite definitions; unrelated item properties can change. Removing path text holds its story. |
| Conditions, text variables, named lists, custom strokes, articles | The settings entry selected by its name, including its content. These entries lack immutable keys: rename/delete refuse as `changed`, rather than a refined identity reason. |
| `xref.defineFormat`, `style.compositeFont.set`, `swatch.ungroupColorGroup`, `swatch.renameColorGroup`, `ink.options` with `allToProcess` | The named definition/group consumed or overwritten; group rename holds source/destination names while allowing member changes. The ink flag is held as its effective default-aware value. Other groups/definitions and per-ink options can change independently. Per-swatch group membership and other ink-option branches remain under review. |
| `xref.insert`, `xref.setFormat` | The assigned format's existence/name, including insertion's default format. A definition-content edit may apply because assignment stores its name; a rename-away refuses. |
| Footnote/endnote options and insertion | The document's note options; endnotes also hold their generated story reference. |
| `file.preferences`, `edit.transparencyBlendSpace`, `change.track`, dictionary words and hyphenation exceptions | The stored settings fields they overwrite. |
| `object.globalLight`, `object.primaryTextFrame` | The root's `setup.globalLight` and `setup.primaryStory`, respectively. The primary-frame command's omitted `on` toggles from the observed primary story. |
| `frame.fitText` | The resolved story, threaded frame geometry and used paragraph, character, table and cell definitions through based-on chains. Point-to-caret and outlines hold these too, and the story's `~compositionFrames`: each frame's area, options, wrap exclusions and page, as the composer reads them. Fonts are not held: a composite font redefined (`style.compositeFont.set`) or a font file added to or removed from the machine changes what fitting computes without refusing; a font replaced in the document (`font.replace`) changes the story's formatting and so refuses. |
| `frame.thread`, `frame.unthread`, `frame.loadText` | The referenced frames and their stories, including both endpoints when joining stories. |
| `gap.move` | Exact engine gap neighbours, geometry/visibility/lock, their layers and page geometry. Historical substitutions are applied together; unsupported historical structure returns unknown. |
| Existing-table commands; `style.cell.apply`, `style.table.apply` | Cell non-stroke edits hold the addressed cells and possible merged owners, with counted row/column prefixes. Row height and column width edits hold addressed line definitions. Insertions hold copied neighbouring cell formats and row kinds; deletions hold removed/displaced cells; merge/unmerge hold addressed cells and merged spans. Anchor deletion/conversion also holds story text. Split, move/sort, strokes (which mirror to neighbours), table styles and composed row distribution still hold the whole table. Header/footer rows use the engine's resolved range. |
| Rules read from the blind readings (`bindings/wasm/src/place/rests.rs`) | One table per command of what the handler reads besides its targets and parameters. Typing/special characters/deletion: `setup.trackChanges`. Page insertion/move/document setup: the setup, the sections and the items repagination moves; page size and margins with Adjust Layout: the items on those pages. Arrange: each sibling's place in the item tree. Unlock/show all: every top-level item's flag. Style deletion, object-style application, style groups, change acceptance, condition/variable deletion, find next, table drops: every story's text. Table selection: the table's rows and columns. Layer deletion: the layer count (`~layerCount`); a page background: the last layer (`~lastLayer`). Creation defaults: a new text frame (also captions, linked stories) holds the default paragraph and text-frame styles, that object style and the binding (a new story's direction); a size step, OpenType toggle, broken link, paragraph rule patch or style from the selection holds the formatted text's style chains; a table insertion the insertion story's text and frames; a new condition the conditions; a new parent the setup size, facing pages, first page's margins and columns and, without a prefix, the parents' prefixes. Paste: the selected story whole, track changes and the first spread. Cell/table style edits: every cell's/table's style and properties. `variable.insert`: the whole variable list (an instance stores its index). Misc: articles, data-merge sources/placeholders/options with hyperlink ranges, hyperlinks, bookmarks, stroke styles and XML settings whole; `linkedFile.goTo` every item's graphic; `object.layerOptions` the placed asset; `math.insert` the first page and active layer; `data.merge` and `script.run` the whole document. |
| Effects, corners, wrap, stroke, export options | The one effect (`effects.dropShadow`, ...) or field the handler patches on each target: another writer's rename, move or paint of the same item applies. |

`~boundsX0`, `~boundsY0`, `~boundsX1`, `~boundsY1` are derived from an item's path/content/transform and owned group children, in the
parent coordinate system; it is not a stored field or a world-space box. Group transform receipts
use `carried` to report the descendant count whose world location follows the group, without
one edit per descendant. Scalar bounds allow the SDK's offset footprints to state all moved
objects without a truncated detailed list. Page/spread `~placeSpread` identifies the spread in
historical spatial evaluation, including after deletion.

An independent reading covers all 460 registry handlers, including all 395
journaled commands. Counts include query and session-only handlers. Per source family:

- Objects: object 63/63, paths 6/6, edit 14/14, select 9/9, thread 4/4, fit_text 1/1,
  path_type 2/2, anchored 4/4, captions 1/1, linked 4/4, library 12/12.
- Text: text 37/37, style 29/29, table 41/41, find 5/5, fonts 3/3, spelling 8/8,
  notes 6/6, endnotes 5/5, xref 7/7, toc 3/3, index 4/4, editorial 5/5, changes 6/6,
  variables 4/4, lists 2/2, conditions 5/5.
- Layout: layout 23/23, overrides 3/3, guides 6/6, liquid 6/6, background 1/1,
  transitions 2/2, file 21/21, templates 2/2, interchange 2/2, export 6/6,
  export_bytes 1/1, export_image 1/1, prefs 3/3, print 2/2, package 2/2, preflight 1/1.
- Other: anchors 5/5, articles 6/6, book 10/10, buttons 6/6, colorsettings 3/3,
  datamerge 10/10, interactive 9/9, links 6/6, mathexpr 2/2, media 2/2, pdflayers 2/2,
  qr 1/1, scripts 1/1, states 5/5, strokes 3/3, xml 12/12, inspect 5/5.

These readings follow direct mutation operations and the composition entry/frame-input
paths, not every deeper shaping, table composition, variable expansion or export codec
algorithm. The prose rows and the 345 projection inputs are written without the declarations,
and the 66 misc commands have blind projections written from their prose rows, so all 395
journaled commands are compared. Over all 395, 165 commands differ: 1 holds less than the
handler reads and 165 hold more (false refusals). The one held-less command is
`file.importXml` (agent-blocked), which reads its target story's frame list: a premise on a list
field holds the members' content at the pinned SDK, so holding it would refuse unrelated frame
paint. Held more: 79 commands whose free probes the declaration holds (mostly a target held whole
by the SDK's default where the handler reads a few fields) and 120 that declare `mode` (or another
editor axis) the blind reading does not name. Layout keeps no mode in its editor state; `mode` is
declared on every journaled command because smart reflow and live captions read session
preferences, which the three-family readers count as `mode` and the misc reader does not: that
disagreement between readers is unresolved. Each class of held fact has an outside-writer test
(`bindings/headless/tests/outside/read3.rs`). These are probe counts: conditional paths and
coarse translations remain, and free probes do not enumerate every excessive hold.
The guard asks a later step's premises on a copy of the document after the earlier steps ran, so
a source cell or text an earlier step of the same run selects is held
(`waiting_for_sdk_read2_selection_step_source_premises` refuses the changed source and applies
an unrelated change).
The blind selection/active-layer expectations are checked against the declarations of every
journaled command. An outside-writer regression verifies `story.setDirection` with frame
selection context: a changed story refuses, while an unrelated item rename applies.
`layout.pages.move` returns an unsupported error if any non-shuffling multi-page spread exists
(except a no-op move). Moves within preserved spreads are not implemented: they need stable page
identities across repagination, spread membership rebuilt around kept spreads, page-relative
item translation, and sections, parents, guides and shuffle flags carried with each page.

The guard audit is incomplete. Other commands retain the SDK's default checks on declared objects;
that does not establish all dependencies. Ordered pages, guide/local-note/settings places,
selection-addressed text ranges, reflow/captions and style application need further implementation review. Shared
style names across the five namespaces may cause a conservative name refusal. Historical page,
hierarchy and nested-child geometry substitutions can return unknown even for an unrelated edit.
Derived values (`~pageItems`, `~layerItems`, `~compositionFrames`) are declared in the object model.
The SDK re-reads a derived value after another agent's write on the same server only for the
objects that write names, and an item put on a page or layer or a wrap object moved names neither
the page, the layer nor the story. So page and layer deletion also name the items they delete
as objects under their place (an item another agent created on or moved onto the page or
layer refuses), and composition premises also hold the root's `~compositionFrames.<story>`. The
root's value is compared whole at the pinned SDK: after another writer changes any story's
composition inputs, every composition-dependent write refuses, including ones the change did not
touch (waiting for the SDK to compare a derived value at a premise's sub-path).
At the pinned SDK, deletion/move-out before an index gap can still let a stale batch insert apply;
batch deletion of a nonempty group is also refused. A command with both `covers` and `within`
does not get an index-window check at this pin. The outside-writer tests cover the audited forms,
not a blanket guarantee for all Layout commands.

## Example 1: a branded band and a centred line of type

```json
layout_run {"path": "Flyer.klayout", "steps": [
  {"command": "swatch.add", "params": {"name": "Brand", "color": {"c": 70, "m": 75, "y": 0, "k": 0}}},
  {"command": "frame.add", "params": {"rect": [72, 300, 540, 420], "content": "unassigned"}},
  {"command": "frame.add", "params": {"rect": [72, 450, 540, 520], "content": "text", "text": "Saturday 8 pm, Town Hall"}}
]}
```

Answer: `completed: [{result: {name: "Brand"}}, {result: {id: 9}}, {result: {id: 10, story: 11}}]`.
Use those ids:

```json
layout_run {"path": "Flyer.klayout", "steps": [
  {"command": "object.fill", "params": {"swatch": "Brand", "ids": [9]}},
  {"command": "text.select", "params": {"story": 11, "anchor": 0, "focus": 24}},
  {"command": "text.char", "params": {"attrs": {"size": 28, "fill": "Brand"}}},
  {"command": "object.align", "params": {"edge": "hcenter", "to": "page", "ids": [10]}}
]}
layout_check {"path": "Flyer.klayout"}
→ {"diagnostics": []}
```

## Example 2: fix what the check reports

```json
layout_check {"path": "Programme.klayout"}
→ {"diagnostics": [{"code": "layout.overset", "severity": "error", "target": {"page": 1, "path": "item:10"},
    "message": "Overset text: 1123 characters.", "fix": {"command": "frame.fitText", "params": {"ids": [10]}}}]}
```

Over a thousand characters do not fit, so the fix would shrink the type to a couple of points
([`frame.fitText`](/kits/layout/commands/frame.fitText/) answers `{stories: [{size: 2.0}]}`). Make
room instead, then check again:

```json
layout_run {"path": "Programme.klayout", "steps": [
  {"command": "transform.resize", "params": {"ids": [10], "from": [72, 300, 200, 320], "to": [72, 300, 540, 720]}}
]}
layout_check {"path": "Programme.klayout"}
```

A missing font is replaced as the fix says:

```json
layout_check {"path": "Poster.klayout"}
→ {"diagnostics": [{"code": "layout.missing-font", "severity": "error", "message": "Missing font: Kition Missing Sans.",
    "fix": {"command": "font.replace", "params": {"family": "Kition Missing Sans", "toFamily": "Source Serif 4"}}}]}
layout_run {"path": "Poster.klayout", "steps": [
  {"command": "font.replace", "params": {"family": "Kition Missing Sans", "toFamily": "Source Serif 4"}}
]}
layout_check {"path": "Poster.klayout"}
→ {"diagnostics": []}
```

## Pitfalls

- **Frame content:** [`frame.add`](/kits/layout/commands/frame.add/) needs `content`: `text`
  (with `text`), `graphic`, or `unassigned` (a shape).
- **Select text first:** [`text.char`](/kits/layout/commands/text.char/) `{attrs}` changes the
  selected text only; run [`text.select`](/kits/layout/commands/text.select/) first.
- **Results of earlier steps:** steps in one `layout_run` cannot refer to an earlier step's result.
  Create, read the ids from `completed[].result`, then use them in the next call.
- **Print colour:** colours in a print document should be CMYK swatches (`{c, m, y, k}`, each 0 to
  100); a `#rrggbb` swatch is RGB and the check reports it.
- **Fitting text:** [`frame.fitText`](/kits/layout/commands/frame.fitText/) can shrink a long story
  to an unreadable size; prefer a larger or threaded frame when much text is overset.
- **Files:** commands that read or write files are not offered through `layout_run`; graphics and
  text come in with [`file.place`](/kits/layout/commands/file.place/) `{path}` (a file in the
  workspace, by its path) or `{base64, name}`. A path outside the workspace (absolute, `../` that
  climbs out, a URL, a hidden name) is refused, and links in a document that name one are never
  read. Printing is not available.
- **Undo:** your [`edit.undo`](/kits/layout/commands/edit.undo/) takes back your own steps only; the
  person's edits stay.

## Checks

`layout_check` lists what is wrong with the document. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/layout/checks/).

| Code | Severity | What to do |
|---|---|---|
| `layout.overset` | error | Text does not fit: enlarge the frame, thread a new frame, cut text, or `fix` [`frame.fitText`](/kits/layout/commands/frame.fitText/) `{ids}` (shrinks the type to fit: check the answered `size`) |
| `layout.missing-font` | error | `fix` replaces it with the bundled family ([`font.replace`](/kits/layout/commands/font.replace/) `{family, toFamily}`); pick another available one with [`font.families`](/kits/layout/commands/font.families/) if the person wants |
| `layout.missing-glyphs` | error | The font lacks those characters: use a font that has them |
| `layout.missing-link` | error | A placed graphic's file is gone or outside the workspace (never read from there): put it in the workspace and place it again ([`file.place`](/kits/layout/commands/file.place/) `{path}`), or remove the frame |
| `layout.unsupported-typography` | warning | A setting the kit keeps but does not compose (kinsoku, mojikumi, Arabic justification); tell the person |
| `layout.low-resolution` | warning | The image is too small for print at its size: place a larger image or scale the frame down |
| `layout.empty-frame` | warning | `fix` removes the empty text frame ([`edit.delete`](/kits/layout/commands/edit.delete/) `{ids}`) |
| `layout.rgb-in-print` | warning | Use a CMYK swatch ([`swatch.add`](/kits/layout/commands/swatch.add/) `{name, color: {c, m, y, k}}`) in a print document |

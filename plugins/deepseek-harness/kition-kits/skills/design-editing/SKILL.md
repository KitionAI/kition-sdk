---
name: design-editing
description: "Create, inspect, edit and check a interface design (.kdesign) with the Kition Design kit's tools: frames, shapes, text, auto layout, components, styles, variables, prototyping, and more. Use when the user asks to make, read, change, review or fix .kdesign files in this project."
---

<!-- Generated from kition-design agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`design_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`design_run` is `mcp__kition__kit_run`, `design_check` is `mcp__kition__kit_check`).
With KITION_KITS_UNIFIED=false they are `mcp__kition__design_<action>`. Paths are relative to the
workspace folder.

# Design kit

The Design kit opens, edits and checks interface designs (`.kdesign`), and imports `.fig` and `.sketch`
files. A design is pages of layers: frames, rectangles, ellipses, text, vectors, components and
their instances. An agent can create and change layers, set up auto layout, styles, variables and
prototype flows, check the design for overflowing text, off-pixel layers, low contrast and missing
components, images, styles or variables, and export PNG, JPEG, SVG or PDF.

## Tools

The kit's prefix is `design`. Its tools are:

| Tool | Does |
|---|---|
| `design_inspect` | The design as JSON: its pages (`id`, `index`, `name`, layer count) and the layer count. `target: {"pageId": id}` (or `{"page": n}`) lists that page's layers (`part.layers`) and, with `preview: true`, draws it; `{"objectId": "12"}` or a diagnostic's `{"path": "layer:12"}` draws one layer |
| `design_query` | Reads objects of the design's object model; `{follow: "nodes", fields}` lists the layers, each named by its layer id (`id`, the same number as the field `key`), with `name`, `kind`, `frame`, `fills`, `layout` … |
| `design_commands` | Finds commands by keywords (`rectangle`, `text`, `auto layout`, `component`, `frame`, `style`), each with its parameter schema; at most 12 answers |
| `design_run` | Runs 1 to 50 command steps in order (below) |
| `design_batch` | Runs one batch of object-model operations on objects named by the ids `design_query` answers |
| `design_check` | What is wrong with the design, as diagnostics |
| `design_create` | Makes a new `.kdesign` design |
| `design_export` | Writes the design to a new PNG, JPEG, SVG or PDF file (`{path, to, format?}`) |

Every tool takes `path`, the design's path in the workspace. The kit keeps no drafts, so it has no
draft tools.

## Ids

- **One id space.** Every layer and every page has a numeric id (`12`, `6368281153765377`): the
  `id` inspect lists, the `id`/`ids`/`parent` commands take, the `id` a command such as
  [`node.create`](/kits/design/commands/node.create/) answers, the id `design_query` and `design_batch` answer
  and take, and the id receipts, `others` and `conflicts` name (JSON integers there too).
  Ids stay the same when layers are renamed, moved or reordered, when pages are moved, and
  when the file is saved and opened again. Never guess one: an unknown id fails with `no such node`.
- Styles, collections, modes, variables, library links and images keep their string keys as tool
  ids (`"S:…"`, `"VariableCollectionId:…"`, image hashes). Comment threads keep their integer
  keys. Use these in the parameter whose `object_types` declares that type; `on` is for a
  command's declared targets. Imported thread/layer number collisions are repaired
  deterministically before exposing tool ids; inspect again after an import. Individual
  messages are held through their thread; category and preset records through settings
  selectors. Saved versions and branches use string record ids, not layer ids.
- An integer is an object address only in the command's marked `objects` or `targets` paths.
  Indexes, dimensions and point coordinates are numbers, not object ids. A connector's endpoint
  may be either an object or coordinates; the call resolves which one it is. Marked name
  parameters resolve names within their declared object type, rather than across all types.
- A page is named by its id: `{"pageId": 7}`. `{"page": n}` names the page at place `n`, counted
  from **1**, as diagnostics give it; it names another page after pages are added or moved.

## Where a step acts: `target`, `at` and `on`

Name what each step acts on. Commands publish the editor state they read in `reads`; the host
restores the person's page, selection, view, tool, modes and other saved editor inputs after
the call. A command that falls back to those inputs needs the corresponding context.

- A `design_run` step is `{command, params?, on?, at?}`. The run's `target` (`{"pageId": id}`) is the
  page every step acts on; a step's `at.part` (`{"pageId": id}`) overrides it for that step. A
  command given no parent and no page (a new layer, `select.byName`) acts on that page; without
  one, on the page the person is on.
- `on` names the layers a step acts on, by id. It goes into the command's own parameter for them
  (`ids` or `id`: `design_commands` marks it as the command's `targets`; then do not give that
  parameter too), or, for a command that acts on the selection, they are selected for that step
  only. A layer's id names its page, so `on` needs no `at`. Layers of two pages need two steps
  when they go through the selection; `ids` takes layers of any pages.
- A command given what it acts on (`id`, `ids`, `parent`, `page`, `frame`) acts there and leaves
  the person's page, selection, view, tool and edit modes as they were, also when it fails. What
  it creates on the step's page becomes the selection, so the next step of the same run can act on
  it without an id. Only commands whose work is moving the editor (`select.*`, `page.select`,
  `page.go`, `view.*`, `tool.*`, `text.edit.*`, `vector.edit.*`) move it, and the editor is put
  back after the call: a later call starts again from the person's page.
- Some commands read an edit mode (text or vector editing, the tool): set it with the kit's own
  command (`text.edit.begin`, `vector.edit.begin`) in an earlier step of the same run.
- The file saves the person's page, never where the run worked.

## Inspecting and previewing a named page or layer

- `design_inspect` without `target` lists the pages: `{id, index, name, layers}` each.
- `design_inspect {target: {"pageId": id}}` lists that page's layers without going to it, in
  `part.layers`: each `{id, name, type, index, z, children?}`. To list one layer and what is in it,
  run [`page.inspect`](/kits/design/commands/page.inspect/) `{id: <layer id>}`.
- With `preview: true` it draws `target`: a page (`pageId` or `page`), a layer (`objectId`, or a
  diagnostic's `path`), a frame (`frame`), or an `area` `{x, y, width, height}` of a page in page
  coordinates. Without `target` it draws the first page, never the one the person is on. `scale`
  (at most 2) and `maxSize` (the longest side in pixels) set its size. `preview` in the answer says
  what was drawn (`page`, `pageId`, `pageName`, `drew`, `objectId`, `bounds`). The same call
  answers the same picture.

## Conventions

- **Pages** count from **1** in `target.page` and in diagnostics, and from **0** in `index`
  (`pages[].index`, [`page.select`](/kits/design/commands/page.select/) and `page.go` `{index}`). `pageId`
  never changes.
- **Coordinates** are pixels, `x` growing right and `y` growing down. `x` and `y` of
  [`node.create`](/kits/design/commands/node.create/), [`text.create`](/kits/design/commands/text.create/) and
  [`node.set`](/kits/design/commands/node.set/) are **relative to the parent frame** (groups don't count).
  [`select.area`](/kits/design/commands/select.area/), a preview's `area` and its `bounds` are in **page
  coordinates**. `rotation` is in degrees, `opacity` runs from 0 to 1.
- **Stacking.** A parent stores its children bottom first: `index` 0 (as
  [`node.reorder`](/kits/design/commands/node.reorder/) and [`node.reparent`](/kits/design/commands/node.reparent/)
  take it) is the bottom, except in an auto layout frame with `reverseZ` (canvas stacking: first on
  top), where the first child paints on top. A listing of layers (`part.layers`, `page.inspect`)
  shows the topmost first, as the Layers panel does, and gives each layer's `index` and `z`, its
  place in paint order counted from 0 at the bottom: trust `z` for what covers what.
- Colours are `#rrggbb` (or `#rrggbbaa`); `fill: "none"` removes the fill.

## What a call changed, and what others changed

- **Receipts.** A successful `design_run` or `design_batch` answers `changes`: `created`, `changed`
  (with `edits`, each field `before` and `after`), `moved` and `deleted`, naming layers by their
  ids. Edits use leaf paths: text is `kind.characters`, colour channels can be
  `fills.0.color.r`, and translation can be `frame.transform.4`. A
  move to another parent or place is in `moved` (`from` and `to`: the parent's id and the index);
  deleting a frame lists it and every layer in it; an edit of a component's layer lists that layer
  and each instance's copy of it. `diagnostics: {new, resolved}` says what the check found new.
  Large sets can use `footprint` to list ids sharing the same delta; it is not truncation.
  Moving a parent reports `carried` descendants because their world positions change without
  changing their local registers; a parent rename or sibling reorder does not report a carry.
- **Pass the latest `revision` as `basis`.** Every answer of inspect, query, run and batch has a
  short `revision`. Pass the last one you were given as `basis` on your next call: the answer then
  says what others (people, other agents) changed since, in `others` (with `by`).
- **A `conflict`** (retryable) means others changed a fact your write holds since your `basis`: it
  was `deleted`, `relocated` (moved to another parent or place) or `changed`, or the change cannot
  be told object by object (`unknown`). Nothing was run. Read `others` and `conflicts`, inspect
  again if you need to, decide again, and send the call with the `revision` the refusal gives as
  `basis`. Do not undo others' changes. Your own earlier edits never refuse your write. The guard
  knows a step's objects from `on`, `targets`, `objects`, typed name parameters and per-call
  premises. A marked scalar `id` works as well as `ids`.

## What each write holds

The default guard is `premise`. `epoch` refuses any intervening outside change; `off` disables
these refusals. A successful unrelated edit is still reported in `others`. Do not treat a
successful write as proof that the entire document stayed unchanged.

| Write | Facts held against the observed file |
|---|---|
| `node.set` with recognised property keys | The written registers or leaf paths, including bindings when the setter changes them. Name alone holds only `name`; geometry also holds transforms, constraints and layout dependencies. Unknown properties keep the SDK's conservative target-wide default. |
| `object.rename`, `object.batchRename`, `object.toggleLock` | Name or lock; batch rename also holds ordering. |
| `transform.move` | Local transform, ancestor transforms and hierarchy; group/auto-layout geometry when recomputation reads it. |
| Move-to, rotate, resize, scale, align, distribute, tidy, spacing and packing | Target geometry, constraints, layout and ancestors; group/auto-layout descendants. Resize holds the subtree; scale holds its style data too. |
| Indexed fill/stroke/effect set or remove | Selected list item and bindings; removal conservatively holds the list. |
| `node.reparent`, `node.reorder`, `page.move` | Source/destination placement and the index window, including current occupants. Reparent also remembers destination prefix children so insertion before the address is detected. |
| Component/variant and instance operations | Source/target dependency graphs, nested mains, variant sets, instance-swap defaults (including deleted defaults) and supplied preferred references. Property rename/delete also holds instance property values and bindings. |
| `instance.place`, `instance.swapAt`, `library.place`, `library.swapAt` | The engine's actual drop/pick, consumed source/target subtrees and parent placement. `covers` replays the shared resolver against known previous facts, including a library placement's default view point and reused local main. |
| `tool.place` with `tool` or coordinates | The pointer-down parent pick (the click-sized shape's top-left corner), parent geometry/layout and the geometry/order of siblings a frame or section encloses. Unrelated opacity edits apply. |
| Connector creation/reattachment | Object endpoints and their transforms, including existing endpoints on reattachment. Coordinate endpoints remain coordinates. |
| `style.update` | Written style fields, with typed name resolution. |
| Prototype/variable values | Referenced destinations, aliases and parsed expression variable/mode objects; resource alias chains and default-mode order. Dynamic expression names are replayed against previous names. |
| Text formatting, search/replace, layout, boolean/flatten/outline and page duplicate/delete | Traversed text or layer subtrees, membership and consumed geometry. Text ranges conservatively hold whole text records. |
| Annotation categories and image presets | The saved record selected by id/name; category creation/removal conservatively holds the category list. Comment message indexes hold their thread's body/order. |
| Version restore | Version metadata and snapshot fingerprints, plus the current design it replaces. File comments are retained. Version-label edits hold metadata separately. |
| `library.publish` | Publishable identities, previous publication manifest and content fingerprint, component dependency graphs, styles, collections and variables. |
| `library.acceptUpdates`, `library.swap`, `library.remove` | Local copy records, library links, component copies and instance inputs, style/variable definitions and the reference/alias membership query used by pruning. This is conservative across libraries. |
| `branch.merge`, `branch.updateFromMain` | Branch metadata, snapshot/history fingerprints including image bytes, main nodes and main resources/settings. Conservative across the main file; publication-only changes are independent. |
| Paste, repeated `edit.duplicate` | Copied mains and instance mains, clipboard style/variable ids and the paste parent; foreign pastes also adopt library records. A repeat without `dx`/`dy` holds the last sources and copies. |
| `command.batch` | Each step's resolved inputs in execution order, selection and clipboard prefixes, nested reference scopes and query fields consumed by a later write. Unknown query-result provenance conservatively holds the document. Replay has no filesystem or live replica. |
| `data.fill`, `variable.import` | The source subtree and its component graph (layers are matched by name); import name/type eligibility, matching collections/modes/variables, aliases and default values copied into new modes. The import name-membership hold remains broader than necessary. |
| Ready for dev, `dev.resolveChange`, code connect | The subtree a mark or resolution blesses; the owning component set or main of a link; name-keyed owner membership for `codeConnect.import`. |
| `board.tableEdit`, `board.vote`, `board.timer` | Table dimensions, row/cell addresses and retained row appearance; deleting a row or column does not read its text. Vote and timer settings. |
| `board.reattach` | The connector record and endpoint geometry, including when addressed through its label. |
| Vector edit mode, shape builder, widgets | Conversion holds source geometry including boolean operands. Network edits hold the network and only consumed geometry; empty-layer cleanup tests the network and holds reflow/comment inputs. Shape builder holds expanded group membership, arrangement geometry and the actual appearance sources, including stroke remainders. Widget handlers remain unexercised without an installed plugin. |
| Tool switches | While pen or vector editing is active, switches declare writes and hold the layers consumed by cleanup. An inactive switch only changes the tool. |
| `variable.update`, `variable.bind`, dev resources, `text.refit` | Variable metadata holds written fields and validation inputs. Binding holds evaluated values/alias definitions and the destination field/modes. Dev resources hold the link list and instance-validity inputs. A refit without `ids` holds text across the document, rather than the selection. |

`~bounds` is derived local painted geometry, including stroke/effects but before ancestor
transforms. `~hierarchy` is derived parent, sibling index and child count. These are facts for
the guard, not stored fields to set. Auto layout and group geometry hold the affected subtree,
not every layer of the page. Lent library contents are outside this document's revision.

**Propagation.** A write the engine propagates (a style or variable value to its users, a
component's layer to its instances' copies, an auto layout child's size to its siblings and
parent, a frame's size to constrained children) holds what it reads to compute the result: the
style or variable and its alias chain, the main's layer, the parent's layout, the children's
constraints. The layers it updates are consequences, not premises: others' unrelated edits on them
do not refuse the write, and the receipt's `changed` names each one with its edits.

The independent handler reading covers 372/372 write handlers: edit/object/data/batch 42,
layout/create/transform 46, text 44, vector/boolean 42, components/libraries 38,
paint/resources 57, file/prototype/dev 60 and tools/board 43. Four paths are pinned explicitly:
text creation, nested batch, batch selection prefix and batch query-result dataflow. Four widget
commands cannot execute without a plugin the kit cannot install; 368 commands are compared. One
colour profile conversion path is compared statically because library copies disable it on the
fixture. The comparison gate is 0 held-less and at most 12 held-more commands. The excess holds
are import name membership, page-window occupant positions, prototype literal-mode reference
replay, painted-bound facts in five spatial commands, reflow inputs three text commands hold even
when they change no text, and the unread current subtree in Dev Mode resolution. Prototype replay
retains conservative reference fields.
This comparison does not prove all combinations or SDK behavior. Propagation is scenario-tested
for styles, variables and component copies. A 300-cell constraint
matrix covers all 25 horizontal/vertical pairs, outside parent growth or adding horizontal auto
layout, and resizing through `node.set` by id, `node.set` with `on`, or `transform.resize`, each
with an unrelated-parent control. It has no wrong writes or false refusals.
Other normalisation combinations are not proven. Vector edit begin/end are declared as
writes, including conversion and removal of empty layers. A `tool.place` call with none of
`tool`, `x`, `y` does not activate spatial replay; the guard plans a run's prefix on an isolated
copy of the design, so `waiting_for_sdk_tool_place_without_place_parameters` (an outside writer
and a tool-setting prefix) is refused as `relocated` and nothing is written.
The 288-cell address matrix covers eight forms, twelve outside changes, and the target plus
preceding/following siblings. At the pinned SDK `waiting_for_sdk_address_matrix` has no missed
refusals, six false refusals and three reason mismatches. The false refusals involve tree
insertion windows (deletion or removal of the occupant at the insertion index, which leaves the
insertion between the same survivors, and a main component change), a main component's unused
page translation and adding a style binding when the previous bindings register was null. The
reason mismatches are point swaps whose instance was deleted, detached or swapped to a smaller
main that still covers the point: `relocated` is reported instead of `deleted`, `changed`,
`changed`. **Linked library files are outside this file's revision:** when only a
library file changed between your `basis` and your write, the guard has no change to weigh and
answers nothing; a write that reads the library (`library.acceptUpdates`, `library.swap`,
`library.place`, `library.import`, applying or binding a library style or variable) applies
the library as it is at write time, even updates you never saw. Read `library.updates` in the
same run as the write, and check the receipt, which names every copy and layer it changed.
A deleted subtree or unknown prior geometry at a pick is refused conservatively. JSON list
changes can refuse more than the selected item needs, and the SDK's nested position matching currently makes parent-transform
holds include the whole `frame`, so a parent size change can refuse a child move. Reinspect and
decide again after such a refusal. Do not rely on the guard to validate intent in these gaps.

## Workflow

1. `design_inspect` for the pages, then `design_inspect {target: {"pageId": id}}` for a page's layers
   (or `design_query {follow: "nodes", fields: ["key", "name", "kind", "frame"]}` for every layer).
2. Find the command: `design_commands {path, query}` with keywords. Use the exact id it returns and
   follow its parameter schema; never guess a command id.
3. `design_run` a few steps at a time, naming pages with `target`/`at` and layers with `on` or `ids`;
   pass the last `revision` as `basis`. Read `changes`.
4. `design_check`, then fix what it reports. Preview a diagnostic's `target` with `design_inspect` to see
   what it is about.
5. `design_inspect` with `preview: true` and a `target` to look at the result, and `design_export` when
   the person wants an image or a PDF.

## Common tasks

- [`node.set`](/kits/design/commands/node.set/) `{ids, props}` changes any property: name, position,
  size, fills, strokes, corner radius, opacity, padding …
- [`layout.add`](/kits/design/commands/layout.add/) `{ids, direction}` gives a frame auto layout; the
  frame then arranges its children.
- [`arrange.roundToPixels`](/kits/design/commands/arrange.roundToPixels/) `{ids}` puts layers on whole
  pixels.

## Example 1: a button with auto layout

`design_inspect {target: {"pageId": 1}}` lists `Frame 1` with id 2. Make the button frame inside it,
then its label:

```json
design_run {"path": "app.kdesign", "basis": "qx7a", "steps": [
  {"command": "node.create", "params": {"type": "frame", "parent": 2, "x": 40, "y": 280, "width": 160, "height": 44,
    "name": "Button", "props": {"fill": "#5645D4", "cornerRadius": 8}}}
]}
```

It answers `{"id": 6368281153765377}`, a receipt whose `created` lists it, and a new `revision`.
Then, by its id:

```json
design_run {"path": "app.kdesign", "basis": "r2kd", "steps": [
  {"command": "text.create", "params": {"text": "Get started", "x": 0, "y": 0, "parent": 6368281153765377,
    "props": {"fontSize": 16, "fill": "#FFFFFF"}}},
  {"command": "layout.add", "on": [6368281153765377], "params": {"direction": "horizontal"}},
  {"command": "node.set", "on": [6368281153765377],
    "params": {"props": {"paddingLeft": 24, "paddingRight": 24, "paddingTop": 12, "paddingBottom": 12}}}
]}
design_check {"path": "app.kdesign"}
```

All three steps answer `"changed": true`, and the check finds nothing wrong.

## Example 2: two pages in one run, without going to either

The design opens on `Home` (id 1). `design_inspect` lists the page `Pricing` with id 7, and
`design_inspect {target: {"pageId": 7}}` lists its frame `Plan` with id 9. Fill `Plan`, add a badge
to it, and rename the rectangle `Box` (id 3) on `Home`:

```json
design_run {"path": "app.kdesign", "basis": "m4c1", "target": {"pageId": 7}, "steps": [
  {"command": "node.set", "on": [9], "params": {"props": {"fill": "#FF0000"}}},
  {"command": "node.create", "params": {"type": "ellipse", "parent": 9, "x": 280, "y": 8, "width": 24, "height": 24, "name": "Badge"}},
  {"command": "arrange.roundToPixels"},
  {"command": "node.set", "at": {"part": {"pageId": 1}}, "params": {"ids": [3], "props": {"name": "Hero"}}}
]}
design_inspect {"path": "app.kdesign", "target": {"pageId": 7}, "preview": true}
```

The second step's badge is the selection for the third, which acts on it. The receipt names `9`,
the new badge and `3`; the person is still on `Home` when the call ends, and the saved file opens
there. The preview draws `Pricing`.

## Example 3: fix what the check reports, restyle, export

```json
design_check {"path": "icons.kdesign"}
```

It answers a note: `"Rectangle" is at 40.5, 40.25 and 120 x 80.5, not on whole pixels`, with target
`{"page": 1, "path": "layer:3"}` and fix `{"command": "arrange.roundToPixels", "params": {"ids": [3]}}`.

```json
design_run {"path": "icons.kdesign", "steps": [
  {"command": "arrange.roundToPixels", "params": {"ids": [3]}},
  {"command": "node.set", "params": {"ids": [3], "props": {"fill": "#5645D4", "cornerRadius": 12}}}
]}
design_check {"path": "icons.kdesign"}
design_export {"path": "icons.kdesign", "to": "icons.png", "format": "png"}
```

The check then finds nothing wrong, and the export answers the new file it wrote
(`{"files": [{"created": true, "path": "icons.png"}]}`).

## Pitfalls

- **Navigation is for the person.** `select.*`, `page.select`, `page.go` and `view.*` move the
  editor; an agent names pages with `target`/`at` and layers with `on` or `ids` instead.
- **Auto layout arranges the children.** After [`layout.add`](/kits/design/commands/layout.add/), set
  padding and gap on the frame ([`node.set`](/kits/design/commands/node.set/)
  `{props: {padding, gap, mainAlign, crossAlign}}`, where `padding` is a number or
  `[top, right, bottom, left]`) rather than moving the children.
- **Flattening makes a new layer.** [`vector.flatten`](/kits/design/commands/vector.flatten/) answers
  the new layer's id; the old id is gone.
- **Many commands answer only `{"ok": true}`**: read the receipt (`changes`) for what they did.

## Checks

`design_check` lists what is wrong with the design. Each diagnostic has a stable `code`, a `severity`
(`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a command step to
run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it only when it is
what the person asked for. Every code the kit reports is on the [checks page](/kits/design/checks/).

The check reports text that overflows or is cut, layers off whole pixels or outside their clip, low
contrast, missing components, images, styles or variables, empty frames, and broken prototype
links.

- `design.text-overflow` (warning) and `design.text-ellipsis` (info): text in a fixed-size box that is too
  small. Give the box room, or put it in an auto-layout frame that hugs its content.
- `design.off-pixel` (info): a layer at a fractional position. Its `fix` is
  [`arrange.roundToPixels`](/kits/design/commands/arrange.roundToPixels/) `{ids}`.

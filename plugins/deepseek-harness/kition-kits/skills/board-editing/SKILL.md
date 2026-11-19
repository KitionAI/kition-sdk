---
name: board-editing
description: "Create, inspect, edit and check a board (.kboard) with the Kition Board kit's tools: shapes, sticky notes, text, connectors, frames, mind maps, templates, layout, pages, and more; `element.create` adds elements. Use when the user asks to make, read, change, review or fix .kboard files in this project."
---

<!-- Generated from kition-board agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`board_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`board_run` is `mcp__kition__kit_run`, `board_check` is `mcp__kition__kit_check`).
They load on demand: before the first call, add the ones you need with
`mcp__kition__load_tools`, for example `{"tools": ["kit_inspect", "kit_commands", "kit_run", "kit_check"]}`.
With KITION_KITS_UNIFIED=false they are `mcp__kition__board_<action>`. Paths are relative to the
workspace folder.

# Board kit

The Board kit opens, edits and checks whiteboards (`.kboard`): pages of shapes, sticky notes, text,
connectors, frames, mind maps, pictures and cards that point at other files. An agent can add and
connect elements, group them in frames, build and lay out mind maps, manage pages, and check the
board for disconnected flow nodes, elements outside their frame, overlaps, overflowing labels and
broken cards and pictures.

## Tools

The kit's prefix is `board`. Its tools are:

| Tool | Does |
|---|---|
| `board_inspect` | The board as JSON (its pages with their ids and element counts), with a preview |
| `board_query` | Reads elements by id, or by following fields: `follow: "pages.0.elements"` reads the first page's elements, with `fields` such as `kind`, `text`, `position`, `size`, `parent`, `shapeStyle`, `start`, `end` |
| `board_commands` | Finds commands by keywords (`element`, `connector`, `frame`, `mindmap`, `layout`, `page`), each with its parameter schema; at most 12 answers |
| `board_run` | Runs 1 to 50 command steps `{command, params}` in order |
| `board_batch` | Runs one batch of object-model operations that set fields (ids from `board_query`) |
| `board_check` | What is wrong with the board, as diagnostics |
| `board_create` | Makes a new, empty `.kboard` board |
| `board_export` | Writes a page (`options.page`, by id) to a new PNG, SVG or PDF file |
| `board_draft_ready`, `board_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the board's path in the workspace. With `draft: true` your edits go to
your draft of the board and leave the file as it is; only the person merges or discards a draft.
`board_export {path, to, format, options: {page}}` writes the page `page` names (its id), framed
to its content, to a new `png`, `svg` or `pdf` file and leaves the board as it is; it never
replaces a file. Without `page` it writes the page an editor shows, which is not yours to know:
name it.

## Addressing and coordinates

- Coordinates are **board units**, with `x` growing right and `y` growing **down**. An element's
  `position` is its top-left corner, and `size` is `[width, height]` in board units.
- A board made at a size (`board_create`, 1920 × 1080 by default) is that **document** from
  (0, 0): previews and thumbnails show exactly it while everything stays inside, and grow only on a
  side something goes past. `board_inspect`'s `area` is what they show.
- **One id for everything.** Pages and elements have one id each, a UUID string, that
  `board_inspect` (pages: `details.pages[].id`), `board_query`, `board_batch`, every command, a
  step's `on` and every receipt use alike, and the file keeps: an id from an earlier call names the
  same page or element after a rename, a move, a save and a reopen. Get element ids from
  `board_query` or from a command's answer: [`element.create`](/kits/board/commands/element.create/)
  answers `{"created": [id, …]}` in the order you gave the elements.
- **Pages:** `board_inspect` lists each page as `{"id", "name", "elements", "area"}`; `area` is the
  page's document area (`x`, `y`, `width`, `height` in board units), what a preview of the page
  shows. Commands' `page` parameter, a run's `target` and a step's `at.part` take the page's
  **UUID** (`{"page": "<id>"}`), as `details.pages[].id` lists it. Use that stable address.
  Diagnostics also give a page ordinal from 1; the renderer accepts that ordinal. List
  positions in `board_query`'s `follow` (`pages.0.elements`) count from **0**.
- Page names and element authoring `key`s are labels, never addresses. There is no name or
  `#index` alias for a UUID. The Board root is `board` (`root` in batch targets). Numeric
  coordinates, counts and page insertion indexes do not name objects.
- A connector's `anchor` is `[x, y]` on the element's box, each from 0 to 1: `[0, 0.5]` is the
  middle of the left edge, `[1, 0.5]` the middle of the right edge.
- **Sticky notes, flow-chart nodes and mind-map nodes are shapes** with a `shapeStyle`: `sticky`,
  `flow-node`, `mind-node`. There is no element kind `sticky`.
- A shape belongs to a frame through `parent` (the frame's id). Moving the frame moves it.
- A `line` shape runs along its box's longer side, through its middle: give it a tall box for a
  vertical line; `rotation` turns it. A freehand `stroke` takes `dashStyle` as shapes do.
- Text is plain unless marked: [`text.mark`](/kits/board/commands/text.mark/) makes a range bold or
  italic, and a text or sticky with `textFormat: "markdown"` draws its Markdown (headings, lists,
  quotes, `**bold**`, `*italic*`, `` `code` ``, links) without the markers.

## Where a step acts: `target`, `at` and `on`

Nothing a call does depends on, or leaves behind, the page an editor shows: name the page and the
elements every time, with the ids earlier answers gave you.

- A `board_run` step is `{command, params?, on?, at?}`. The run's `target` (`{"page": "<id>"}`) is the
  page every step acts on; a step's `at.part` (`{"page": "<id>"}`) overrides it for that step. A
  command's own `page` parameter (an id) names its page too.
- `on` names the **elements** a step acts on, by id (`["01a18a90-…"]`). It goes into the command's
  element parameter (`id`, `ids`, `groupIds`, `node` or `root`: `board_commands` with `detail`
  marks it as the command's `targets`); do not give that parameter as well. A command with one
  `id` takes one `on` item. A board has no selection, so a command without such a parameter
  (`page.rename`, `frame.create`, `connector.create`) takes no `on`: give its ids in its
  parameters.
- The commands that make content (`element.create`, `frame.create`, `stroke.create`,
  `connector.create`, `template.insert`, `card.create`, `image.insert`, `element.paste`) and
  `file.export` act on the run's page (`target`, `at.part`) or their `page`; without either, on the
  page an editor shows. Name the page.
- A command never changes the page an editor shows, also when it fails, except `page.activate` and
  `page.create` with `"activate": true`: after them, the later steps of the same run that name no
  page land on that page ("make a page, then fill it"). After the call the editor is as it was: the
  next call starts again from the person's page.
- Element ids name their page: a step on elements needs no `target`.

## Previews of a named view

`board_inspect` with `"preview": true` draws `target`: `{"page": "<id>"}` for that page's
document area, `{"frame": "<id>"}` for a frame's box, `{"objectId": "<id>"}` for an element with
a margin of 16 units, or `{"page": "<id>", "area": [x0, y0, x1, y1]}` for a box of the page in board
units (one of `frame`, `objectId` and `area`). Without `target` it draws the **first page's**
document area, never the page an editor shows. `scale` (pixels per board unit, at most 4; 1 by
default) and `maxSize` (the longest side in pixels) set its size, and `preview` in the answer says
what was drawn (`page`, `area`, `scale`). A diagnostic's `target` previews what it is about. The
same call answers the same picture, and drawing it changes nothing.

## What a call changed, and what others changed

- **Receipts.** A successful `board_run` or `board_batch` answers `changes`: `created`, `changed`
  (each with `edits`: a field, `before` and `after`), `moved` and `deleted`, naming pages and
  elements by their ids, plus `diagnostics: {new, resolved}`. It tells everything that changed, not
  only what the command answered: deleting a shape lists the connectors whose end it freed (their
  `start.binding` or `end.binding` before and after), and deleting a frame lists what it held.
  Derived facts are named with `~`; changing an owned list can also list its holder's derived facts.
- **Pass the latest `revision` as `basis`.** Every answer of inspect, query, run and batch has a
  short `revision`. Pass the last one you were given as `basis` on your next call: the answer then
  says what others (people, other agents) changed since, in `others` (with `by`).
- **A `conflict`** (retryable) means others invalidated a declared premise since your `basis`:
  `deleted`, `relocated`, `changed`, or `unknown` when the old fact cannot be recovered.
  Nothing was run. Read `others` and
  `conflicts`, look again if you need to, decide again, and send the call with the `revision` the
  refusal gives as `basis`. Do not undo others' changes. Your own earlier edits never refuse your
  write. A change outside the declared facts is reported and the write applies.

## What each write holds

Each of the 43 write commands' handlers has an independent reading, made by readers who did not
see these declarations: element, frame and stroke commands 16, connectors, cards, pictures,
templates and the clipboard 12, layout, mind maps and pages 13, `edit.undo` and `edit.redo` 2.
`bindings/wasm/tests/declarations_independent.rs` holds one row per code path and compares it
with what the guard holds. Every object parameter is typed as Page or Element, including
`elements[].parent`, `set.parent`, connector `from.element` / `to.element`, and a pasted
payload's `elements[].ref` and its ends' `binding.target`. A point inside an endpoint
specification is geometry, not an object id. The full editor-state list is `/page`, `/area`;
eight creation commands and `file.export` declare `reads: [Part]`. No command reads the person's
selection or viewport. The agent must name the page explicitly where required.

| Commands | What the write rests on |
|---|---|
| `element.style`, `element.update` | The fields supplied, plus kind and lock. A new parent: its kind (and, for a frame or group given a parent, its page's hierarchy: it must not be inside it); a key: key uniqueness. |
| `element.setText`, `text.mark`, `connector.setLabel` | Text, kind and lock; label position only when supplied. |
| `connector.setWaypoints`, `card.setTarget`, `image.setAlt`, `element.lock` | The replaced value (waypoints, card, alt, locked), kind and lock. |
| `element.move` by delta | The subtree's positions, free endpoints and points, kinds and locks; a carried member's `parent`. A lone element's container is not read (coordinates are world coordinates). Several selected leaves need no parents either; when a selected container can carry another selection, their ancestry determines the roots. A container's move holds its page's hierarchy. |
| Move `to`, resize, rotate, align, distribute, stack | Above, plus the selected roots' `~bounds` (a group's members', a connector's ends and their targets). A selected child carried by a selected frame does not independently set its alignment delta. Resize writes position and size (a text's font size when several scale); one box resized holds its box and lock only (what it holds stays where it is, so a locked child does not refuse it). Rotation about each element's own centre holds its rotation (a stroke's points, a connector's route), not where it is; a group or frame turns as one about its own centre, holding its members' boxes and bounds; about the selection, the bounds, position and size. Frames and cards have no rotation: they only move. Arranging leaves out a connector bound at both ends without bends (it follows its elements). |
| Move with `reparent: true` | Above, plus each root's parent and that parent's kind, and the frame under each destination centre: `covers`/`covered` replay the same smallest-frame query execution uses (a destination frame's own fields are not read). This is the Board's point-addressed write; there is no general pick command. |
| `connector.create`, `connector.bind` | An end element's `~bounds`, position and rotation (the edge an end faces turns with it); bind: the connector's lock, the end replaced and the other end (its binding, and without an anchor its target's box). |
| `element.group`, `frame.create` | Members' kind, lock and parent, and their ancestors' (which are roots, the common parent). They do not hold the global structure. Where the new group or frame goes in the list follows its first member. |
| `element.delete`, `element.duplicate`, `clipboard.copy` | Every field of each element and of what it holds; the board's structure for a container. |
| `element.ungroup` | Every field of the group (it goes), its members' lock and `parent` (written), its page's hierarchy. A locked member refuses ungrouping. |
| `frame.fit` | The frame's box and lock, its direct members' bounds and parents, its page's hierarchy. |
| `element.reorder` | `front`/`back`: that each element is there (several: their order among themselves). `forward`/`backward`: each element's index and the neighbour it passes (a window of two). A container moves with what it holds: its members' places and parents, and its page's hierarchy. |
| `page.rename` | Page name only; list position is irrelevant. |
| `page.create`, `page.move` | Explicit insertion/destination gaps in the list before source removal; one step (`placement`) holds the page and the neighbour it passes; default page naming holds the page count. See the deletion-location defect below. |
| `page.delete`, `page.duplicate` | The page's element list (and name, for a delete and a copy named by default) and every field of each element on it. |
| `layout.mindmap`, `mindmap.*` | Every map node's shape style, box, rotation, direction, collapse, side, stroke and lock; every branch's lock and its overwritten ends and settings; the board's map structure (effective topology and branch order, without containment). addChild/addSibling also hold the container of the node the new branch is copied from. Unrelated node text with a fixed box can change. |
| `links.retarget` | Matching workspace target paths, replayed card by card; card view metadata may change independently. |
| `element.paste` | The destination page; without `at`, each payload ref naming an element of this board (a live source on the page offsets the copies); each connector end bound to an element outside the payload, by its box and rotation. With `at`, source refs are not read or held: deletion of the copied source can merge with a paste at the explicit position. |
| Create, template, stroke, card, image | Destination existence, a referenced parent's kind, key uniqueness where used; content geometry for default placement. |
| `edit.undo`, `edit.redo` | Nothing: the step undone or redone is the caller's own; another writer's later change of the same object is not checked. The pinned kition-sdk cannot say which objects a scope's next step touches (`waiting_for_sdk_…` in `bindings/wasm/tests/undo_premises.rs`). In the headless file path an agent's history does not outlive its call. |

A command refuses (`locked`) when it would write a locked element, and then writes nothing:
deleting a frame, group or page that holds one, a mind-map command whose map has a locked node
or branch, moving, turning or scaling something that holds one. Resizing one box writes that box
only. Bound connector ends are derived and follow their elements even when the connector is
locked; deleting an element frees the ends bound to it, a locked connector's too. Within an
already resolved engine call, deleting its page refuses a later creation there (`not-found`).
Across independently rewritten files the SDK can drift an implicit page context, even with
`basis`; the page-context matrix below retains that failure. Name the page by UUID.

The Board has no components, instances, constraints or persistent auto-layout containers.
Layout commands name their siblings explicitly. Other command families retain the SDK's
conservative default when the kit states no premise.

`~bounds` is an element's own bounds, null for groups and connectors; transform premises
expand their geometry dependencies explicitly. `~frame` is its unrotated frame rectangle.
Page `~hierarchy` fingerprints its sorted parent links, without stacking or connector bindings;
Page `~geometry` is its content bounds, so default placement does not hold another page;
`~mapStructure` fingerprints map nodes and ordered effective branches, without containment.
Root facts `~structure`, `~keys`, `~mapStructure`, `~frameOrder`, `~pageCount` summarise what the root owns. `~link` is an element's
workspace card target path, or null. Moves write children's world
coordinates into the replica, so receipts list stored child changes; `carried` is empty because
there are no unrecorded child transforms to claim. Native values are f64; no file quantisation
is required. Representative command receipts and saved-file diffs agree on all 18 fixtures.

## Guard limits

- The mixed table (seed `0x9e3779b97f4a7c15`, measured on kition-sdk `33b14be`) is 155 applied,
  45 necessary refusals, 0 false refusals, 0 wrong writes and 0 kit failures; insertion and move
  changes before empty page gaps refuse as they should.
- An SDK reread loses the list positions of unnamed deletions. Observe named pages A, B,
  C, D, E; another writer deletes A; a stale `page.create {name:"Agent",at:1}` applies after B
  instead of holding the observed gap between A and B. A stale `page.move {page:C,to:1}` also
  applies at the wrong destination. `gaps12` keeps these failing scenarios; insertion,
  removal and movement strictly after the destination gap pass. The kit's empty
  window declaration follows the SDK adoption contract. Reobserve before indexed writes
  after deletions, or use epoch mode.
- Root structure ignores isolated objects, and key premises are omitted for unkeyed creation
  and commands that drop keys. Key fingerprints ignore element stacking order. An unrelated
  hierarchy change on the same page can refuse a container command; topology changes
  in another map can refuse a mind-map edit; an unrelated key can refuse keyed
  creation. Matching card paths are replayed card by card, so unrelated
  cards and view metadata do not refuse retargeting.
- Observed frame rectangles and root frame order replay equal-area picks after reorder or
  deletion. Values omitted by the SDK's small-value budget keep ambiguous ties conservative.
  A deleted frame whose page cannot be found is considered conservatively.
- Numeric and implicit page contexts can drift after an earlier page insertion, deletion or
  reorder; raw model `list.move` can miss a changed index occupant. The matrices keep
  these wrong writes as failing `waiting_for_sdk_*` tests.
- Undo and redo hold nothing (above). The independent reading runs all 83 rows on both
  flat and nested boards, including sizeless text, cross-container bindings and locked members.
- The guard checks declared facts, not the agent's entire intention. It does not infer that a
  styling decision depends on text, appearance, an external file's contents or rendered pixels.
  Reobserve when the decision depends on those facts. Batches hold the paths they write; prefer
  engine commands for the Board's domain checks and gestures.

### Address and derived-result matrices

`bindings/headless/tests/matrix3.rs` declares necessity before each matrix's first execution.
A = apply, C = `changed`, R = `relocated`, D = `deleted`. Refuse exactly when the colleague
changes the observed occupant of a positional address or an input to the write's result.
Each cell opens a separate writer that really replaces the `.kboard` file between observation
and the guarded call. Every refusal preserves the colleague's bytes. Every apply compares the
entire saved replica with the command executed on the colleague's saved board, using the same
shipped fonts and normalizing only newly generated UUIDs. This is a merge oracle for the guard;
it is not an independent implementation of the command's geometry algorithm.

The ten columns, in order, are fill/restyle, text, delete, move, resize, rotate, reorder to
front, reparent out, reparent in, lock. Four strings per row refer to C (the frame's shape
child), F (its frame), S (its sizeless text sibling), U (an unrelated shape on another page).
These roles are fixed objects, not aliases for every row's target. Actual group members and
map nodes, named group/node targets, content-extreme contributors and point entrants have
their own supplemental matrices below. Some operations are no-ops on a fixed role (for
example, reparenting an already root element out); those are apply controls.

```text
Address row       C          F          S          U
id-fill           CADAAAAAAC AADAAAAAAA AAAAAAAAAA AAAAAAAAAA
id-delta          AADRRAAAAC AADRARAAAA AAAAAAAAAA AAAAAAAAAA
frame-child       AAAAAAAAAA AADAAAAAAA AAAAAAAAAA AAAAAAAAAA
group-child       AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
bound-end         AADAAAAAAA AADAAAAAAA AAAAAAAAAA AAAAAAAAAA
mind-node         AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
page-id           AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
page-index        AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
active-page       AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
paste-ref         AADAAAAAAA AADAAAAAAA AAAAAAAAAA AAAAAAAAAA
paste-at          AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
point-frame       AAAAAAAAAA AARARAAAAA AAAAAAAAAA AAAAAAAAAA

Derived row       C          F          S          U
align             AADRRCAAAC AADRARAAAA AAAAAAAAAA AAAAAAAAAA
distribute        AADRRCAAAC AADRARAAAA AAAAAAAAAA AAAAAAAAAA
stack             AADRRCAAAC AADRARAAAA AAAAAAAAAA AAAAAAAAAA
fit               AADRRCARRA AADRRRAAAC ACDRRCARRA AAAAAAAAAA
connect           AADRRCAAAA AADRARAAAA AAAAAAAAAA AAAAAAAAAA
route             AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
group             AADAAAARRC AADAAAAAAA AADAAAARRC AAAAAAAAAA
ungroup           AAAAAAAARA AAAAAAAARA AAAAAAAARA AAAAAAAAAA
forward           AADAAARAAA AADAAARAAA AADAAARAAA AAAAAAAAAA
front             AADAAAAAAA AADAAAAAAA AAAAAAAAAA AAAAAAAAAA
card-auto         AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
card-fixed        AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
text-measure      AAAAAAAAAA AADAAAAAAA ACDAAAAAAC AAAAAAAAAA
font-measure      AAAAAAAAAA AADAAAAAAA AADAAAAAAC AAAAAAAAAA
map-layout        AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
map-child         AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA AAAAAAAAAA
frame-scale       AADRRAARRC AADRRRAAAC AADRRAARRC AAAAAAAAAA
```

The page matrix adds nine columns: insert before, delete before, move before, insert after,
delete after, move after, rename target, delete target, move target. The target page is the
second page for UUID/numeric addressing; the implicit page is the first. Numeric context
uses the SDK's accepted `target: {page: 2}` form, not an engine UUID parameter.

```text
page-id           AAAAAAADA
page-index        RRRAAAARR
active-page       RDRAAAAAA
page-gap          RRRAAAARR
```

Raw `list.move` of C to observed index 5 uses C/F/S/U strings
`AADAAARAAA AADAAARAAA AARAAARAAA AAAAAAAAAA` (40 cells). It names the source and destination
by list position. Six deletion/reorder cells wrongly apply even when the resulting file equals
executing against the latest list: necessity also protects what the observed index named.

The own-dependency supplement applies the ten columns to a real group member or map node,
then to U (all `AAAAAAAAAA`), 140 cells:

```text
group-delta       group member  AADRRAARRC
ungroup           group member  AADAAAARRC
map-layout        map node      AADRRCAAAC
map-child-node    map node      AADRRCAARC
map-sibling       map node      AADRRCAAAC
map-collapse      map node      AADRRCAAAC
map-direction     map node      AADRRCAAAC
```

Collapse has an actual grandchild to hide. Automatic/fixed image placement adds 80 cells
(ten columns x C/F/S/U, all A). Direct named-parent controls add eight valid group cells
(`AADAAAAAAA`, excluding unsupported group fill/text), and direct node styling adds ten
(`CADAAAAAAC`). Automatic card/image placement each adds ten changes to a shape at
`[5000,-500]` that sets the content extremes (`AADRRCAAAA`). Finally a shape or a smaller
frame moves from outside into the destination point: shape A, frame R. Board has no
general point hit-test or region-selected write; its point address is destination-frame picking.
No region matrix or unsupported shape-pick command is claimed.

W/F/R below mean wrong writes / false refusals / wrong reasons (a necessary refusal that names
the wrong reason).

| Matrix | Cells | W/F/R |
|---|---:|---:|
| Address base | 480 | 0/3/0 |
| Page contexts/gaps | 36 | 9/0/0 |
| Raw z-index | 40 | 6/0/0 |
| Named group/node and point entrants | 20 | 0/0/0 |
| Derived base | 680 | 0/19/12 |
| Own dependencies | 140 | 0/0/7 |
| Image placement | 80 | 0/0/0 |
| Card/image content extremes | 20 | 0/0/6 |
| **Total** | **1496** | **15/22/25** |

Address totals: 576 cells, 15/3/0. Derived totals: 920 cells, 0/19/25. The passing partition has
1,434 cells: 1,294 apply with the saved merge, 140 necessarily refuse, with zero wrong writes,
false refusals, wrong reasons or command errors. The other 62 cells keep their assertions in six
failing `waiting_for_sdk_*` tests: 15 wrong writes, 22 false refusals, 25 necessary refusals with
the wrong reason. Two more tests protect ungrouping against a newly locked member, directly and
through the guard.

| Family | Address Cells | Derived Cells |
|---|---:|---:|
| Element ids, named containers/nodes and paste refs | 298 | 0 |
| Bound ends / connector creation and routing | 40 | 80 |
| UUID, numeric, implicit pages and page gaps | 156 | 0 |
| Destination point / raw z-index | 42 + 40 | 0 |
| Align, distribute, stack | 0 | 120 |
| Frame fit and scaling | 0 | 80 |
| Group, ungroup and member transforms | 0 | 120 |
| Relative/front reordering | 0 | 80 |
| Card/image default and explicit placement | 0 | 180 |
| Text/font measurement | 0 | 80 |
| Mind-map layout, additions, collapse and direction | 0 | 180 |

The 15 wrong writes are five numeric page contexts, three implicit contexts, one deleted page
gap and six raw z-index cells. False refusals come from deleted-object coverage in
destination-frame replay, page-wide hierarchy holding an unrelated container on the same page,
and z-order windows holding geometry/parent fields they do not need. Removed or moved
dependencies can be reported as a holder's `changed` instead of `deleted`/`relocated`.
These declarations cannot express scoped membership through a derived subtree summary on a
non-owning group: that would violate the derived-value contract. Page ownership lets the kit scope
hierarchy and placement geometry by page.

The oracle draws with the fonts the headless engine ships. An anchored rebind (`connector.bind`
with an explicit anchor) holds the target's kind and the replaced end's binding, not the target's
box: the stored point is a cache derived from them. A deleted dependency is expected as `deleted`
in every matrix. The address and derived cases have a 60-second timeout, the gate's hard cap.
These finite matrices exercise the named fixtures and parameters, not every possible board or
selection.

### Nested independent reading

All 83 reading rows run on a second board: frame F inside group FG; group G inside frame GF;
sizeless T and A inside F; B and locked L inside G; connector K across A/B's containers.
Eleven rows differ from the flat reading: duplicate F; move F/G; resize G; rotate G; fit F;
align F/A; delete F/G; reorder F; ungroup G. Geometry is held only for selected roots (carried A
does not set the alignment delta when F is selected), and all 83 flat and 83 nested rows match.
These are declaration comparisons, not successful execution of commands that would write a
locked descendant.

In the reading: five leaf-selection rows (resize, selection rotate, align, distribute, stack)
hold no `parent`; eight container rows (move F/G, resize G, rotate G, fit F, align F/A, reorder
F, ungroup G) hold Page `~hierarchy`, not Board `~structure`; six map rows (layout, direction,
collapse, addChild at M1/M, addSibling at M1) hold `~mapStructure`; ungroup holds its members'
`locked`; default card/image/template placement holds the destination Page `~geometry`. Ungroup
refuses atomically when a colleague locked a member.

## Offline environment

The model labels boards by title, pages by name and elements by text. `locked` and `collapsed`
are positive boolean labels. Authoring keys are not sampled; element kind is read-only.
Numeric limits match commands: opacity/label position 0..1, rotation -3600..3600 degrees,
roundness 0..100000 units, font size 1..1000 units. JSON position members accept +/-1000000;
size members accept 0..100000. Command schemas also publish padding/gap, export/render,
coordinate, size and nonnegative index limits. Anchors accept coordinate inputs and clamp to
0..1; they do not reject all inputs outside 0..1. Render scale is strictly positive and at most
4; the supported schema keywords publish the maximum, with positivity stated in prose.
Native floats have no invented quantization or `multipleOf`. There are no time-valued fields
needing the SDK's time `display` formatter. Successful direct and Exchange model batches
invalidate the document's area and raster caches through `batch_applied`.

Seed 7 (measured on kition-sdk `33b14be`) generates 100 tasks from the same 19 tracked board
samples: 20 delete, 18 move, 32 replace-text, 30 set-field and 0 create (67 forward, 33 inverse).
All 100 oracle traces score 1. Discards are 15 not-replayable creates, 18 refused creates and 4
instruction-incomplete candidates; given-up and receipt-differs are both 0. Rich-text scalars and
derived fields replay. Creation has two SDK blockers:

- Element creation omits the required read-only `kind`, causing invalid-value. Supplying it is
  refused as read-only during creation. Both sampler and replay omit kept fields.
- A valid Page create replays with a fresh UUID. `Snapshot::same` uses reread identity pairing,
  which preserves existing Board UUIDs but treats the new replay UUID as a separate
  created/deleted Page. So `remakes` discards the otherwise valid creation as not-replayable.

Each incomplete instruction is checked against its receipt: task 3 deletes a node and
detaches a connector start; task 15 deletes a frame and clears one child's parent; task 58's
move and the delete after it each clear two children's parents. The single-operation
instructions omit these stored repairs, so the SDK discards them. `limits12` covers the
immutable-kind conflict and valid Page/text edit forms; the `env` tests check that invalid forms
are refused.

## Workflow

1. `board_inspect`, then `board_query {follow: "pages.0.elements"}` to get ids and positions.
2. `board_commands` with keywords. Use the exact id it returns and follow its parameter schema;
   never guess a command id.
3. `board_run` a few steps, each naming its page (`target`, `at.part`, `page`) and its elements
   (`on`, or the command's own id parameter); take new ids from the answer. Pass the last
   `revision` as `basis`.
4. `board_check`, then fix what it reports. Most diagnostics carry a `fix`
   ([`connector.create`](/kits/board/commands/connector.create/),
   [`frame.fit`](/kits/board/commands/frame.fit/), …): run it with the ids it names.
5. `board_inspect` again to confirm the result in the preview.

## Example 1: add a step to a flow chart

`board_query {"path": "plan.kboard", "follow": "pages.0.elements", "fields": ["kind", "text", "position", "parent"]}`
lists the frame `Sprint` (`01a18a90-…e169c1`, at 0,0, 640 × 320) holding flow nodes `Plan` and
`Build` (`01a18a90-…11c5e1`, at 420,120), joined by a connector. Add `Ship` to the frame:

```json
board_run {"path": "plan.kboard", "steps": [
  {"command": "element.create", "params": {"elements": [{"kind": "shape", "shapeStyle": "flow-node",
    "parent": "01a18a90-f63d-74f3-bebb-52aee9e169c1", "position": [780, 120], "size": [160, 80], "text": "Ship"}]}}
]}
board_check {"path": "plan.kboard"}
```

It answers `{"created": ["01a18a95-a876-…"]}`, and the check warns that `Ship` has no connector and
reaches outside `Sprint`, with fixes. Run them with the new id:

```json
board_run {"path": "plan.kboard", "steps": [
  {"command": "connector.create", "params": {"from": {"element": "01a18a90-f63e-7428-86a6-6e459211c5e1", "anchor": [1, 0.5]},
    "to": {"element": "01a18a95-a876-7716-b136-47cc59a663c6", "anchor": [0, 0.5]}}},
  {"command": "frame.fit", "params": {"id": "01a18a90-f63d-74f3-bebb-52aee9e169c1"}}
]}
board_check {"path": "plan.kboard"}
```

The check then finds nothing wrong.

## Example 2: a mind map on a new board

```json
board_create {"path": "ideas.kboard"}
board_run {"path": "ideas.kboard", "steps": [
  {"command": "element.create", "params": {"elements": [{"kind": "shape", "shapeStyle": "mind-node", "position": [0, 0], "text": "Launch"}]}}
]}
```

It answers the root's id. Branch from it and lay the map out:

```json
board_run {"path": "ideas.kboard", "steps": [
  {"command": "mindmap.addChild", "params": {"node": "01a18a95-f2c9-72e1-ba55-52cd7449e7eb", "text": "Audience"}},
  {"command": "mindmap.addChild", "params": {"node": "01a18a95-f2c9-72e1-ba55-52cd7449e7eb", "text": "Channels"}},
  {"command": "layout.mindmap", "params": {"root": "01a18a95-f2c9-72e1-ba55-52cd7449e7eb"}}
]}
board_check {"path": "ideas.kboard"}
```

Each [`mindmap.addChild`](/kits/board/commands/mindmap.addChild/) answers the new node (`node`) and
its connector (`created`); the check finds nothing wrong.

## Example 3: edit two pages in one run

`board_inspect` lists the pages `Plan` and `Retro` (id `01a1cef6-5add-739b-9664-509d775221f1`); `board_query {"follow":
"pages.1.elements"}` gives the frame `Went well` (`01a1cef6-…6b4dd8`) on Retro, and
`pages.0.elements` the frame `Sprint` (`01a1cef6-…573cbb49`) on Plan. Add a sticky note in `Went
well` and rename `Sprint`, without showing either page:

```json
board_run {"path": "retro.kboard", "basis": "dio0", "target": {"page": "01a1cef6-5add-739b-9664-509d775221f1"}, "steps": [
  {"command": "element.create", "params": {"elements": [{"kind": "shape", "shapeStyle": "sticky",
    "parent": "01a1cef6-5adf-70ae-a855-bed7df6b4dd8", "position": [260, 80], "size": [160, 120], "text": "Wins"}]}},
  {"command": "element.setText", "on": ["01a1cef6-5ade-703b-9d65-4d56573cbb49"], "params": {"text": "Sprint 12"}}
]}
```

The sticky lands on Retro (the run's target); the rename needs no page, since the id names it.
`changes` names the new sticky in `created` and the frame in `changed`, with `text` `"Sprint"` →
`"Sprint 12"`. The next call starts again from the person's page: name the page again.

## Example 4: a write others got to first

You pass `"basis": "dio3"` to restyle `Ship` (`01a1cef1-…687375`), and another agent has since
changed its fill colour:

```json
board_run {"path": "plan.kboard", "basis": "dio3", "steps": [
  {"command": "element.style", "on": ["01a1cef1-398a-72fc-ae77-768467687375"], "params": {"style": {"fillColor": "red"}}}
]}
```

It answers `conflict` with `conflicts: [{"id": "01a1cef1-…687375", "reason": "changed"}]` and
`others` saying what changed (`fillColor` before and after) and `by` whom, and a `revision`. Nothing ran.
Look at the element again, decide whether the restyle still makes sense, and send it with that
`revision` as `basis`. Had the other agent changed another element, the write would have applied
and `others` would have named that element. A text-only change of Ship also allows this fill
write: text is outside its premise.

## Pitfalls

- **Ids are only known after a call answers.** A later step in the same `board_run` cannot refer to
  an element an earlier step made: there are no references such as `$0.created.0`, and `key` is an
  authoring label, not an id. Make the elements, read the ids from the answer, then connect them in
  the next call.
- **Nothing carries over between calls.** No call remembers the page or the elements of the one
  before: name the page (`target`, `at.part`, `page`) and the elements (`on`, ids) every time, with
  the ids earlier results gave.
- **A failed step:** a step that fails stops the call and the kit undoes the steps before it, so
  the board is as it was before the call and nothing is saved. Read `error.index` for the failing
  step, fix it, and send the whole run again.
- **Spacing:** shapes are 160 × 100 board units by default. Leave space between them, and use
  `anchor` to choose the side a connector leaves from, so connectors don't cross nodes.

## Checks

`board_check` lists what is wrong with the board. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/board/checks/).

- `board.outside-frame` (warning): an element reaches outside the frame that holds it. Run
  [`frame.fit`](/kits/board/commands/frame.fit/) `{id}` on the frame, or move the element.
- `board.disconnected-node` (warning): a flow node has no connector. Connect it with
  [`connector.create`](/kits/board/commands/connector.create/).
- `board.overlap` (warning) and `board.connector-crosses-node` (info): elements overlap, or a
  connector crosses a node. Move them apart.
- `board.label-overflow` (warning): a label does not fit its box. Shorten it or enlarge the shape.

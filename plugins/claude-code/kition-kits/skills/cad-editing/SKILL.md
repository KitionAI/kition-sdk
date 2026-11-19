---
name: cad-editing
description: "Create, inspect, edit and check a CAD drawing (.dxf) with the Kition CAD kit's tools: drawing, modifying, dimensions, layers, blocks, and AutoCAD-style commands; `commandLine` runs any command-line entry. Use when the user asks to make, read, change, review or fix .dxf files in this project."
---

<!-- Generated from kition-cad agent/guide.md by kition-sdk tools/claude-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
`cad_<action>` tools this guide names are `kit_<action>`, routed by the file's extension
(`cad_run` is `kit_run`, `cad_check` is `kit_check`). With "unified" off they are named as
written. Paths are relative to the project folder.

# CAD kit

The CAD kit opens, edits and checks 2D drawings in DXF (`.dxf`). Its commands have the classic CAD
command names in lower case ([`line`](/kits/cad/commands/line/),
[`rectang`](/kits/cad/commands/rectang/), [`move`](/kits/cad/commands/move/),
[`erase`](/kits/cad/commands/erase/), [`dimaligned`](/kits/cad/commands/dimaligned/),
[`layer.set`](/kits/cad/commands/layer.set/), [`audit`](/kits/cad/commands/audit/)). An agent can
draw and modify objects, add dimensions, work with layers and blocks, find objects by type, layer or
window, and check the drawing database for damage, stray objects and hidden layers.

## Tools

The kit's prefix is `cad`. Its tools are:

| Tool | Does |
|---|---|
| `cad_inspect` | The drawing as JSON: its spaces (`layouts`: Model first, then each layout, with `part` and entity count), its layers, blocks and named views with their ids, the current layer and the object count; with `preview: true` and a `target`, a picture of a space, a window, an entity or a named view |
| `cad_query` | Reads objects of the drawing's object model by id (an entity's handle, `layer:Walls`, `layout:Layout1`), or by following fields from the root |
| `cad_commands` | Finds commands by keywords, each with its parameter schema |
| `cad_run` | Runs a list of command steps (below) |
| `cad_batch` | Runs one batch of object-model operations |
| `cad_check` | What is wrong with the drawing, as diagnostics |
| `cad_create` | Makes a new `.dxf` drawing |
| `cad_export` | Writes the drawing to a new PDF, SVG or PNG file |
| `cad_draft_ready`, `cad_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the drawing's path in the workspace. With `draft: true` your edits go to
your draft of the drawing and leave the file as it is; only the person merges or discards a draft.
`cad_export {path, to, format}` writes the drawing to a new file and leaves the drawing as it is:
`pdf` (model space fitted to the paper of its page setup, A4 in a metric drawing), `svg` or `png`,
each framed to the drawing's extents. It never replaces a file; DXF is the drawing itself, and DWG
is not exported.

## Ids

- **Handles are the one id of an entity.** An entity (line, polyline, circle, text, dimension,
  block reference …) is named by its **handle**, a hex string such as `"1A2"` or `"3A63500000000"`:
  the `handle` [`entities`](/kits/cad/commands/entities/) lists, the `handle`/`handles` commands take,
  the handle a drawing command answers ([`rectang`](/kits/cad/commands/rectang/) → `{handle}`), the id
  `cad_query` and `cad_batch` answer and take, the id receipts, `others` and `conflicts` name, and a
  diagnostic's `entity:<handle>`. An entity keeps its handle when it is moved or changed and when the
  file is saved and opened again; one your command makes has, from the moment the command answers,
  the handle the saved file gives it. Handles of new objects differ from one session to the next:
  read them from the result, never copy them from an example. Handles are strings, not numbers.
- **Named records have saved identities independent of their names.** Read the `id` returned
  by inspect/query; do not construct it from a name. Typed command parameters accept that id or
  the current readable name (`{"layer":"Walls"}`). A rename preserves the id, including after
  save/reopen; recreating the old name receives a different id. Prefixes include `layer:`,
  `layout:`, `block:`, `view:`, `linetype:`, `textstyle:`, `dimstyle:`, `mleaderstyle:`,
  `tablestyle:`, `ucs:`, `layerstate:`, `group:` and `plotstyletable:`. DXF records keep the id in
  registered extended data, backed by a drawing dictionary; imported records initially use their
  native DXF handles. An external writer that strips both identity metadata and native handles
  prevents proving identity. The kit reports those unproven identities to the public SDK;
  stale writes whose named recipients cannot be proved refuse `unknown` and preserve the outside file.
- Model space is `{"layout": "Model"}`; it is not an object of its own in the object model.
- Raw entity creation leaves `handle` out so the kit allocates it. Supplying a handle refuses
  `invalid-value` with a read-only explanation; later handle assignments refuse `read-only`.
- A constraint has a saved id such as `constraint:1`. `delconstraint.ids` accepts these ids and
  the numeric ids its engine command lists; coordinates and cell indices are never object ids.

## What a write holds

Pass the observation's `revision` as `basis`. The default guard is `premise`; `epoch` refuses
after any document change, and `off` performs no stale-observation check. A refusal names
`deleted`, `relocated`, `changed` or `unknown`. Read again and decide against that new observation.

A write holds the observed value of every field or setting it assigns, including an absolute
replacement. A colleague's change to that same field refuses `changed`. Other fields may merge
when the result preserves them. Declarations are sampled against independently read handlers;
the comparison rejects missing dependencies and caps wider declarations. This is a partial
behaviour audit, not a proof for every parameter path.

| Command family | Facts held by the audited implementation |
|---|---|
| Common property, text, hatch and viewport edits | Assigned fields, kind checks and applicable lock checks. Geometry property edits also hold their connected solver component. |
| Geometry transforms and grips | Written geometry and applicable locks, connected constraints and expression providers. Remeasured dimensions hold their attachments, stored geometry, layer, style and rendered text dependencies. |
| Copy, array and copying transforms | Stored common properties, kind and source space. Visibility, lock and hit-test state are held when source selection or placement uses them. Nonrotating polar references also consume definition extents and member visibility. Copying a transform leaves the original dimension unchanged. |
| `table.set` | Saved identity of the addressed cell, assigned anchor text and merge anchors that can redirect the index. Appending can merge; inserting before that cell refuses. Other table edits retain conservative topology premises. |
| Named record assignments | The assigned fields and the referenced identity or destination name gap. Typed historical name replay separates unrelated records and uses small name receipts when aggregate journal values are unavailable. |
| Block expansion and layout copy | Definition base, ordered member identities and copied stored member payloads. Layout copy also holds page/view settings and its tab-order seed. Unused descriptions and child lock witnesses can change. Inserting an external reference also holds its saved path. |
| Creation defaults | Only the stored defaults used by that form. New dimensions hold their style, applicable DIM* overrides, arrow definitions and font metrics. Standalone leaders use a narrower set of defaults. |
| Dimension edits | Assigned style, text, justification, override scalars or attachments. Clearing overrides holds the overwritten map. Most dimension edits retain source-geometry premises; disassociation preserves remeasured points without consuming source geometry. |
| Dimension spacing | Base geometry and, for automatic spacing, baseline spacing and effective scale. A base with no eligible other dimension is a guarded no-op. Rendering dependencies remain held for dimensions actually changed. |
| `setvar` | Stored header replacements hold the assigned value. Session-only settings use the editor-state contract instead of an unrelated imported header of the same name. |
| LAYOUT set dispatcher | The named address remains held. The agent wrapper restores its temporary editor state, so independent page settings can change. Direct `layout.set` keeps its editor-state behaviour. |
| `chspace` | Source geometry and space, destination layout, the selected viewport projection, and dependent dimensions. Choosing an omitted destination also consumes tab order. |
| Viewport creation and overrides | Used model extents/page setup, viewport numbering, new-viewport frozen layers, and identities behind override layer names. |
| Boundary hatches and automatic associations | Engine-selected sources and historical membership replay. Curved and clipped output also holds the engine's sampled outline, including extent-dependent tessellation. Finite lines reuse their endpoint and pick witnesses. |
| `arc.continue` | Historical last-curve selection and the selected source geometry when a start or direction is omitted. A later equal candidate can change that choice. |
| `trim`, `extend`, `stretch` | Engine-resolved targets and cutting/window sources. Some scan and target payload projections remain conservative. |
| `find`, `select` | Observed match identities and historical replay. The SDK plans subsequent consumers in the selection state produced by earlier steps. FIND search holds membership and the relative order of its matches, preserving the recipient of a later first-object edit; replacement also holds matching words and target locks. Spatial SELECT retains the geometry its selector consumes. |
| `qselect`, `selectall` | Historical membership and complete observed matches remain held under the query consumer contract. |
| Layer snapshots | Layer records actually captured or restored, plus the source snapshot. An absent previous-layer or isolation snapshot errors before consuming layer contents. |
| Layer merge/deletion | Source membership, reassigned layer fields, current-layer state and viewport references. Deletion holds discarded payloads. Merge preserves unrelated destination fields except a destination thaw that the command assigns. |
| `ungroup` | Victim group name/data and saved identity. Independent group order can change. |
| `attsync`, clipboard capture, `wblock` | Definitions or drawing payloads captured by the native operation. Some definition/reference projections remain conservative; WBLOCK also needs the host file broker. |
| Constraints | Touched geometry, connected constraint values and transitive expression providers. A changed display setting can trigger the global solver; a display no-op preserves it. Removed exception and constraint handles are opaque membership data; adding an exception holds its live recipient because drawing repair prunes missing recipients. A single circle cannot infer a constraint. |
| Undo/redo | Drawing content conservatively. Outside rereads import colleague changes into the live replica and preserve scoped undo. Saved editor state can be restored into the reread document when its layout and selection still resolve. |

A target-bearing command usually also accepts `pick: [x,y]` instead of its handle parameter,
with optional `aperture`. The point acts in the step's space (`at.part` or the run's `target`).
Historical replay uses the live engine's hit test, including relevant geometry, visibility,
order, block members and their layers. Changes that preserve the selected place can apply.
Explicit handles avoid depending on the geometry under a point. Native picks on `trim`,
`extend`, `lengthen` and `ncopy` retain their command-specific meaning.

`~grid`, `~pick`, `~solve`, `~boundaryOutline`, override scalars and member-order projections
are computed facts, never writable fields. Their model declarations let same-server receipts
refresh them. Recursive blocks are bounded by the engine's maximum block depth. Referenced
payloads can be large, and a successful guard check is not a complete dependency proof.

A successful `close` or `closeall` returns `closed: true`, ends the run and omits the document
view without saving. Guarded planning and runtime execution stop at the successful close;
remaining steps are reported as `notRun`.

Independent same-server and outside-file writers exercise accepted saved merges and refusals
that preserve file bytes. The mixed table retains seed `0x9e3779b97f4a7c15` and its original
rules. The independent handler catalogue annotates source-backed corrections separately from
its original blind readings. Regression cases link the executable tests through `features.yaml`.

Rust dependencies pin the public SDK commit
`45bf9625f95e5e13a926e2174d5fdd11c57e0817`; the editor uses published `@kition/*` packages
from the `^0.1.0` release line and the committed lockfile. `KITION_LINK=1 pnpm install` links
kition-sdk and kition-tessera checkouts instead through `.pnpmfile.cjs`, for development only.
Guard implementation facts are marked `premiseOnly`: they protect writes without appearing
in public changes or environment snapshots. Public bounds and eligibility remain observable;
receipts report derived changes only when both sides are proven. Its prefix planning, derived refresh and historical
coverage callbacks guard selection consumers, indirect visibility and extent-driven hatch outlines.
Typed name gaps and automatically chosen names hold their observed destinations. Command-line
JSON and parameterless assignments use the native command's premises; other interactive text keeps conservative
content premises. Empty clipboard commands reach their native error without holding unused defaults.

Repeated marker inserts guard ordered attribute definitions and their copied fields. Attribute
synchronization protects assigned attributes and placement while retaining reference appearance.
Multileader style premises follow the text, block and leader branches. Centered block content
holds the native visible bounds center, including nested definitions and member-layer state.
Attribute synchronization holds copied definitions without ordinary block geometry. Gradients
omit the hatch pattern default that their native result replaces with SOLID.

The independent handler catalogue has source-backed corrections and concrete saved-file probes.
The SDK merges historical private coverage edits into the matching public object record
before guard reconstruction. Query, group and pick replay preserve that history while
public receipts continue to omit private guard facts.

Some declarations still hold more than their audited paths require. The public SDK also lacks
name/type schema annotations for members nested inside a `oneOf`; the isolated schema probe
preserves that limitation explicitly. These checks do not establish minimality for every parameter path.

Further narrowing needs result-specific projections for some definition consumers and
rendered dimension styles, stable addressing for edits within opaque geometry arrays, and
session/file-broker fixtures for chained dimensions and WBLOCK. Saved anonymous dimension
cache normalization also needs a separate native/SDK contract investigation. These limitations
remain open; the declaration comparison alone does not establish minimality.

The command transaction rolls back changes, removals and space transfers of existing locked
entities, including changes made by propagation hooks. Idempotent entity writes still pass
through that lock policy. Hatches store loops without source links; arrays are independent
copies; ordinary leaders do not propagate source changes. Attributes synchronize through
explicit `attsync`.

DXF round trips do not retain every engine header or property. Stored-setting tests either use
persisted values or verify values injected by a separate writer. They do not repair missing
round trips. Interactive identity, cross-space replacements, layer-state resurrection and
copy-reference remapping remain separate engine audit work.

## Addressing and coordinates

- A drawing has **model space** (the full-size drawing) and **layouts** (paper sheets with
  viewports). Objects live in a space or in a **block** definition.
- Coordinates are **drawing units** of the space: `x` grows right and `y` grows **up**, from its
  origin `[0, 0]`. Points are `[x, y]` arrays.
- Every object is on a **layer**; layers can be off, frozen or locked. Linetypes, text styles and
  dimension styles are named table entries (`style:Titles` in diagnostics).
- Find existing objects with [`entities`](/kits/cad/commands/entities/) `{layout?, type?, layer?,
  window?: [[x,y],[x,y]], limit?, offset?}` → `{count, entities: [{handle, layer, geometry…}]}`: any
  space by `layout` (the space shown when left out), a page at a time.

## Where a step acts: `target`, `at` and `on`

Nothing a call does depends on, or leaves behind, the layout the person shows, MSPACE, their
selection or the view: name what each step acts on.

- A `cad_run` step is `{command, params?, on?, at?}`. The run's `target` (`{"layout": "Layout1"}`,
  or `{"layout": "Model"}`) is the space every step acts in; a step's `at.part` overrides it for
  that step. A command that draws or picks without saying where acts in that space; without one,
  in the space the person shows.
- `on` names the entities a step acts on, by handle. It goes into the command's own parameter for
  them (`handles`, or `handle`: `cad_commands` marks it as the command's `targets`; then do not give
  that parameter too), or, for a command that acts on the selection, they are selected for that step
  only. A handle names its space, so `on` needs no `at`; entities of two spaces need two steps when
  they go through the selection, while `handles` takes entities of any space.
- **Drawing commands take `layer` and `layout`** ([`line`](/kits/cad/commands/line/),
  [`circle`](/kits/cad/commands/circle/), [`rectang`](/kits/cad/commands/rectang/),
  [`text`](/kits/cad/commands/text/), [`dimlinear`](/kits/cad/commands/dimlinear/) and every other
  command that makes objects): the new objects go on that layer, in that space, and the current
  layer and the space shown stay as they were. Without `layer` they go on the **current layer**,
  which is the drawing's own setting (the file saves it): [`layer.current`](/kits/cad/commands/layer.current/)
  and [`layer.new`](/kits/cad/commands/layer.new/) `{current: true}` change it for good, so prefer
  `layer`. The other current properties (colour, linetype, text and dimension style) are the
  drawing's too; `cad_commands` says which commands read them.
- A command leaves the person's space, view and selection as they were, also when it fails. Only
  commands whose work is moving the editor ([`select`](/kits/cad/commands/select/),
  [`qselect`](/kits/cad/commands/qselect/), `selectall`, `layout.set`, `mspace`, `pspace`, `zoom*`,
  `pan*`, `view.set`) move it, for the rest of the call: `select` a window, then `move` the selection
  in the next step. The editor is put back after the call: the next call starts again from the
  person's space, and the file saves the person's, never where the run worked.
- Inside a layout viewport (MSPACE) a zoom or pan would change the viewport's view, which the file
  saves: it is refused. Run `pspace` first, set the viewport with
  [`viewport.set`](/kits/cad/commands/viewport.set/), or look with a preview.
- **Picking by a point.** `select {at: [x, y]}` (and commands that take a pick point next to a handle,
  such as `fillet`'s or `trim`'s) picks the object within `aperture` drawing units of the point; for
  you the default is 0.5% of the larger side of the space's extents, whatever the zoom. Pass handles
  where a command takes them.

## Inspecting and previewing a layout or a window

- `cad_inspect` lists the spaces: `layouts: [{name: "Model", part: {"layout": "Model"}, entities},
  {name, id: "layout:Layout1", part, entities, viewports}]`. List a space's entities with
  `cad_run {save: false, steps: [{command: "entities", params: {layout: "Layout1"}}]}` (with `limit`
  and `offset` for large drawings); it does not go there.
- `cad_inspect {preview: true, target: …}` draws, through [`file.render`](/kits/cad/commands/file.render/):
  a space (`{"layout": "Layout1"}`; Model when left out) fitted to its extents, a `window`
  (`[x1, y1, x2, y2]` in drawing units of that space), an entity framed with a margin
  (`{"objectId": "1A2"}`, or a diagnostic's `{"path": "entity:1A2"}`) or a named view
  (`{"view": "Front"}`); `layers` draws only those layers. Off and frozen layers stay hidden, as the
  drawing has them. Without `target` it draws Model space fitted to its extents, never what the
  person shows. `scale` (pixels per drawing unit, 1 unless you pass one) and `maxSize` (the longer
  side in pixels) set its size; a view larger than `maxSize` is drawn smaller. The same call answers
  the same picture.
- **Reading coordinates off a preview.** The answer's `preview` gives `window` (`[x1, y1, x2, y2]`,
  the rectangle drawn, in drawing units) and `unitsPerPixel`. The pixel `px` from the left and `py`
  from the top is the point `x = window[0] + px * unitsPerPixel`, `y = window[3] - py * unitsPerPixel`
  (`y` grows up in the drawing and down in the picture). Measure what matters rather than reading it
  off pixels.

## Measuring

[`entities.measure`](/kits/cad/commands/entities.measure/) measures without changing anything (give
one question per step):

- `{bounds: [handles]}` → each entity's box `{handle, min: [x, y], max: [x, y]}`;
- `{distance: [a, b]}` (each a handle or `[x, y]`) → `{distance, from, to}`: the minimum distance and
  the two nearest points (0 for entities that cross);
- `{intersections: [a, b]}` (two handles) → `{points}` where they cross;
- `{overlaps: {layout?}}` → `{pairs: [{a, b, kind}]}`: objects of a space that draw the same geometry
  (`duplicate` when their properties match too, what [`overkill`](/kits/cad/commands/overkill/)
  would delete; `same-geometry` otherwise). Nothing is deleted.

[`dist`](/kits/cad/commands/dist/), [`area`](/kits/cad/commands/area/) and
[`massprop`](/kits/cad/commands/massprop/) answer lengths, areas and mass properties.

## What a call changed, and what others changed

- **Receipts.** A successful `cad_run` or `cad_batch` answers `changes`: `created` (with `at`: the
  space's list it went in, `layout:Layout1` or the root's `model`), `changed` (field paths with
  `before` and `after` when available), `moved` and `deleted`, naming entities by handle. JSON edits name leaves
  such as `kind.a.x` or `common.color.value`. A move, a vertex edit
  (`grip.stretch`, `pedit`) or any change of shape is an edit of the entity's `kind` (its geometry,
  vertices included); a layer, colour or linetype change is an edit of `common`. An edit of an
  entity inside a block definition names that entity; the block's references are not listed, but
  they draw the change. `diagnostics: {new, resolved}` says what the check found new.
  Repeated equal offsets use the SDK's `footprint` form. A moved block reference reports `carries` for its direct definition members; nested instance
  totals are not expanded. A rename alone carries no geometry. Use `changes: "all"` for complete
  receipts: the default response caps changed objects at 50 and reports truncation.
- **Saved values.** Representative command and model writes are tested against reopened DXFs.
  `EXTMIN`, `EXTMAX` and `HANDSEED` are writer-generated caches, omitted from the binding's model
  and refused by model batches. The raw Drawing/KDM conversion still preserves imported headers.
  Plain file opens still create their collaboration replica lazily.
  Hosted opens repair damaged references before the first observation; a subsequent write does
  not silently repair what the agent observed. Standalone opens retain their audit diagnostics.
  Damaged conformance receipt cases compare receipts with reopened content. This is not a
  proof for every command or imported object kind. Typed owning maps include named records in
  environment snapshots and saved-reread comparisons. Receipts may omit large before/after values;
  the guard uses the facts available and refuses `unknown` when it cannot prove an address.
  Named records have schema labels and unsampled internal order. Entity labels describe kind and
  layer; writable text has its own schema path. Deterministic environment probes generate and
  replay field edits, text replacements and creations with required JSON fields. Raw model operations
  declare their direct batch contracts and retain the model's validation/settlement rules.

  Command numeric bounds and parent position premises are supported. JSON member bounds constrain model values such as entity linetype scale. Name/type annotations
  inside point-or-object unions remain unsupported.
  Missing deleted geometry in spatial replay answers `unknown` and can conservatively refuse
  an unrelated deletion.
- **Pass the latest `revision` as `basis`.** Every answer of inspect, query, run and batch has a
  short `revision`. Pass the last one you were given as `basis` on your next call: the answer then
  says what others (people, other agents) changed since, in `others` (with `by`).
- **A `conflict`** (retryable) means others changed what your write acts on since your `basis`: an
  held fact was `deleted`, `relocated` or `changed`, or the change cannot be told
  object by object (`unknown`). Nothing was run. Read `others` and `conflicts`, look again if you
  need to, decide again, and send the call with the `revision` the refusal gives as `basis`. Do not
  undo others' changes; an unrelated change can apply when it is outside the write's premises. Name your targets in
  `on` (or the command's `handles`) so the guard knows them.

## Workflow

1. `cad_inspect {path}`: the spaces, layers and current layer; `entities {layout}` for what a space
   holds.
2. `cad_commands {path, query}`: find commands by keywords (`"rectang"`, `"dimension aligned"`,
   `"layer new"`). Use the exact id it returns and follow its parameter schema; never guess a
   command id. The `description` gives the command's options.
3. `cad_run {path, steps, basis}` a few steps per call, naming spaces with `target`/`at`, entities
   with `on` or `handles`, and layers with `layer`. A failing step stops the call and the kit undoes
   the steps before it, so the file is as it was before the call and nothing is saved: read
   `error.index` for the failing step, fix it, and send the whole run again. A call that succeeds
   saves the file (`save` defaults to `true`; `save: false` tries steps first). Read `changes`.
4. `cad_check {path}`: fix what it reports, then check again.
5. `cad_inspect {path, preview: true, target}` to look at the result; `entities.measure` to check
   sizes and clearances.

## Example 1: furniture on its own layer, with a dimension

```json
cad_run {"path": "Plan.dxf", "steps": [
  {"command": "layer.new", "params": {"name": "Furniture", "color": 3}},
  {"command": "rectang", "params": {"p1": [10, 10], "p2": [40, 30], "layer": "Furniture"}},
  {"command": "dimaligned", "params": {"p1": [10, 10], "p2": [40, 10], "at": [25, 2], "layer": "Furniture"}}
]}
```

Answer: `completed: [{command: "layer.new"}, {command: "rectang", result: {handle: "3A63500000000"}},
{command: "dimaligned", result: {handle: "3A63500000001"}}]`, `changes.created` naming both handles,
`revision: "qxa7"`, `saved: true`; the current layer is still `0`. Move the table by its handle,
measure its clearance to the wall line `"100"`, and pass the revision:

```json
cad_run {"path": "Plan.dxf", "basis": "qxa7", "steps": [
  {"command": "move", "on": ["3A63500000000"], "params": {"delta": [5, 5]}},
  {"command": "entities.measure", "params": {"distance": ["3A63500000000", "100"]}}
]}
→ completed[1].result: {"distance": 15, "from": [15, 15], "to": [15, 0]}
cad_check {"path": "Plan.dxf"}
→ {"diagnostics": []}
```

## Example 2: a title on the sheet and a fix in model space, in one call

`cad_inspect` lists `layouts: [{name: "Model", …}, {name: "Layout1", id: "layout:Layout1", part:
{"layout": "Layout1"}, entities: 2, viewports: 1}]`. Write the title in Layout1's paper space and
move a wall line in model space, without switching layouts:

```json
cad_run {"path": "Plan.dxf", "basis": "k2m9", "steps": [
  {"command": "text", "at": {"part": {"layout": "Layout1"}}, "params": {"at": [20, 15], "height": 5, "text": "Ground floor", "layer": "Titles"}},
  {"command": "move", "on": ["101"], "params": {"delta": [0, -10]}}
]}
cad_inspect {"path": "Plan.dxf", "preview": true, "target": {"layout": "Layout1"}, "scale": 2}
→ preview: {"layout": "Layout1", "drew": "extents", "window": [-13.8, -14.05, 293.2, 229.95], "unitsPerPixel": 0.5, "width": 614, "height": 488, …}
```

The title's baseline start `(20, 15)` is at pixel `px = (20 + 13.8) / 0.5 ≈ 68`, `py = (229.95 - 15) /
0.5 ≈ 430` of the preview. Layout1 is still not the space the person shows.

## Fixing what the check reports

```json
cad_check {"path": "Site.dxf"}
→ {"diagnostics": [{"code": "cad.hidden-layer", "severity": "info", "target": {"path": "layer:Notes"},
    "message": "1 object on layer \"Notes\" is not shown: the layer is frozen.",
    "fix": {"command": "layer.set", "params": {"name": "Notes", "frozen": false}}}]}
cad_run {"path": "Site.dxf", "steps": [{"command": "layer.set", "params": {"name": "Notes", "frozen": false}}]}
cad_check {"path": "Site.dxf"}
→ {"diagnostics": []}
```

A damaged database is repaired with [`audit`](/kits/cad/commands/audit/), as the diagnostic's fix
says:

```json
cad_check {"path": "Doors.dxf"}
→ {"diagnostics": [{"code": "cad.missing-block", "severity": "error", "target": {"path": "tables"},
    "message": "tables: 1 block reference to \"Lost Door\", which has no definition (AUDIT fixes it: created an empty block definition).",
    "fix": {"command": "audit", "params": {"fix": true}}}]}
cad_run {"path": "Doors.dxf", "steps": [{"command": "audit", "params": {"fix": true}}]}
→ completed: [{command: "audit", result: {errors: 1, fixed: 1, issues: [...]}}]
cad_check {"path": "Doors.dxf"}
→ {"diagnostics": []}
```

## Pitfalls

- **Handles are hex strings**, not numbers, and the kit's: an entity's `handle` is read-only in the
  object model. Assigning one refuses `read-only`; supplying one at creation refuses `invalid-value`
  with a read-only explanation. Both leave the drawing unchanged. Create an entity without `handle` (the kit gives it the next free one) and read
  it back with `cad_query`, or draw it with a command, which answers its handle.
- **`y` grows up**, unlike most graphics kits and unlike a preview's pixel rows.
- **Name the context explicitly:** give the layout and targets each call needs. Earlier steps in
  the same run can establish a selection for following commands. Read newly allocated handles from
  `completed[].result` or `changes` before naming them in another call; model batches can bind
  creation references with `ref`. Outside rereads preserve the editor state when its recipients
  still resolve.
- **The current layer** is the drawing's: draw with `layer` rather than changing it.
- **Results that count:** `move` answers `{moved: n}`, `erase` `{erased: n}` and `properties.set`
  how many it changed; `changes` names which. A handle that names nothing is skipped, so check `n`.
- **Rectangles and moves:** [`rectang`](/kits/cad/commands/rectang/) makes a closed polyline;
  [`move`](/kits/cad/commands/move/) takes `delta: [dx, dy]` or `from` and `to`.
- **`measure` is not `entities.measure`:** [`measure`](/kits/cad/commands/measure/) places points
  at intervals along a curve, as in other CAD programs.
- **No prompts:** commands that ask a person for answers in the editor take all their answers as
  parameters here; read the schema rather than expecting a prompt.
- **Files:** commands that name a file ([`saveas`](/kits/cad/commands/saveas/),
  [`exportpdf`](/kits/cad/commands/exportpdf/), [`insert`](/kits/cad/commands/insert/) of a file)
  are not yours to run: the person's host opens and saves drawings. Write a PDF, SVG or PNG with
  `cad_export`; paths are workspace-relative, and anything outside the workspace answers
  `not-allowed`.
- **Undo:** your [`undo`](/kits/cad/commands/undo/) takes back your own steps only; the person's
  stay.

## Checks

`cad_check` lists what is wrong with the drawing. Each diagnostic has a stable `code`, a `severity`
(`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a command step to
run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it only when it is
what the person asked for. [`audit`](/kits/cad/commands/audit/) `{fix: true}` repairs every
database finding at once. Every code the kit reports is on the [checks page](/kits/cad/checks/).

| Code | Severity | What to do |
|---|---|---|
| `cad.missing-block`, `cad.missing-linetype`, `cad.missing-reference`, `cad.block-cycle`, `cad.duplicate-handle`, `cad.missing-layer`, `cad.missing-text-style`, `cad.missing-table-entry`, `cad.dangling-reference` | error | The drawing database is damaged: run the `fix` ([`audit`](/kits/cad/commands/audit/) `{fix: true}`) |
| `cad.invalid-geometry` | error | A zero-length line or a circle without radius: `fix` erases it |
| `cad.missing-current` | warning | The current layer or style is gone: [`audit`](/kits/cad/commands/audit/) `{fix: true}` or [`layer.current`](/kits/cad/commands/layer.current/) `{name}` |
| `cad.degenerate-polyline`, `cad.degenerate-hatch` | warning | Draws nothing: erase it or draw it again with real points |
| `cad.unresolved-xref` | warning | The external reference has no file loaded; tell the person |
| `cad.far-outside` | warning | A stray object far from the drawing; `fix` erases it (check it is not wanted first) |
| `cad.hidden-layer` | info | Objects on an off or frozen layer; `fix` turns the layer on (only if the person wants them shown) |
| `cad.font-substituted` | info | A text style's font is not installed here |
| `cad.empty-text` | info | `fix` erases the blank text |
| `cad.dimension-text-overridden` | info | The dimension shows fixed text; `fix` restores the measurement |
| `cad.truncated` | info | More of one code than listed: fix those and check again |

---
name: photo-editing
description: "Create, inspect, edit and check a layered image (PSD, PSB, or .kphoto) with the Kition Photo kit's tools: layers, adjustments, filters, selections, transforms, type, and more. Use when the user asks to make, read, change, review or fix PSD, PSB, or .kphoto files in this project."
---

<!-- Generated from kition-photo agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (its "unified" option): the
`photo_<action>` tools this guide names are `kit_<action>`, routed by the file's extension
(`photo_run` is `kit_run`, `photo_check` is `kit_check`). With "unified" off they are named as
written. Paths are relative to the project folder.

# Photo kit

The Photo kit opens, edits and checks layered images (`.psd`, `.psb`, and its own `.kphoto`) with
Photoshop's commands. An agent can add, select, show and delete layers, make selections, fill and
paint, set type, apply adjustments, filters and transforms, check the image for empty, hidden or
off-canvas layers and missing object-layer sources, and export a flat PNG, JPEG, TIFF or WebP.

## Tools

The kit's prefix is `photo`. Its tools are:

| Tool | Does |
|---|---|
| `photo_inspect` | The image as JSON (the canvas, the layers, the channels and the selection state), with a preview |
| `photo_query` | Reads objects of the image's object model by id, or by following fields from the root |
| `photo_commands` | Finds commands by keywords, each with its parameter schema |
| `photo_run` | Runs a list of command steps |
| `photo_batch` | Runs one batch of object-model operations |
| `photo_check` | What is wrong with the image, as diagnostics |
| `photo_create` | Makes a new `.psd` image |
| `photo_export` | Writes the image to a new PNG, JPEG, TIFF or WebP file |
| `photo_draft_ready`, `photo_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the image's path in the workspace. With `draft: true` your edits go to
your draft of the image and leave the file as it is; only the person merges or discards a draft.

## Addressing and coordinates

- Coordinates are **pixels** from the **top-left corner of the canvas**, `x` growing right and `y`
  growing down. `photo_inspect` answers the canvas `width` and `height` in pixels, with its `mode`,
  `depth` and `resolution`.
- `photo_inspect` lists the **layers** top layer first. Each layer has an `id`, a `name`, a `kind`
  (`Pixel`, `Type`, `Smart`, `Group`, `Adjustment`, …), `visible`, `opacity`, `blend` and `bounds`
  as `[x, y, width, height]` in pixels. A type layer adds `text: { text, font, sizePt }`, its size
  in points.
- [`select.rect`](/kits/photo/commands/select.rect/) `{ x, y, width, height }` makes a rectangular
  selection in pixels; [`text.add`](/kits/photo/commands/text.add/) `{ x, y, … }` places text
  with `y` its baseline.
- **Layer ids are stored in the image.** A layer keeps its `id` when the image is saved and
  opened again, in another session, and after a failed `photo_run` was rolled back: a `.psd` stores
  each layer's id as its PSD layer id, a `.kphoto` stores it too. Ids are numbered per image, so
  two open images can both have a layer `3`; a layer copied into another image takes a new id
  there, which the command answers. A deleted layer's id may be given to a new layer once the
  image is opened again.
- Two people who each add a layer at the same moment may get one id; after their edits merge,
  the layer with the smaller object-model id keeps it and the other takes the next free id. Read
  the ids of layers you just made from the answer of the command that made them, or inspect again.
- **One id space.** `photo_query`, `photo_batch`, receipts (`changes`), `others` and conflicts
  name a layer by the same id `photo_inspect`, the commands and the diagnostics use (a number). A
  layer mask is owned by its layer; alpha/spot channel surfaces have no layer id and can appear
  as unnamed surfaces after an outside reload. The image itself is `image`; `~channelContents`
  on it tracks channel names and pixels for the guard.
- **What the object model holds.** A layer's `data` holds its kind's settings and `extra` its
  PSD bookkeeping (label, link group, vector mask, Blend If, Advanced Blending). A type layer's
  characters are its text body (`text.content`), each style run a mark on the characters
  (`char`, `paragraph`); its layer effects are `styles`, one object each (`effect`), with
  `styleSettings` (on or off). The image's notes (`note:<key>`, the body a text), layer comps
  (`comp:<id>`), saved paths (`path:<key>`) and patterns (`pattern:<id>`) are lists of objects,
  its guides a map keyed by guide. Whether a group is expanded, a note open, and where the
  timeline's playhead is are each person's own view: they are not in the object model, and
  changing them changes nothing others see.
- A command that acts on one layer takes it as `layer`: its **id**, `"#n"` (the n-th layer of the
  image's **top level counted from the top**, as `photo_inspect` and the Layers panel list it:
  `"#1"` is the top one), or its **whole name** when no other layer has it. Instead of `layer` it takes `at: [x, y]`:
  the topmost visible layer, not fully locked, with a pixel at that point. A step's `on: [id]`
  fills `layer`. Without any of them it acts on the **active layer**.
- Commands that act on several layers act on the **selected layers**; `on: [id, …]` selects them
  for that step.
- Commands that act inside the **selection** take `region` for that call:
  `{ "rect": [x, y, w, h] }`, `{ "ellipse": [x, y, w, h] }`, `{ "polygon": [[x, y], …] }`,
  `{ "layer": id }` (that layer's pixels), `{ "channel": name }` (a saved selection), or `"all"`,
  with `"invert": true` for the rest. Explicit `null` clears the selection for that call. Without it they act inside the current selection (made with
  `select.*` earlier in the same run), or everywhere when there is none.
- Commands that use the **foreground or background color** take `foregroundColor` /
  `backgroundColor` (`"#rrggbb"`) for that call.
- An image has **no parts**: its artboards are layer groups in the image's own coordinates. A
  step's `at.part` and `at.time` are refused.
- Diagnostics' `target` is `{ "path": "layer:<id>" }`.

## Your state and the person's

The active layer, the selected layers, the selection, the targeted channel, the colors and the
Layers panel's view are the editing session's, not the image's. A run starts from the person's,
what a step sets lasts until the end of the run, and the person's comes back after it, before the
image is saved: your selection and active layer never reach the file or the person's editor. Name
what you act on (`layer`, `on`, `region`) instead of relying on what is selected.

## Previews and measurements

- [`file.render`](/kits/photo/commands/file.render/) draws a view you name, never the editor's:
  `{ "target": { "layer": id } }` draws that layer alone (even hidden), framed to its bounds;
  `{ "target": { "layers": [ids], "region": [x, y, w, h] } }` those layers in that area; no target
  the composite. It answers the PNG with `region`, `scale` and `mapping` (image x = region x +
  pixel x / scale), and `drawn`.
- [`image.measure`](/kits/photo/commands/image.measure/) answers without looking: a layer's (or
  the composite's) non-transparent `bounds`, how many `pixels` are not transparent, their `mean`
  color and a luminosity `histogram` inside a `region`, and with `with` another layer how many
  pixels both cover (`overlap`).

## When others edit the same image

Pass the `revision` of your last answer as `basis`. The answer lists what others changed since
(`others`); a write whose premise they changed is refused with `conflict` and runs nothing. What
a write holds:

- a property by id ([`layer.setProps`](/kits/photo/commands/layer.setProps/)): only the
  properties it sets; a move, a paint or a rename of the layer does not refuse it;
- pixels in an area (`edit.fill`, `edit.delete`, `paint.stroke`, and per-pixel adjustments): the destination pixels, the layer's kind, pixel-content data and effective locks, and the image's mode and depth. Bounded writes compare historical pixel bytes inside the destination and the canvas's effective clipping; paint outside that area can merge even within the same tile. Stroke bounds follow the resolved brush, dabs, symmetry and selection;
- inherited locks: the Image's `~inheritedLocks`, including changes caused by moving the
  edited layer into another group;
- a filter on a layer: all its pixels, content data (including an object layer's source and
  filter stack), effective locks and the image's size, mode and depth. A display mask is held
  when it is an input, such as Lens Blur's layer-mask depth map, or is itself the edit target;
- a region loaded from a layer: that source's pixels and content data; a region loaded from a
  saved channel: the addressed channel's identity and content fingerprint. Edits targeting a
  channel conservatively hold the image's channel list and `~channelContents`;
- an explicit pattern source: the addressed stored pattern. Applying a layer comp or text style
  conservatively holds its `comps` list or its `docState.text_styles` library;
- composite sampling (HDR Toning, merged Apply Image / Calculations, merged Displace maps or
  Match Color sources in this document, a Curves eyedropper at a point, or painting with
  all-layer sampling): the layer stack, canvas, color data, patterns and global light;
- a translation, alignment or distribution: also the linked layers it moves and `~linkGroups`;
- a name (`layer: "Title"`): that the name still names that layer;
- other layer names (`image.measure.with`, render targets): the same name premise, scoped to layers. Addressed channels, saved paths, comps, notes, slices and guides retain identity when the format can prove it. Deletion reports `deleted`; an index or source name naming another member reports `relocated`. A change to an assigned field reports `changed`, including an assignment equal to the colleague's new value. A foreign PSD rewrite can invalidate private resource keys, in which case identity is unproven;
- a point (`at`): that the same layer is under it; the kit refuses when it cannot tell;
- an index (`layer: "#2"`): that the same layer is still the 2nd from the top; a layer others
  added, deleted or moved above it refuses the write as `relocated`, and `now.spelled` says where
  that layer is now (`"#3"`); a change below it does not;
- the layer a command acts on, by `layer`, `at` or as the active layer when the call names none:
  what its handler reads or replaces of it: the effects for a layer style, the mask for a mask
  command, the vector mask, the content (type, shape, adjustment, fill, editable filters) for those
  commands, the name for a rename, the visibility for show and hide, where it is for Arrange,
  and everything of it otherwise;
- a new layer (a new, fill, adjustment, type or shape layer, a paste, a place): where the active
  layer it goes above (or into) is, its kind and its clip;
- the selected layers a command acts on when the call names no `layer`: each, as for one layer;
- the layer below for Merge Down and Stamp Down;
- the image's own fields and members a command reads: the canvas size for a crop, a rotation, a
  canvas or image size (and the resolution); the mode, depth, profile, color table and duotone
  for a mode or profile conversion; the notes, counts and measurement scale, slices, timeline,
  variables, guides, channels, saved paths and metadata a command addresses by index or name,
  or changes; the composite for a flatten, merge or stamp of what is visible, a trim, a reveal
  all, an indexed, bitmap or multichannel conversion and the commands that rewrite every layer
  of a kind;
- anything else: everything of the layers it names.

A command that does not read the active layer takes `layer` by its id only; a name or `"#n"` there
is refused.

The independent declaration audit reads every write handler and compares the frozen readings with the declared holds at field paths. Source-backed refinements and their outside-writer tests live beside that audit. Commands that change only session libraries or other files hold no document fields.

These premises follow the stored inputs the command reads or replaces. Ordinary raw-pixel
fills and filters do not hold clipping, display opacity, an adjustment above the target, or
unrelated linked layers merely because those affect the preview. Composite sampling holds
that appearance. A point follows Move Auto-Select (including masks, group visibility and
locks), not the composited color. Historical null bounds cannot prove a deleted layer missed
the point, so the kit refuses when it cannot reconstruct the pick. Composite sampling holds
the whole layer tree, including Clone/Healing Brush's `currentAndBelow` mode; a change above
the sampled subset or to a layer's name can conservatively refuse it. Channel source fingerprints are compared for the addressed channel. Link memberships and inherited locks remain aggregate inputs; unrelated changes to those aggregates can conservatively refuse a write.

Receipts tell pixel changes per tile (`tiles.1,0`) and a layer's non-transparent extent as
`~bounds`; a change of the image's own fields (its size) names it `image`. A `.psd` stores a
layer's opacity and fill in 8 bits: the value you set is kept as the file stores it (`0.37`
becomes `94/255`, `0.3686…`), and the receipt says so. A `.psd` still stores type and shape
layers otherwise than the image holds them (colors, path anchors in fixed point, the type's own
blocks): after a `.psd` with type or shapes is edited elsewhere, those layers read as changed by
others; prefer `.kphoto` when several write the same image.

Object-model batches enforce the engine's numeric limits: width and height 1–25600 (so a
layer's `tiles` map stays under about 10,000 tiles),
DPI 1–30000 (Image Size itself clamps to 10000), and layer opacity and fill opacity 0–1.
Batch values settle to the engine's float precision, and for PSD/PSB to their stored
opacity bytes and 16.16 DPI. Mask density also settles to a PSD byte. Surface `props`
declares density and opacity 0–1 and feather at least zero through JSON `members` limits.
The kit checks nested vector-mask density/feather and effect fraction/range limits atomically;
the SDK's `members` declarations address immediate members only. Command schemas carry the
numeric ranges for canvas sizes, resolution, mask controls and effect percentages/scales.

A created layer must be placed in `image.layers`; only a group can hold child layers.
Missing raster/group defaults are filled before the receipt; other kinds require `data`.
Deleting the final layer leaves an empty layered PSD/PSB, rather than a new Background.
Deleting a layer also deletes what it holds (its mask, text body, styles and video frames);
deleting a channel deletes its private surface. A batch cannot delete a group that still
has children: delete descendants first, or use `layer.delete` to delete the group and its
descendants in one command.

## Outside writes and session continuity

The address, resource, tree and derived-input matrices use independent writers that reopen and rewrite the file between observation and execution. Applying cells compare the complete saved document and pixel hashes. The mixed-round table retains its fixed seed and necessity rules. These tests sample supported dimensions; they do not establish exhaustive coverage of point occlusion, object-layer propagation or derived-result combinations.

An outside reread reconciles the file into the live replica while retaining the editor target, selection and local history. A deleted active target retains its missing identity, so a stale implicit write refuses instead of selecting a neighbour. Prefix planning uses an isolated document with editor state and blobs, allowing later steps to hold the objects selected or created by earlier steps.

Recursive labels hold descendant identities and labels on their group. Mask flags and vector-mask properties hold their addressed paths. Linking holds the selected link fields and the group memberships used by allocation and cleanup. Same-field assignments remain protected.

Private hit-test state and resource fingerprints serve premise comparisons and are marked as premise-only. Public receipts omit these private facts from created, changed and deleted objects while preserving the public receipt structure. Hit-test payloads use bounded immutable storage and compact private references. An evicted historical payload refuses as unknown. Optional receipt values may be absent. Raw model operations declare direct premise contracts and keep the model's validation and canonicalization.

Agents cannot replay Last Filter, Transform Again or snapshot-based undo from unreplicated session history. Give concrete filter or transform parameters. Background image jobs compare their input snapshot at write-back and discard results after document changes, including unrelated changes.

## Workflow

1. `photo_inspect` for the canvas, the layers and a preview.
2. Find the command: `photo_commands { "query": "new layer" }`. Use specific words
   (`"rectangular selection"`, `"fill"`, `"text"`, `"hue saturation"`). Use the exact id it returns
   and follow its parameter schema; never guess a command id.
3. `photo_run` a few steps at a time: select, act, deselect. A run saves when it succeeds.
4. `photo_check`, then fix what it reports; most diagnostics carry a `fix` with the layer id.
5. `photo_inspect` again to confirm the layers and the preview.

## Common tasks

| Need | Command and parameters |
|---|---|
| New empty layer | [`layer.new.layer`](/kits/photo/commands/layer.new.layer/) `{ "name": "..." }` |
| Rectangular selection | [`select.rect`](/kits/photo/commands/select.rect/) `{ x, y, width, height }` |
| Fill the selection | [`edit.fill`](/kits/photo/commands/edit.fill/) `{ "color": "#rrggbb" }` |
| Deselect | [`edit.deselectAll`](/kits/photo/commands/edit.deselectAll/) |
| Type layer | [`text.add`](/kits/photo/commands/text.add/) `{ x, y, text, size, color }` |
| Show a hidden layer | [`layer.showLayers`](/kits/photo/commands/layer.showLayers/) `{ "layer": id }` |
| Delete a layer | [`layer.delete`](/kits/photo/commands/layer.delete/) `{ "layer": id }` |
| Hand over a flat image | `photo_export { "path": "...", "format": "png", "to": "name.png" }` |

`photo_export` writes the image as a **new** file and keeps the layers. `to` is a new path in the
workspace whose extension matches `format` (`png`, `jpg`, `tiff`, `webp`); an existing file is never
replaced.

## Example 1: add a red badge and a caption

On a 320 × 200 image with one `Background` layer:

```json
photo_run {
  "path": "poster.psd",
  "steps": [
    { "command": "layer.new.layer", "params": { "name": "Badge" } },
    { "command": "select.rect", "params": { "x": 220, "y": 120, "width": 60, "height": 40 } },
    { "command": "edit.fill", "params": { "color": "#c0392b" } },
    { "command": "edit.deselectAll", "params": {} },
    { "command": "text.add", "params": { "x": 40, "y": 170, "text": "Summer sale", "size": 20, "color": "#000000" } }
  ]
}
```

It answers `"layer": 3` for the new layer and `"layer": 4, "bounds": [41, 155, 162, 171]` for the
text, and the summary becomes `3 layers`. `photo_inspect` then lists `Summer sale` (Type, Inter
20 pt), `Badge` (Pixel, bounds `[220, 120, 60, 40]`) and `Background`. Export it:

```json
photo_export { "path": "poster.psd", "format": "png", "to": "poster.png" }
```

It answers `Exported poster.psd as PNG to poster.png` with `"files": [{ "path": "poster.png", "created": true }]`.

## Example 2: show a hidden layer the check reports

```json
photo_check { "path": "hidden.psd" }
```

It answers `{ "code": "photo.hidden-layer", "message": "Layer \"Badge\" is hidden: …",
"target": { "path": "layer:3" }, "fix": { "command": "layer.showLayers", "params": { "layer": 3 } } }`.
In the same session, run the fix:

```json
photo_run { "path": "hidden.psd", "steps": [{ "command": "layer.showLayers", "params": { "layer": 3 } }] }
```

`photo_check` then answers `the kit found nothing wrong`.

## Pitfalls

- **Select first.** [`edit.fill`](/kits/photo/commands/edit.fill/) fills the selection, or the whole
  layer when nothing is selected. Deselect ([`edit.deselectAll`](/kits/photo/commands/edit.deselectAll/))
  after the fill so the next command doesn't act on it.
- **New layers start empty.** Fill a new layer, or delete it.
- **Text:** [`text.add`](/kits/photo/commands/text.add/) uses Inter unless you give `font`.
- **Ids after edits elsewhere:** a layer id you noted stays its layer's id, but someone may have
  deleted that layer or made new ones since. Inspect before acting on an id from an earlier
  conversation.

## Checks

`photo_check` lists what is wrong with the image. Each diagnostic has a stable `code`, a `severity`
(`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a command step to
run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it only when it is
what the person asked for. Every code the kit reports is on the [checks page](/kits/photo/checks/).

- `photo.missing-object-source` (error): an object layer linked to a missing file shows nothing.
  Embedding or relinking needs the person's file.
- `photo.off-canvas` (warning): a layer moved entirely outside the canvas.
- `photo.empty-layer` (info): a layer with no pixels. Fill it, or delete it with the diagnostic's
  `fix` ([`layer.delete`](/kits/photo/commands/layer.delete/)).
- `photo.hidden-layer` (info): a layer saved but not shown. Its `fix` is
  [`layer.showLayers`](/kits/photo/commands/layer.showLayers/); show it only when the person wants
  it visible.
- `photo.font-substituted` (info): a font that isn't installed here is drawn with a substitute; the
  file keeps the font name. The same code names characters that no available font can draw (with
  their code points): they show as a box, so pick a font that has them or change the text.

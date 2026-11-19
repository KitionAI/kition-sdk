---
name: motion-editing
description: "Create, inspect, edit and check a motion graphics project (.kmotion) with the Kition Motion kit's tools: compositions, layers, keyframes, effects, masks, text, and more. Use when the user asks to make, read, change, review or fix .kmotion files in this project."
---

<!-- Generated from kition-motion agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`motion_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`motion_run` is `mcp__kition__kit_run`, `motion_check` is `mcp__kition__kit_check`).
With KITION_KITS_UNIFIED=false they are `mcp__kition__motion_<action>`. Paths are relative to the
workspace folder.

# Motion kit

The Motion kit opens, edits and checks motion graphics projects (`.kmotion`) and exports them as
MP4. It works like After Effects: a project holds compositions, a composition holds layers, and
layers have transform properties you animate with keyframes. An agent can set up compositions, add
solid, text and shape layers, apply effects, layer styles and text animation presets, ease
keyframes, move cameras, build transitions, check the project for missing footage, broken parents
and mattes and for type that reads poorly on video, and export the active composition to MP4.

## Tools

The kit's prefix is `effect`. Its tools are:

| Tool | Does |
|---|---|
| `motion_inspect` | The project as JSON (the comp open in the editor, its layers, what is animated, design advice); with `preview: true`, a frame or a contact sheet of frames |
| `motion_query` | Reads objects of the project's object model by id, or by following fields from the root |
| `motion_commands` | Finds commands by keywords, each with its parameter schema |
| `motion_run` | Runs a list of command steps |
| `motion_batch` | Runs one batch of object-model operations |
| `motion_check` | What is wrong with the project, as diagnostics |
| `motion_create` | Makes a new `.kmotion` project |
| `motion_export` | Renders the active comp to a new MP4 file |
| `motion_draft_ready`, `motion_draft_reopen` | Asks the person to review your draft, or takes it back to edit |

Every tool takes `path`, the project's path in the workspace. With `draft: true` your edits go to
your draft of the project and leave the file as it is; only the person merges or discards a draft.

## Addressing and coordinates

- **Project items** are compositions, footage (a video, image or audio file), solids and folders.
  Each item has a numeric `id`. `Project.items` lists them for queries;
  list moves are invalid. The project panel sorts folders first, then names.
- A **composition** (comp) has a width, height, frame rate, duration and background.
  `motion_inspect` reports the comp open in the editor (`details.comp`; in a file nobody has open,
  the project's first comp) and its layers (`details.info.layers`). The current time and which
  layers are selected are the editor's, not the project's, and are not in the details: moving the
  current time or selecting layers changes nothing you read.
  [`project.summary`](/kits/motion/commands/project.summary/) lists every comp (`type`
  `Composition`) with its `id`; [`comp.info`](/kits/motion/commands/comp.info/) `{comp}` lists a
  comp's layers.
- **Layers** stack in a comp: `index` 1 is the **top** layer, and stack positions count from 1.
  Each layer has a numeric `id`, a `type` (Solid, Text, Shape, Footage, Comp, …), `in` and `out`
  points, and transform properties (anchor, position, scale, rotation, opacity).
- Name layers by their numeric **`id`** (`layer: 51`, `layers: [51]`, or a step's `on: [51]`),
  and the comp by its id (`comp: 1`, or a step's `at.part: {"comp": 1}`; without either, a command
  acts in the comp open in the editor). An id may also be written as the string a receipt prints
  (`layer: "51"`, `on: ["51"]`, `{"comp": "1"}`). Receipts, `others` and `motion_query` print ids
  as numbers. A stack position (`"#3"`) or a time (`at.time`) is a **place**, not a layer: it names
  whatever is there when the step runs. Pass `basis` with every write that names a place (see
  [Others' changes](#others-changes)); a number no layer has as its id is read as a stack position
  too, which nothing checks. Use ids. Read ids from `motion_inspect` or from the result of
  the command that made the layer ([`layer.newText`](/kits/motion/commands/layer.newText/) →
  `{layer: 51}`).
- Name properties by **path**: `transform/position`, `transform/opacity`, `transform/scale`,
  `transform/rotation`. `prop` is a property's uid, not its name. Each entry of
  `details.info.layers[].animated` (`{path, name, times}`) names its property by such a path
  (`effects/#2/blurriness`): pass it unchanged as the `path` of `prop.*` commands on that layer.
- **Positions** are pixels in the comp, with `(0, 0)` at its top-left corner and `y` growing down.
  Text `size` is in pixels. Rotations are in degrees; opacity runs from 0 to 100.
- **Time is in seconds.** Comp time runs from 0 at the comp's first frame; a layer's own time
  (layer time) runs from 0 at the layer's start, which is `start` seconds into the comp (`in` and
  `start` differ for a trimmed layer). How each time is meant:

  | Time | Base |
  |---|---|
  | a step's `at.time` | comp seconds, always |
  | `time` of [`prop.set`](/kits/motion/commands/prop.set/), [`prop.addKey`](/kits/motion/commands/prop.addKey/), [`keys.set`](/kits/motion/commands/keys.set/) (and its `newTime`), [`keys.select`](/kits/motion/commands/keys.select/)'s `keys[].time`, [`keys.applyEase`](/kits/motion/commands/keys.applyEase/)'s `from` and `to` | layer seconds, or comp seconds with `timeBase: "comp"` |
  | `time` of [`keys.setEase`](/kits/motion/commands/keys.setEase/) and [`keys.setSpatialTangents`](/kits/motion/commands/keys.setSpatialTangents/) | layer seconds only |
  | `time` of [`prop.get`](/kits/motion/commands/prop.get/) and [`layer.tree`](/kits/motion/commands/layer.tree/); `in`, `out` and `start` of [`layer.timing`](/kits/motion/commands/layer.timing/); `start` and `frame` of the presets below; a preview's `target.time` and `target.range` | comp seconds |
  | the `times` of `details.info.layers[].animated` | comp seconds |
  | a key `prop.get` answers | `time` and `layerTime` in layer seconds, `compTime` in comp seconds |

  A command whose `time` is left out acts at the comp's current time, which is comp time
  (`prop.addKey` without `time` keys the layer at the layer time showing then). Name that time
  with the step's `at.time`, never by moving the current time first. Preset lengths such as
  `frames` and `stagger` are frames of the comp.
- Colours are `"#rrggbb"`.
- Diagnostics name a layer as `comp:<id>/layer:<id>` and a project item as `item:<id>`.

### The object model

`motion_query` and `motion_batch` work on the project's objects. Reach them by following fields
from the root (`Project`), positions counting from 0:

| `follow` | Reads |
|---|---|
| `items` | Every project item (`kind`: `comp`, `footage`, `solid` or `folder`; `name`) |
| `items.0.comp` | The composition of a comp item |
| `items.0.comp.layers` | Its layers, top first; each has a `name` |
| `items.0.comp.layers.0.props.children` | The layer's property groups; a property's `keys` are its keyframes |
| `renderQueue` | The Render Queue's entries |

A folder's contents are the items whose `parent` names it. Rename a layer with one
`set`: `motion_batch {"path": "Intro.kmotion", "ops": [{"op": "set", "target": "<layer's object
id>", "field": "name", "value": "Title"}]}`.

Items and layers are named by the numeric ids `motion_inspect` lists and the commands take
(`"51"` is layer 51, `"1"` comp 1's item), the same after the project is saved and opened again.
Model references remain usable through an outside reread in the same live session. Reobserve
after restarting or reopening the session. Commands still take the item's or layer's numeric id.
For most edits a command (`motion_run`) is simpler. Raw layer-name, layer/composition
attribute-map and key-value assignments have declared batch-write contracts. Key-list
remove, insert and move operations, key creation, item creation/deletion, owned property-group
creation and composition-layer reordering also have guarded contracts. Other
structural operations refuse before execution unless their contracts have been verified.
`Project.items` is an unordered query view. Render Queue entries have stable `render:<id>` ids.

### What a write changed

A `motion_run` answers `changes`, named by the same ids. A change inside a layer (a property's
value, a keyframe added, moved or changed, an effect or a mask) is told as a change of the layer:
`field` is the path in the object model (`props.children.2.children.7.value.v`), and `named` the
same place in the words `prop.*` commands take (`transform/opacity.value.v`; the part before the
first `.` is the property's `path`; `effects/#2/blurriness` for the second effect). One exception:
in a shape layer where a group's display name is the match id of a sibling (a group renamed
`rect` before two rectangles), `named` counts siblings by match id only and the commands also by
display name, so check with `prop.get` before you write by such a path. A layer's own timing is
`startTime`, `inPoint` and `outPoint` (ticks, 254016000000 a second): shifting a layer in time
changes those three fields, not its keyframes (they are in layer time), so the receipt does not
list the keys whose comp time moved. A layer moved in the stack is one entry of `moved`; the layers
whose position it shifted are not listed. A marker is a member of its comp's or layer's `attrs`
(`comp.attrs.markers.0.time`).

### Others' changes

Pass `basis` (the `revision` of your last answer) with every write. Others (another agent, or
another program changing the file) may have changed the comp since; `others` in the answer says
what, by the same ids. With `basis`, a write is refused as a whole (`error.code: "conflict"`,
nothing run) when what it acts on changed. One rule decides every case, in two halves: a write is refused when
others changed **what it lands on**, or **a fact its result is computed from** (what the command's
code reads); it applies after any other change, and the saved result is both edits. What a write
lands on is what its address names as you observed it: an address by time (a comp time, a
layer marker at a time, a key at a time) is a positional address, like an index, and a change by
others after which something else is at that time (a layer shifted or stretched under it, a key
or marker moved there or away) refuses it, even where the code reads nothing else there; a
change after which the same thing is at that time (another marker, another key, another layer)
does not.

A field a write assigns is also held, including an absolute assignment: another writer's change
to that same field refuses `changed`, so an absolute value cannot silently erase their edit.

- **By id** (`layer: 51`, `on: [51]`): the layer deleted (`deleted`), what the step reads of it
  changed (`changed`), or the layer moved in a way the step depends on (`relocated`, `now`
  saying where: restacked or a layer put or taken above it, `now: {parent, field: "comp.layers",
  index}`, or shifted or trimmed in time, `now: {startTime, inPoint, outPoint}`, ticks). What a
  step reads depends on the command: [`layer.rename`](/kits/motion/commands/layer.rename/) the
  name; `prop.set` of a property with no keys that property alone, wherever the layer is (an
  opacity set after a layer was added above applies); `prop.set` of an animated property,
  `prop.addKey` and `keys.set` the key at the time it writes, followed by that time across
  others' saves (another key added, moved or changed does not refuse it), and where the layer
  starts in time and its stretch, not its place in the stack. With
  `selected: true`, a property named by `prop` (its uid) or by a path with `#n` in it, or Position
  with Separate Dimensions, and in remaining branches without narrower premises, the kit uses a
  general object premise. Any change of that layer can refuse it. Position-independent scalar
  assignments include rename, comment, blend mode, quality, sampling and frame blending.
  `layer.timing` reads the layer's start, In and Out, never its place in the
  stack: a layer put or taken above it, or the layer restacked, does not refuse it.
- **By name** (`layer: "Title"`): as by id for the layer the name names now, and its name (the
  first layer from the top with that name). Its place in the stack is not read: a layer put or
  taken above it, or the layer restacked, does not refuse it.
- **By place** (`"#3"`, a number no layer has as its id, or `at.time` with no layer named): the
  place must name what it named at `basis`, and what the step reads of that layer is checked as by
  id. `"#3"` after a layer put or taken above it is refused as `relocated`; the conflict names the
  layer `"#3"` named then (`id`), where it is now (`now`), and the place as you gave it with what
  it names now (`place: {"layer": "#3", "under": [148]}`). A write by `"#3"` after someone changed
  that layer's opacity is refused as `changed`. A time with no layer named checks which layers were
  alive at that time, replayed from their In and Out points: a layer moved next to the time does
  not refuse it.
- **A comp marker** edited by `markers.set` holds the marker it names: by `at`, the marker at that
  time (a marker added before or after it does not refuse it; a change of that marker does, as
  `changed`); by `index`, the marker at that index (a marker added before it refuses it, since the
  index then names another marker). A new marker (`comp.addMarker`, `markers.set {new: true}`) and
  the other marker commands hold the comp's markers. A layer added or edited refuses none of them.
  A layer marker edited by `markers.set` holds that marker the same way and the marker lock; by
  `at` (or setting its `time`) also the layer's start and stretch, through which a comp time is
  converted to the layer time it is stored in; by `index` alone neither. `layer.addMarker` holds
  that layer's markers, marker lock and stretch, and its start time. None depends on the stack.

Object parameters also hold their resolved names, including nested key and pick-whip layer
references. Reparenting with compensation holds the transforms of the old and new parent chains;
renaming an old parent does not change that transform premise. A local authored property write
does not freeze the rendered appearance of its parent, matte or precomposition. Layer Control
values hold the layer they reference. Arbitrary expression text and commands that evaluate a
composition can still read dependencies the guard does not enumerate; inspect again before
relying on a rendered result after others changed those dependencies.

A direct key move holds keys currently between its source and requested destination, since
they can clamp the move. An inserted blocking key refuses it; a key beyond the destination
does not. Historical removals of blocking keys are not covered by this declaration.

`keys.set` holds the nearest key it actually edits as well as the requested time. A sampled
`prop.addKey` and `prop.set` between keys hold both interval endpoints, including their easing.
Key selection holds every selected entry; subsequent delete/move/transform holds that selection
and the layer's time mapping. `layer.timing` holds the layer's start, In and Out, which it shifts
or sets; it does not read its place in the stack.
`comp.workArea` holds the stored work area, frame rate and duration used by its clamp.

### Conflict coverage and limits

The frozen handler readings live in `bindings/wasm/tests/declarations_independent_r2.rs`
and its family files. `declarations_r2_comparison` compares their dependencies with the
kit's declarations. Its object-class comparison is incomplete and does not establish
field-level coverage. Earlier declaration checks remain in place.

The guard holds assigned fields even for absolute assignments. It also holds the composition
attributes and source dimensions explicitly declared by the command. Same-switch writes,
tracker option assignments, source-user membership, named property addresses and composition
settings have independent file-rewrite tests. Other layers, expression and rendering closures,
project settings, queue operations and dynamic dispatch still have incomplete declarations.
Conservative whole-object holds can refuse unrelated edits.

Outside rereads reconcile the file difference into the existing replica. Property references
and agent undo history survive; undo retains the colleague's independent edit. An editor
identity that no longer resolves refuses reread and keeps the previous session. Commands in a
premise plan run on an isolated document copy.

All-mask assignments hold a private membership fact through a scoped content comparison.
Deletion refuses; geometry changes and member reordering remain independent. Composition
layer membership and resize-input facts are also private to the guard.

An exact-time key edit holds the requested time selector independently of the other keys.
Its large-history tests allow unrelated insertions and refuse deletion of the addressed key.
Nonexact nearest-key addresses still depend on bounded membership history; private key-time
facts are not fully adopted. Invalid `on` on an objectless model command can be reported as a
conflict before context validation. Remaining context and raw-contract gaps stay asserted by
their waiting tests.

Raw batch writes declare contracts for `Layer.set.name`, `Layer.map.set.attrs`,
`Comp.map.set.attrs` and `Key.set.value`. `Node.keys` remove, insert and move operations
and `Key.create` use mapped contracts with retained recipients, destination gaps and isolated
prefix state. Owned `Node.create` and `Comp.layers` moves retain historical list recipients
and gaps; mapped `Item.delete` holds the content and consumers it erases. Item creation uses
the SDK's ordinary typed-reference contract. Private facts support these comparisons.
Outside-created receipts can still expose private fact names; the privacy regression remains failing. Other structural classes
remain unavailable pending verified contracts. A retained key-value write can still falsely
refuse after an earlier key is deleted. The raw-batch and time matrices retain their intended
outcomes independently of these known failures.

After a refusal, inspect or query again, review `others` and `conflicts`, then decide what to
write with the new `revision` as `basis`. Do not advance `basis` and repeat an unchanged write
without reviewing what changed.

## Workflow

1. `motion_inspect {path}`: the comp, its layers with ids, in and out points, what is animated;
   add `preview: true` to see it (see [Previews](#previews)).
2. `motion_commands {path, query}`: find commands by keywords (`"text layer"`, `"keyframe add"`,
   `"comp settings"`). Use the exact id it returns and follow its parameter schema; never guess a
   command id.
3. `motion_run {path, steps}` a few steps per call. Name what each step acts on, where and when
   (see [Steps](#steps-on-and-at)); never open a comp, move the current time or select layers
   first just to aim a command. A failing step stops the call and the kit undoes the steps before
   it, so the project is as it was before the call and nothing is saved: read `error.index` for
   the failing step, fix it, and send the whole run again. A call that succeeds saves the project
   (`save` defaults to `true`).
4. `motion_check {path}`: fix what it reports, then check again. A diagnostic's `fix` is the exact
   command and params. Info diagnostics on the active comp are design advice: run their fixes, or
   do better than them, before you export.
5. Look at the frames you changed: `motion_inspect` with `preview: true` and a `target.time`, or a
   `target.range` for motion.
6. `motion_export {path, format: "mp4", to: "<new file>.mp4"}` renders the active comp. An export
   never replaces a file: when `to` exists the kit writes `<name> 2.mp4`; read `files[].path`.

## Steps: on and at

A `motion_run` step is `{ "command", "params"?, "on"?, "at"? }`:

- **`at.part`** names the step's comp, `{ "comp": <id> }` (the item id `project.summary` lists, as
  a preview's `target.comp` names it). The run's `target: { "comp": <id> }` names it for every step
  without its own `at.part`. Without either, the step acts in the comp open in the editor.
- **`at.time`** is seconds of the step's comp time (never layer time): the comp's current time is
  set there for the step, on the start of the frame showing it, as a preview draws `target.time`
  (at 30 fps, 1.25 s is frame 37, at 1.2333 s). It must lie from 0 to before the comp's end;
  else the step is refused with the range. Commands that act at the current time act there.
- **`on`** lists the layer ids the step acts on, as `motion_inspect` lists them (`id` in
  `details.info.layers`), all in the step's comp. A command with a `layers` or `layer` parameter
  gets them there (one id for `layer`); a command that acts on the selected layers acts on
  exactly these. `on` takes ids: a stack position (`1`, `"#1"`) is refused, and so is a layer of
  another comp, which the error names with its comp.
- **Keyframes have no ids.** Commands that act on the selected keyframes
  ([`keys.easyEase`](/kits/motion/commands/keys.easyEase/), `keys.move`, `keys.delete`, …) need
  them selected by [`keys.select`](/kits/motion/commands/keys.select/)
  `{keys: [{layer, path, time}]}` in an earlier step of the same run; `on` keeps the keyframes
  selected on the layers it names.
- After the run, and after a failed run is rolled back, the comp open in the editor, every
  comp's current time and the selections are what they were before it. A command you give its
  `layers`, `layer`, `comp`, `time` or `frame` leaves them as they were even inside the run,
  unless moving them is its work (`comp.open`, `time.set`, `layer.select`, `keys.select`, …) or it
  made a layer or a comp: what a step makes is selected (a new comp is open) for the next steps
  of the same run, so a step without `layer` or `on` acts on it.

Each command's schema says what it acts on (`x-khp-role: targets` on its `layers` or `layer`) and
what it reads besides its parameters (`x-khp-reads`: `selection`, `part`, `time`).

## Previews

`motion_inspect` with `preview: true` draws the composition with the kit's render command,
[`file.render`](/kits/motion/commands/file.render/). What it shows is named in `target`, never
taken from the current time or the comp open in the editor, so the same call shows the same
picture every time:

- **One frame:** `target: { "time": 1.5 }` is the frame showing 1.5 s after the comp's start (comp
  seconds, 0 at its first frame whatever its start timecode; from 0 to before its end).
- **Motion over a span:** `target: { "range": [2, 6], "frames": 6 }` is one picture of 6 frames
  (2 to 12) spread evenly from 2 s to 6 s, both included, in a grid in reading order; each frame
  has its time burned into its bottom-left corner. A range ending at the comp's end shows its last
  frame.
- **The whole comp:** without a `target`, a contact sheet of up to 6 frames from start to end.
- **Which comp:** `target.comp` is the comp's item id (`details.comp.id`). Without it the preview
  is of the project's main comp: the only comp no other comp uses as a layer (a nested precomp is
  part of the comp it is in). A project with several such comps has no main one: name it, and the
  error lists the comps to choose from with their names and durations.
- **A layer:** `target: { "path": "comp:1/layer:51" }` (a diagnostic's target) shows the middle of
  the time layer 51 is visible in comp 1; add `time` or `range` to show another moment of comp 1.
  `item:<id>` names a comp as well.
- **Size:** `scale` is picture pixels per comp pixel (up to 2, default 1; each frame of a contact
  sheet is drawn at it) and `maxSize` the most pixels on the longer side (16 to 4096, default
  1024); a larger picture is drawn at a smaller scale.

A time outside the comp, an unknown comp id or an unnamed comp where the project has several is an
`invalid_params` error that gives the valid range or lists the comps.

## Common tasks

### Making it look designed

Videos left at the kit's defaults look flat and plain: one flat background colour, thin small type,
nothing with a glow or a shadow. Each of these takes one step:

- **Read the advice.** `motion_inspect` answers `design`: what a motion designer would point out in
  the active comp, each with commands to `try`. A command written `id {json}` runs as written, with
  the comp's own layer ids and colours.
- **Background depth.** A radial Gradient Ramp of the background's own colour, lighter behind the
  subject and darker at the edges (`shape: 1` is radial; points are comp pixels), or
  `CC Vignette`. A linear ramp alone still reads flat.
- **Depth on elements.** [`layer.style.add`](/kits/motion/commands/layer.style.add/)
  `{style, layers, params}` adds the style with its settings: `outerGlow` `size` 30–40 at 1080p
  (the style's own 5 px barely shows), `dropShadow` `distance` 8–14 and `size` 24–32 under cards
  and text. [`layer.style.list`](/kits/motion/commands/layer.style.list/) `{layer}` shows the
  settings and their paths.
- **Effects in one step.** [`effect.apply`](/kits/motion/commands/effect.apply/)
  `{effect, layers, params}` sets the effect's settings as it applies it (names as the effect lists
  them, or their display names, in any case). The answer lists every setting with its path
  (`effects/#1/blurriness`) for [`prop.set`](/kits/motion/commands/prop.set/) and
  [`prop.addKey`](/kits/motion/commands/prop.addKey/). A wrong name changes nothing, and the error
  lists the right ones. Effects start at After Effects' defaults: Gaussian Blur, Fast Box Blur,
  Directional Blur, Sharpen and Noise start at 0, where they change nothing, so give the amount
  (`{"Blurriness": 30}`, `{"Blur Length": 40}`).
- **Gradient shapes.** [`layer.newShape`](/kits/motion/commands/layer.newShape/)
  `{kind: "rounded", size: [640, 360], position: [960, 540], fillGradient: ["#6366f1", "#a855f7"],
  fillAngle: 90}`: the stops spread evenly, and the angle is in degrees (0 runs left to right, 90
  top to bottom); `fillType: "radial"` makes a radial one.
- **Type.** A title is 8–12 % of the frame height (90–130 px at 1080p) in SemiBold or Bold; body
  text is at least 3 % (32 px), Medium or heavier. Give text an entrance
  ([`layer.applyTextPreset`](/kits/motion/commands/layer.applyTextPreset/), below).

### Promo motion

Promo-video motion (tuned at 30 fps) takes a few commands instead of hand-built keyframes and
expressions. Each command is one undo step; times are comp seconds unless noted, and durations are
frames of the comp.

### Easing

[`keys.applyEase`](/kits/motion/commands/keys.applyEase/) `{layer, path, preset | bezier:
[x1,y1,x2,y2], from?, to? (layer s)}` eases every segment between consecutive keys of one property.
Curves are CSS `cubic-bezier` values turned into exact keyframe speed and influence.
[`keys.easePresets`](/kits/motion/commands/keys.easePresets/) lists them.

| Preset | Curve | Use |
|---|---|---|
| `snappy` | (0.16, 1, 0.3, 1) | entrances, pushes, cards arriving |
| `out` | (0.22, 1, 0.36, 1) | text and elements sliding or fading in |
| `smooth` | (0.65, 0, 0.35, 1) | between two resting states, camera returns |
| `swift` | (0.4, 0, 0.2, 1) | sweeps, wipes, sheens |
| `settle` | (0.3, 0, 0.25, 1.15) | lands 15 % past and settles: drops, scale-ins |
| `pop` | (0.2, 1.25, 0.3, 1) | early burst past the target: pop-ins, badges |
| `reseat` | (0.4, 0, 0.3, 1.05) | small 5 % overshoot when re-seating |
| `fly` | (0.34, 1.4, 0.44, 1) | big overshoot: flying in from off screen |
| `linear` | — | constant speed: spotlight travel, scrolling |

Overshoot curves are exact on ordinary properties (the value goes past the key and back). On a
motion path (Position, effect points) the curve is split at the turning point and a key is inserted
there (`insertedKeys` in the answer).

Springs (`crisp` d18/s170/m1, `lively` d12/s170, `noBounce` d26/s170, `cardFlip` d15/s190, or
`spring` with `damping`, `stiffness` and `mass`) attach an expression: the motion into the **last**
key becomes a damped spring that starts at the key before it, overshoots and settles; the spring
sets its own length (`crisp` settles in about 0.6 s). Use a curve when the landing must hit an exact
frame, and a spring for physical, bouncy landings.

### Text presets

[`layer.applyTextPreset`](/kits/motion/commands/layer.applyTextPreset/) `{layer, preset, start?,
frames?, stagger?, ease?, by?, …}` takes its timing in frames and `start` in comp seconds (default
the current time). Per-unit timing comes from an Expression Selector, so every word or character has
its own start, length and curve. Text with CJK characters goes per character (`by:
words|characters|lines` overrides it).

| Preset | Defaults | Overrides |
|---|---|---|
| `blurSlide` | per word: dy 64 px → 0, blur 18 → 0, opacity 0 → 1, `out` curve, 22 f, 4 f apart | `variant: subtitle` (26 px, 9, 20 f, 2.4 f), `dy`, `blur`, `frames`, `stagger`, `ease` |
| `letterpress` | per character: scale 1.6 → 1, blur 6 → 0, opacity, (0.2, 0.7, 0.25, 1), 12 f, 3 f apart | `scale`, `blur`, `frames`, `stagger`, `ease` |
| `leadWordZoom` | first word 2.3× centred, pushes 6 % over a 30 f `hold`, then (0.5, 0, 0.05, 1) over 24 f shrinks it as the line slides into place; other words push in 0.5 em over 12 f, 4 f apart | `scale`, `push`, `hold`, `frames`, `stagger`, `ease` |
| `typewriterFast` | 0.7 f per character, cursor `\|` blinking once typed (Source Text expression; centred one-line text becomes left-aligned in place) | `frames`, `cursor` (`""` = none) |
| `digitRoll` | every digit rolls like an odometer through one full 0–9 turn, (0.25, 0.8, 0.25, 1), 22 f, 4 f apart, tabular figures; adds a strip and a hidden window (its matte) per digit, parented to the text | `frames`, `stagger`, `cycles`, `ease` |
| `countUp` | the first number in the text counts from 0 with expo-out over 1.2 s, `,` thousands separators, prefix and suffix kept | `from`, `to`, `duration` (s), `decimals`, `separator` |

### Light

- [`light.spotlight`](/kits/motion/commands/light.spotlight/) `{target, layers?, start?, radius?:
  [400, 300], frames?: 24, dim?: 0.92, pulse?: 0.06, period?: 2, softness?: 22, spill?: 0.15,
  spillSoftness?: 60}`: a black solid at `dim` opacity above `layers` (default: on top of the comp)
  with a soft hole that follows the middle of `target` (Circle effects in Silhouette Alpha and a
  Gaussian Blur; the radius on a Spot Radius slider, `out` curve, then breathing +6 %).
- [`light.sheen`](/kits/motion/commands/light.sheen/) `{layer, start?, frames?: 32, angle?: 115,
  width?: 2, soft?: 0.14, core?: 0.5, color?, ease?: swift}`: one specular band swept once across
  the layer, clipped to its alpha (two CC Light Sweep effects driven by a Sheen Progress slider).
  Use it at most once or twice a film, on a resting hero element over a dark background.
- [`layer.liftShadow`](/kits/motion/commands/layer.liftShadow/) `{layer, elevation?: 3, to?,
  start?, frames?: 18, keys?: [[s, e]…]}`: an Elevation slider drives a contact shadow (opacity
  12 %/(1 + e/24)) and an ambient one (8 % + 22 %·min(e, 64)/64); key elevation 3 → 56 to lift a
  card.

### Camera

[`camera.move`](/kits/motion/commands/camera.move/) `{preset, target? | point?, start?, frames?,
layers?, …}` adds a new two-node camera parented to a 3D null at the target point (an orbit rig) and
makes `layers` (default the target) 3D; the camera starts at `start`.

| Preset | Move | Main overrides |
|---|---|---|
| `pushHover` | view 0.8× → 2.6× onto the target in 18 f (`snappy`) while the rig turns Y 34°, X 8°; hovers (slow drift); returns to 1× (`smooth`); 66 f in all | `from`, `scale`, `rotY`, `rotX`, `pushFrames`, `frames`, `ease` |
| `craneRise` | 1.5 % anticipation push (6 f), then 3× → 1× over 102 f with (0.2, 0, 0.25, 1), tilting up from X −8° | `from`, `scale`, `frames`, `rotX`, `ease` |
| `orbit` | the rig turns `degrees` (30) over 90 f through five keys with continuous, monotone velocity (never stops at a key) | `degrees`, `frames`, `scale`, `rotX` |
| `parallax` | no camera: `layers` far → near pan `distance` (600 px) × `speeds` (0.35, 0.7, 1.4) along `direction`; far layer blur 5 and 70 % desaturated, near layer blur 7 | `speeds`, `distance`, `direction`, `farBlur`, `farDesaturate`, `nearBlur`, `frames`, `ease` |

### Carries

A carry is a transition where something on screen survives the boundary and becomes the next beat,
instead of a cut, a fade or a dissolve. Pick the carry from what the two beats share: a subject the
next scene can open out of (`iris`), a card that becomes the next screen (`morphRect`), a detail the
camera can dive into (`zoomThrough`).

- [`transition.iris`](/kits/motion/commands/transition.iris/) `{layer, center?: [x, y] | layer,
  start?, frames?: 14, feather?: 0, ease?: swift, ring?: {color?, width?: 6}}`: a circular mask on
  the incoming `layer` (put it above the outgoing one) opens from `center` until it reaches the
  farthest corner. With a layer as `center` the iris follows that layer's middle every frame (an
  expression), so the next scene opens out of a moving subject. An Iris slider (0 → 1) on the layer
  drives it; `ring` strokes the edge from a new shape layer that lives only during the opening.
- [`transition.morphRect`](/kits/motion/commands/transition.morphRect/) `{from, to, start?,
  frames?: 18, ease?: smooth, radius?: r | [r0, r1]}`: a container transform. A rounded-rectangle
  container morphs from `from`'s on-screen rectangle at `start` (its corner radius read from a shape
  layer's rectangle, else 0) to `to`'s rectangle at the end. Both layers get a Morph mask that
  follows the container and a cover scale and position keyed every frame, so the outgoing content
  scales and crops into the incoming one; `to` fades in inside the container over the last third
  (and `from` fades out, when `to` sits below it). For a card that becomes the next full-frame
  scene, `to` is a full-frame layer. It works on unparented, unrotated 2D layers.
- [`transition.zoomThrough`](/kits/motion/commands/transition.zoomThrough/) `{layer, target?:
  [x, y], toLayer, start?, frames?: 12, size?: 48, overshoot?: 1.25, settleFrames?: 16, blend?: 2}`:
  a 2D push into `target` (comp pixels at `start`, default the layer's middle). The outgoing
  layer's scale grows in log space (constant apparent speed per octave, ease-in) until the `size`
  px around the point fill the frame while the point slides to the centre; once the frame is filled
  the upper of the two layers fades over `blend` frames (the lower one cuts underneath, so nothing
  behind shows through) and `toLayer` continues from `overshoot` × its scale, settling to 1
  (`snappy`) about the frame centre. Motion blur is on. Push into a word, a dot or an icon whose
  colour is the next scene's background, so the boundary is invisible.

### Impact and float

Both commands act on a layer (position, rotation) or a camera (`camera: true` or a camera layer:
position and point of interest move together, plus Z rotation) and are written as an expression
**on top of** what the property already does: its keys, or its existing expression, which runs
first. They are seeded and closed-form, so every render is identical.

- [`layer.shake`](/kits/motion/commands/layer.shake/) `{layer | camera, frame?: s, amplitude?: 14,
  rotation?: 1.5, decay?: 6, frequency?: 12, seed?: 1}`: a decaying shake from the hit at `frame`
  (comp seconds): three sines per axis at `frequency` Hz with seeded phases, scaled by
  exp(−decay·t), and exactly zero before the hit. Put it on the frame something lands
  ([`layer.hop`](/kits/motion/commands/layer.hop/)) or a word slams in. A full-frame layer shows its
  edges when it shakes: shake a camera, or scale the layer up a few percent; give layers that
  should move together the same `seed`.
- [`layer.handheld`](/kits/motion/commands/layer.handheld/) `{layer | camera, start?: 0, end?,
  amount?: 6, rotation?: 0.4, ramp?: 0.4, holds?: [[s0, s1]…], seed?}`: a slow two-sine float
  (0.1–0.3 Hz) between `start` and `end`, easing in and out over `ramp` seconds and exactly zero
  inside every hold, so a beat that must read (a number, a logo) sits perfectly still.

### Arrivals

- [`layer.hop`](/kits/motion/commands/layer.hop/) `{layer, to: [x, y], start?, frames?: 18,
  height?: 160, squash?: 0.25, stretch?, ringFrames?: 16}`: a 2D ballistic arc (x linear in time, y
  a parabola `height` above the line) that stretches along the flight with its vertical speed,
  lands squashed (125 % × 75 % at 0.25; the bottom of its content stays on the ground) and rings
  out damped over `ringFrames`. Position and Scale are keyed every frame; motion blur is on. Chain a
  [`layer.shake`](/kits/motion/commands/layer.shake/) on the landing frame (the answer's `land`)
  for weight.
- [`layer.gather`](/kits/motion/commands/layer.gather/) `{layers, start?, frames?: 30, center?,
  radius?: 120, stagger?: 2, arc?: 90, ease?: out}`: each layer flies along a spiral (radius and
  angle eased together) into its slot on a ring (slots from the top, clockwise, in `layers` order),
  all turning about `arc` degrees the same way, `stagger` frames apart. Position is keyed every
  frame; motion blur is on.

### Motion blur

Presets that move fast (`blurSlide`, `letterpress`, `leadWordZoom`, `digitRoll`, every
[`camera.move`](/kits/motion/commands/camera.move/)) turn on layer motion blur for the layers they
move and set the comp's shutter to 180° (never above 270°) at 10 samples; `motionBlur: false` leaves
it off. The renderer blurs layer and camera motion; per-character animator motion is not blurred,
which is why the text presets animate a real blur.

## Example 1: a designed title, exported as MP4

A new project is 1920 × 1080 at 30 fps. Make the background, the title and the subtitle:

```json
motion_run {"path": "Title.kmotion", "steps": [
  {"command": "comp.settings", "params": {"duration": 4}},
  {"command": "layer.newSolid", "params": {"name": "Background", "color": "#141b2d"}},
  {"command": "layer.newText", "params": {"text": "Kition", "position": [960, 500], "size": 150, "style": "Bold", "fill": "#ffffff"}},
  {"command": "layer.newText", "params": {"text": "Documents your agent can edit", "position": [960, 640], "size": 52, "style": "Medium", "fill": "#c7d2fe"}}
]}
```

Answer: `completed: [{command: "comp.settings", result: {duration: 4, frameRate: 30, width: 1920,
height: 1080}}, {command: "layer.newSolid", result: {layer: 4}}, {command: "layer.newText",
result: {layer: 27}}, {command: "layer.newText", result: {layer: 66}}]`. Then give the frame depth
and motion, by the new layers' ids:

```json
motion_run {"path": "Title.kmotion", "steps": [
  {"command": "effect.apply", "params": {"effect": "Gradient Ramp", "layers": [4],
    "params": {"shape": 1, "start": [960, 430], "startColor": "#3a4566", "end": [2208, 430], "endColor": "#090c14"}}},
  {"command": "layer.style.add", "params": {"style": "outerGlow", "layers": [27], "params": {"size": 38, "opacity": 60, "color": "#a5b4fc"}}},
  {"command": "layer.style.add", "params": {"style": "dropShadow", "layers": [66], "params": {"distance": 8, "size": 24, "opacity": 50}}},
  {"command": "layer.applyTextPreset", "params": {"layer": 27, "preset": "blurSlide", "start": 0.2}},
  {"command": "layer.applyTextPreset", "params": {"layer": 66, "preset": "blurSlide", "variant": "subtitle", "start": 0.8}}
]}
motion_check {"path": "Title.kmotion"}
→ {"diagnostics": []}
motion_export {"path": "Title.kmotion", "format": "mp4", "to": "Title.mp4"}
→ {"format": "mp4", "files": [{"path": "Title.mp4", "created": true}]}
```

## Example 2: fix what the check finds

```json
motion_check {"path": "Intro.kmotion"}
→ {"diagnostics": [{"code": "motion.missing-parent", "severity": "error", "target": {"path": "comp:1/layer:4"},
    "message": "Layer \"Background\" in \"Comp 1\" is parented to a layer that no longer exists.",
    "fix": {"command": "layer.setParent", "params": {"comp": 1, "layers": [4], "parent": null, "compensate": false}}}]}
motion_run {"path": "Intro.kmotion", "steps": [
  {"command": "layer.setParent", "params": {"comp": 1, "layers": [4], "parent": null, "compensate": false}}
]}
motion_check {"path": "Intro.kmotion"}
→ {"diagnostics": []}
```

A layer that never shows:

```json
motion_check {"path": "Outro.kmotion"}
→ {"diagnostics": [{"code": "motion.zero-duration", "severity": "warning", "target": {"path": "comp:1/layer:4"},
    "fix": {"command": "edit.clear", "params": {"comp": 1, "layers": [4]}}}]}
motion_run {"path": "Outro.kmotion", "steps": [{"command": "edit.clear", "params": {"comp": 1, "layers": [4]}}]}
motion_check {"path": "Outro.kmotion"}
→ {"diagnostics": []}
```

## Example 3: a 6 s vertical promo beat

Set up the comp and two text layers, read their ids from the answer (51 and 52 here), then animate
them in the next call:

```json
motion_run {"path": "Promo.kmotion", "steps": [
  {"command": "comp.settings", "params": {"width": 1080, "height": 1920, "frameRate": 30, "duration": 6, "background": "#0b0b10"}},
  {"command": "layer.newText", "params": {"text": "一杯 6 块", "position": [540, 760], "size": 150, "fill": "#ffffff"}},
  {"command": "layer.newText", "params": {"text": "一年赚 59 亿", "position": [540, 1080], "size": 120, "fill": "#ffd34d"}}
]}
motion_run {"path": "Promo.kmotion", "steps": [
  {"command": "layer.applyTextPreset", "params": {"layer": 51, "preset": "blurSlide", "start": 0.2}},
  {"command": "layer.applyTextPreset", "params": {"layer": 52, "preset": "digitRoll", "start": 1.2}},
  {"command": "light.sheen", "params": {"layer": 51, "start": 2.4}},
  {"command": "light.spotlight", "params": {"target": 52, "start": 3.2}},
  {"command": "camera.move", "params": {"preset": "pushHover", "target": 52, "start": 4.0, "frames": 54}}
]}
```

## Example 4: a keyframe at 2 s without moving the current time

`motion_inspect` lists the layer `Title` with `id` 27, which starts 1 s into the comp. Key its
opacity to 0 at 2 s of the comp:

```json
motion_run {"path": "Promo.kmotion", "steps": [
  {"command": "prop.addKey", "on": [27], "at": {"time": 2}, "params": {"path": "transform/opacity", "value": 0}}
]}
```

The key is at 2 s of comp time (1 s of the layer's own time), and the current time is where the
person left it. `"params": {"layer": 27, "path": "transform/opacity", "time": 2, "timeBase":
"comp", "value": 0}` does the same; `"time": 2` without `timeBase` would be 2 s of the layer's
time, 3 s of the comp's.

## Example 5: change layers in two comps in one run

`project.summary` lists the comps `Intro` (`id` 1, open) and `Outro` (`id` 66); `comp.info
{"comp": 66}` lists Outro's layer `Logo` (`id` 68). Key Intro's Title and set Outro's Logo:

```json
motion_run {"path": "Promo.kmotion", "steps": [
  {"command": "prop.addKey", "on": [27], "at": {"part": {"comp": 1}, "time": 2}, "params": {"path": "transform/opacity", "value": 0}},
  {"command": "prop.set", "on": [68], "at": {"part": {"comp": 66}}, "params": {"path": "transform/opacity", "value": 50}}
]}
```

Each step acts in its own comp. Afterwards Intro is still the comp open in the editor: never rely
on a comp staying open after a run, name it in every step that needs it.

## Pitfalls

- **Earlier results:** steps in one `motion_run` cannot refer to an earlier step's result. Make the
  layer, read its id from `completed[].result`, then animate it in the next call.
- **An empty comp:** a new project has one empty comp, so `motion_check` reports
  `motion.empty-comp` until you add a layer.
- **The stack:** `index` 1 is the top of the stack; a layer added later goes on top.
- **Keyframe times** are seconds (`time: 1` is one second in, not frame 1), of the layer's own
  time unless `timeBase: "comp"` (see the table under [Addressing](#addressing-and-coordinates));
  a step's `at.time`, a preview's `target.time` and `target.range` are comp seconds, never layer
  seconds. Use [`prop.addKey`](/kits/motion/commands/prop.addKey/) with `path` and `value`, one
  call per keyframe.
- **Files:** commands that read or write files on disk are not offered through `motion_run`; a
  movie comes from `motion_export`, which writes only new files inside the workspace.
- **Undo:** your [`edit.undo`](/kits/motion/commands/edit.undo/) takes back your own steps only;
  the person's edits stay.

## Checks

`motion_check` lists what is wrong with the project. Each diagnostic has a stable `code`, a
`severity` (`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a
command step to run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it
only when it is what the person asked for. Every code the kit reports is on the
[checks page](/kits/motion/checks/).

| Code | Severity | What to do |
|---|---|---|
| `motion.missing-footage` | error | The footage's file is gone: ask the person for it, or remove the layers that use it ([`edit.clear`](/kits/motion/commands/edit.clear/) `{comp, layers}`) |
| `motion.missing-source` | error | `fix` removes the layer whose item is gone ([`edit.clear`](/kits/motion/commands/edit.clear/) `{comp, layers}`) |
| `motion.missing-parent` | error | `fix` unparents it ([`layer.setParent`](/kits/motion/commands/layer.setParent/) `{comp, layers, parent: null, compensate: false}`) |
| `motion.missing-matte` | error | `fix` drops the matte ([`layer.setTrackMatte`](/kits/motion/commands/layer.setTrackMatte/) `{comp, layer, matte: null}`) |
| `motion.zero-duration` | warning | `fix` removes the layer; or give it a real out point |
| `motion.outside-comp` | warning | Move its in and out points into the comp's duration, or lengthen the comp ([`comp.settings`](/kits/motion/commands/comp.settings/) `{duration}`) |
| `motion.empty-comp` | info | A new project starts empty; add layers |
| `motion.flat-background`, `motion.no-depth` | info | The active comp looks flat: `fix` adds a radial ramp of the background's colour, or a glow sized for the frame, to the layers it names |
| `motion.small-title`, `motion.weak-hierarchy`, `motion.thin-type`, `motion.small-text`, `motion.low-contrast` | info | Type that reads small, close in size, faint or low in contrast on video: `fix` sets the size, weight or colour |
| `motion.static-text` | info | Text that never moves: `fix` gives it a `blurSlide` entrance; another preset ([`text.presets`](/kits/motion/commands/text.presets/)) works as well |
| `motion.missing-font` | info | The font is not installed and is drawn with a fallback: pick a family from [`text.fonts`](/kits/motion/commands/text.fonts/) |
| `motion.truncated` | info | More of one code than listed: fix those and check again |

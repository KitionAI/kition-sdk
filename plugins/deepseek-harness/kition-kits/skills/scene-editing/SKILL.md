---
name: scene-editing
description: "Create, inspect, edit and check a 3D scene (.kscene) with the Kition Scene kit's tools: adding primitives, curves, and text, transforms, parenting, edit-mode modeling (extrude, inset, bevel, loop cut, knife, dissolve, bridge, bisect, spin), sculpting (sculpt.stroke, sculpt.gesture, dynamic topology, multires, face sets), modifiers (including shrinkwrap and lattice), seams and UV unwrapping, image and normal-map textures, materials, lights, cameras, armatures, skinning, constraints and IK, shape keys, keyframe animation with drivers, actions, and keying sets, rigid body and cloth physics with constraints and force fields, particles and hair, Geometry Nodes (nodes.*), fast and path-traced rendering with a compositor (compositor.*), glTF/FBX/USD (usda, usdc, usdz)/OBJ/STL import and export, and .blend import; rotations are in degrees and Z is up. Use when the user asks to make, read, change, review or fix .kscene files in this project."
---

<!-- Generated from kition-scene agent/guide.md by kition-sdk tools/agent-plugin-skills.mjs; edit the guide, not this file. -->

This plugin serves one tool set for every kit by default (KITION_KITS_UNIFIED): the
`scene_<action>` tools this guide names are `mcp__kition__kit_<action>`, routed by the file's
extension (`scene_run` is `mcp__kition__kit_run`, `scene_check` is `mcp__kition__kit_check`).
With KITION_KITS_UNIFIED=false they are `mcp__kition__scene_<action>`. Paths are relative to the
workspace folder.

# Scene kit

The Scene kit opens, edits and checks 3D scenes (`.kscene`): objects (meshes, curves, text, lattices,
armatures, lights, cameras, empties) with transforms, materials, modifiers, constraints and
animation, plus the world, render settings and a compositor. An agent can add and model objects,
unwrap UVs, give them materials, light and frame the scene, animate cameras and objects, set up
physics, particles and Geometry Nodes, render, check the scene for zero scales, inside-out meshes,
missing cameras or lights and objects out of the shot, import glTF, FBX, USD, OBJ, STL and `.blend`
files, and export GLB, glTF, OBJ, STL, FBX, USD (USDA text, USDC binary, or USDZ with images) and
PNG renders.

## Tools

The kit's prefix is `scene`. Its tools are:

| Tool | Does |
|---|---|
| `scene_inspect` | The scene as JSON (every object with its `id`, `name`, `type`, location, rotation, scale, dimensions and material; materials, images, the camera, the world, the render size); with `preview: true`, a picture of the views and the time you name |
| `scene_query` | Reads objects of the scene's object model by id, or by following fields from the root |
| `scene_commands` | Finds commands by keywords (`cube`, `cylinder`, `material`, `modifier`, `extrude`, `light`, `camera`, `render`), each with its parameter schema; at most 12 answers |
| `scene_run` | Runs a list of 1 to 50 command steps `{command, params?, on?, at?}`, in order |
| `scene_batch` | Runs one batch of object-model operations |
| `scene_check` | What is wrong with the scene, as diagnostics |
| `scene_create` | Makes a new `.kscene` scene: a 2 m cube, a point light and a camera |

Every tool takes `path`, the scene's path in the workspace. The kit keeps no drafts, so it has no
draft tools. It has no `scene_export` tool: export with a [`file.export`](/kits/scene/commands/file.export/)
step in `scene_run` (see Exporting, under Common tasks).

## Addressing and coordinates

- **Units:** lengths and locations are in **metres**, **Z is up**, and rotations are **degrees** in
  XYZ Euler order. `location`, `rotation` and `scale` are `[x, y, z]`. Locations are in world space,
  from the scene's origin `[0, 0, 0]`.
- **Objects are addressed by id or name.** `objects` takes an id, a name, or a list of either
  (`2`, `"Cube"`, `["Leg 1", "Leg 2"]`); `object` takes one. Prefer ids: they never change (see
  [Ids, places and `basis`](#ids-places-and-basis)). Names are what `scene_inspect` lists;
  give new objects a `name` so you can address them in the same `scene_run`. Without `objects` or
  `object`, many commands act on the selection or the active object, which you cannot see: name the
  objects in the parameters, or in the step's `on` (see [Steps](#steps)).
- **Materials by name or id** ([`material.assign`](/kits/scene/commands/material.assign/)
  `{material, objects}`, [`material.set`](/kits/scene/commands/material.set/) `{material, …}`).
- `add.*` commands answer `{"name", "object": <id>}`.
- **Mesh elements:** vertex and face indices of a mesh, counted from **0**, in an edit-mode
  command's `elements` or in [`mesh.select`](/kits/scene/commands/mesh.select/).
- **Particle systems:** `system` is a system's name or its index on the object, counted from **0**.
- **Frames** are the scene's frame numbers: a new scene's range is frames 1 to 250 at 24 fps
  (`details.animation.start`, `end`, `fps`). Parameters named `frame`, `start` or `end` are frame
  numbers. A step's `at.time` and a preview's `target.time` and `target.range` are seconds from the
  first frame instead: frame `start` is at 0 s and frame `start + n` at `n / fps` s, so at 24 fps
  2 s is frame `start + 48`. Durations such as `duration`, `stagger` and `frames` count frames;
  parameters named in seconds or m/s say so.
- **Edit mode:** edit-mode commands ([`mesh.extrude`](/kits/scene/commands/mesh.extrude/),
  [`mesh.bevel`](/kits/scene/commands/mesh.bevel/), [`mesh.loopCut`](/kits/scene/commands/mesh.loopCut/),
  the `uv.*` editing commands, …) work on a mesh's selected vertices, edges or faces. Give them
  `elements: {object, vertices?, faces?}` (every vertex when both are left out): the command runs
  in that mesh's edit mode on those elements, and the mode and the selections are as they were
  afterwards (see [Example 4](#example-4-extrude-a-face-without-leaving-edit-mode-behind)). Steps of one
  `scene_run` can also enter edit mode with [`mode.set`](/kits/scene/commands/mode.set/)
  `{mode: "edit", object: "Top"}` and select with [`mesh.select`](/kits/scene/commands/mesh.select/);
  the mode lasts until the end of that `scene_run`.
- The details are the scene: the viewport, the mode, the selection, the active tool and the
  current frame are the editor's and are not in them, so orbiting, selecting or going to another
  frame changes nothing you read. Animated values (an object's `location`, a light's `power`) are
  the ones at the frame the scene was last left on, which the details do not show: read the keys in
  `details.animation.channels`, and look at a time with a preview's `target.time`.

## Steps

A `scene_run` step is `{command, params?, on?, at?}`:

- `on` lists the objects the step acts on, by the ids or names `scene_inspect` lists
  (`["Top", 7]`). This kit's commands name objects in `objects` or `object` instead of an id
  parameter for `on`, so `on` goes to a command that acts on the selection: its schema's
  `x-khp-reads` lists `selection`, and it acts on those objects (the last one is the active object,
  for commands that act on one). A command that reads no selection refuses `on`. Give the objects
  in `on` or in `params.objects`, not both.
- `at.time` is when the step acts, in seconds from the first frame (counted as above), from 0 to
  before the end of the last frame: the step runs at the frame that starts at or before that time.
  It matters to a command whose `x-khp-reads` lists `time`, one that keys, moves or renders at the
  current frame when you leave out its `frame` or `start`
  ([`anim.insertKey`](/kits/scene/commands/anim.insertKey/), [`camera.move`](/kits/scene/commands/camera.move/),
  [`object.drop`](/kits/scene/commands/object.drop/), [`render.image`](/kits/scene/commands/render.image/),
  …).
- `at.part` and a run's `target` name a part (a slide, a page); a 3D scene has none, so they are
  refused.

Nothing a run does is left behind in the editor: the selection, the active object, the mode and
the edited elements, the current frame and the viewport are put back after the last step, also
when a step fails, and a step that names its objects, `frame` or `elements` leaves them as they
were already. Steps that move the editor ([`select.objects`](/kits/scene/commands/select.objects/),
[`mode.set`](/kits/scene/commands/mode.set/), [`frame.set`](/kits/scene/commands/frame.set/),
`view.*`) last until the end of the run, so a later step of the same run can use them. An object or
a time the scene does not have is an `invalid_params` error that lists the objects or gives the
range.

## Ids, places and `basis`

Others may change the scene while you work: another agent, a person, a program saving the file.
Pass `basis` (the `revision` of your last answer) on every `scene_run`; a write whose premises
others changed since is refused with `error.code: "conflict"` and nothing is run.

- **Name objects by id.** An object's, a material's, a node group's and a node's `id` (as
  `scene_inspect` lists it) is stored in the file and never changes; receipts (`changes`), `others`
  and `conflicts` name objects by it, as a number. Commands take it as a number or as its digits
  (`"4111466496"`), in `on`, in `objects`/`object`, and in every parameter that names an object
  (`parent`, `target`, `operand`, `material`, `group`, `node`, …). A write is checked only against
  what it reads or replaces: a rename holds the object's name, a hide its visibility, a move where
  it is, a material slot the slot, a modifier or constraint set by index that item of the stack, a
  light or camera setting its settings, an edit by `elements` its mesh's topology. A change by
  others outside that (a rename of an object you move, a move of an object you rename) does not
  refuse it, and `others` tells it. Every write command states what it rests on (below).
- **Points, element indexes and names are places, and need `basis`.** They say where or what an
  object was when you read the scene; without `basis` they act on whatever is there now.
  - **Element indexes.** The vertex and face indexes in `elements` name elements of the mesh as you
    read it. A subdivide, an extrude, a delete, a merge or an applied modifier renumbers them; a
    vertex moved, UVs or shading do not. With `basis`, a write by `elements` is refused (`changed`,
    naming the mesh's object) when others changed the mesh's **topology** (`~topology` in
    `others`), and runs when they only moved vertices or the object. When `~topology` appears in
    `changes` or `others` for a mesh (`"8v6f:…"` → `"26v24f:…"`: vertex and face counts, and a
    hash of which vertices make each face), every vertex and face index you hold for that mesh is
    stale: read the mesh again before naming elements. `~bounds` is the mesh's local bounds.
  - **A world point.** `pick: [x, y, z]` (on every command that takes `object` or `objects`) acts
    on the object there now: the smallest mesh whose bounds hold the point (the world-axis box
    enclosing its transformed local bounding box, without modifiers), else the nearest light,
    camera, empty, curve, text, lattice or armature within 0.25 m of its origin. With `basis`, a
    write by `pick` is refused (`relocated`, with `place`) when what is at the point is not what was
    there: the object moved away, another moved in, it was hidden or deleted, or a parent (or constraint target) carried it away. A parent moved or deleted while the same
    target still covers the point does not refuse it; neither does a move, hide or delete elsewhere.
    A point where nothing is now fails the step.
  - **A name.** A target in `object` or `objects` holds which object that name named at `basis`:
    after another writer renamed it away or gave the name to another object, the guard refuses
    the write (`relocated`) before execution. A swap of names in the file is a name change,
    not a renumbering: a rename by id is refused as `changed`. Names in other parameters
    (materials, node groups, nested references) are guarded too: a rename-away or reassignment
    refuses `relocated`, and deletion refuses `deleted`, before execution. Names resolve only
    among the types each command takes: a material taking an object's name does not relocate
    that object. Modifiers and constraints named by name hold their whole stack; vertex groups
    and shape keys live in the mesh: adding a group or weighting vertices by index holds the
    mesh's `~topology`, an edit that reads a group's or key's contents holds the mesh.
  - **References inside settings.** Driver variables and boid and armature-constraint targets
    hold the objects they reference (that they are there: a delete refuses, a move does not). Node values, group input defaults and Geometry Nodes
    modifier inputs hold object or material ids only for sockets of those types. A point-or-object
    parameter holds its scalar object form; a coordinate array and an ordinary numeric socket
    value never name objects merely because their numbers match ids.
  - **An index into an object's stack.** `modifier.set`, `modifier.remove`, `constraint.set` and
    `constraint.remove` by `index` hold that item (`modifiers.2`): a change of another modifier
    does not refuse them; a modifier added, removed or moved above it does (`changed`).
  - **An outliner insertion.** `object.order` by id or name holds its destination gap as well as its source.
    Another writer inserting, removing or moving before that gap refuses the stale move
    (`relocated`); changes strictly after the gap do not. Modifier/constraint stacks, keys,
    NLA and text retain their enclosing JSON/blob premises for insertions.
    Give `object` explicitly for outliner ordering: its listed `pick` alternative does not
    satisfy the schema's required `object` parameter.
- **What each write rests on** (every write command's handler and the engine operation behind
  it are checked against an independent reading of their premises,
  `bindings/wasm/tests/declarations_independent.rs`). The checks run on an object-mode scene and
  on scenes in each session (edit mode, armature edit, pose, weight paint, sculpt, curve, text and
  lattice edit, Particle Edit).
  A write holds:
  - **what it acts on**: the object a parameter names, or, when you leave the parameter out, the
    selected objects, the active object or the mode's session object (the edited mesh, the
    sculpted mesh, the curve, text or lattice being edited, the posed armature, the weight-painted
    mesh, the groomed emitter) as they are when the step runs. An object named and nothing of it
    read is held for existence only: its rename or move does not refuse the write;
  - **what it reads to compute the result**: the fields it reads (`physics` for a physics setting,
    `modifiers.1` for a modifier by index, `data` for a light, `animation` for a key edit), where
    the object is when the result depends on it, and its world place (its parents' and
    constraint targets' places too) where it projects through the world: a knife by screen
    points, a sculpt stroke on the picture, a pick of a matte, a light rig placed round an object;
  - **another object the result is computed from**: a parent's `constraints` and place, the
    material a colour key goes to through the slot, the mesh a shape key or reshape copies;
    references a write only stores (a modifier's operand, a constraint's or a driver variable's
    object, a boid target, a node default, a rigid-body constraint's ends) hold that object's
    existence: a delete refuses, a move or rename does not;
  - **the scene's own fields** it reads or replaces (`scene` in `conflicts` and `others`): the
    scene camera (light rigs, Set Camera, a new camera that becomes it), the timeline (camera
    moves and shakes), the active keying set (a key without `properties`), the actions and
    keying sets, the render settings (the compositor), the world, the physics world;
  - **the field it replaces whole**, as a rename holds `name`: a lost update is refused.
  Edits by `elements` hold the mesh's `~topology`, not its vertex positions. A value a driver
  sets holds the driver's variable sources too (a hop landing on a driven object). A step that
  enters a mode (`mode.set`, `mode.pose`, ...) holds the object whose session it starts. An undo
  or redo holds the objects its steps wrote (the whole scene after a `scene_batch` step, whose
  objects the kit did not record). A matte pick (`compositor.pickMatte`) holds what is under its
  point, as `pick` does.
- **Where the guard is still blind or strict.** A colleague's move of the very vertices an
  element edit acts on does not refuse it (only `~topology` is held; the SDK cannot hold some
  vertices of a mesh). A translate, rotate, parent or look-at by id turns its world values
  through the parents as they are when the step runs: a parent's move does not refuse it (by
  design). Inside a run, a step after a mode's entry holds the session's object whole, so a
  colleague's rename of it refuses the run. After another program saved the file, the kit takes
  only the file's difference into the open scene: your steps stay undoable (an undo keeps the
  other program's edits), and ids and the selection stay. If that program deleted an object the
  open scene has selected or edits in a mode, the file cannot be read again (`file-conflict`,
  naming it, e.g. `deleted selected object 4`) and the scene stays as it was. A matte pick
  after a colleague changed or deleted a mesh is refused (the ray cannot be replayed on the old
  mesh).
- **Moves.** An object's location, rotation, scale, parent and parent inverse say where it is (a
  move along one axis is told as `location.0`). After others moved an object, a rename, hide,
  reveal, material slot, modifier, light or camera setting by id still runs (`others` says what
  moved); a move, rotate, scale, parent or key of it is refused (`relocated`, with `now`).
  A parent's move changes its children's world places without changing their fields: only the
  parent is in `others`, with `carries: { count, what: "world transform" }`. Counts include nested
  and hidden descendants and active constraint dependents once each; disabled constraints and
  constraints with zero influence contribute no dependency. Your own move also
  reports `carried: { count }` in the step's result. The `carries` note requires a stored
  transform or constraint field change; renames and scene-list reorders carry no world transforms.
  Equal offsets on many objects are compacted into
  `footprint: [{ ids, edits: [{ field, by }] }]`; `changes: "all"` lists every object's edits.
- **What a refusal says.** `conflicts: [{ id, reason, now?, place? }]`: `reason` is `changed` (a
  field the write reads or replaces), `deleted`, `relocated` (moved, or the place names something
  else now) or `unknown` (another program renumbered ids in the file: inspect again); `now` is
  where the object is now (its position fields; `now.fields.parent` for a new parent); `place` is
  the place as you named it with `under`, the ids it names now. `others` lists what changed, and
  `revision` is the basis for your retry. Nothing was run. To retry: read `others` (or
  `scene_inspect` again), decide whether the write still makes sense, name the objects by the ids
  you see now (and elements by the mesh as it is now), and run again with the new `basis`.
- Modifiers, constraints, particle systems, bones, shape keys, vertex groups, NLA tracks and
  actions have no ids of their own: they are named by index or name inside their object.
- An object's `kind`, `parent` and `material` are read-only in `scene_batch`: set them with
  `object.parent`, `object.clearParent` and `material.assign`.
- `scene_batch` runs only the raw operations the schema's `batchOps` declare; any other is
  refused before anything runs. After a batch the scene lets go of references to objects,
  materials, images, node groups and actions that are gone, so a raw write of a value that holds
  such a reference (an object's `constraints`, `modifiers`, `data`, `particles`, `physics`, `nla`
  or `tweak`, a material's `data`, the scene's `camera`, `world`, `render` or `actions`, nodes and
  links) and a raw `create` of an object or material are refused: use the commands. Names,
  transforms (`location.0` too), `hidden`, `animation`, meshes, the timeline, the physics world,
  keying sets, the bounded numeric members of an object's or a material's `data`, the world's
  `color`, `strength` and `rotation`, the render settings but its `compositor`, a node's
  `location`, and new images are written directly. A raw `delete` of an object, a material
  or a node group holds what `edit.delete`, `material.delete` or `nodes.removeGroup` holds.
- Numeric JSON members advertise their bounds in `scene_query`'s schema: material roughness,
  metallic, transmission and alpha cutoff are 0 to 1; render sizes and physics counts are
  bounded integers. Both a member `set` and a whole-register `set` refuse invalid values
  atomically. The current metadata cannot describe nested numeric leaves or type-dependent
  member limits (curve/text/lattice resolution); those limits are not advertised as enforced.

## Workflow

1. `scene_inspect` to learn the objects, materials and camera; add `preview: true` to see them
   (see [Previews](#previews)).
2. `scene_commands` with keywords. Use the exact id it returns and follow its parameter schema;
   never guess a command id.
3. `scene_run` a few steps, naming the objects each acts on (in `objects`, `object` or `on`) and
   its time (`frame` or `at.time`).
4. `scene_check`, then fix what it reports. Most diagnostics carry a `fix` you can run as a step
   exactly as given.
5. Look at what you changed: `scene_inspect` with `preview: true` and a `target.view` (`camera` for
   the camera's framing), a `target.time`, or a `target.range` for motion.

## Previews

`scene_inspect` with `preview: true` draws the scene with the kit's render command,
[`file.render`](/kits/scene/commands/file.render/). What it shows is named in `target`, never taken
from the editor's viewport, the current frame, the mode or the selection, so the same call shows
the same picture every time:

- **A named view:** `target: { "view": "front" }`. `front`, `back`, `left`, `right`, `top` and
  `bottom` look along an axis without perspective (`front` from -Y, `right` from +X, `top` from
  +Z); `persp` looks from the front right, above, with perspective. Each is framed to fit the
  scene's visible meshes with a margin of a tenth, the same way every time.
- **Through a camera:** `target: { "view": "camera" }` is the scene's active camera, the one
  renders use (`details.camera`; [`object.setCamera`](/kits/scene/commands/object.setCamera/)
  changes it), framed as it is at the render size. `target: { "camera": "Side" }` (a name or an
  id) looks through another camera without making it active. Give `view` or `camera`, not both.
- **One object:** `objectId` (an id, a diagnostic's `objectId`, or a name) or `path:
  "object:<id>"` frames that object instead of the scene in a named view. A camera's framing is
  its own, so asking to fit an object through a camera is an error.
- **A time:** `target.time` is seconds from the first frame: frame `start` (1 in a new scene) is at
  0 s, and frame `start + n` at `n / fps` s (at 24 fps, 1 s is frame 25). The frame that starts at
  or before the time is drawn, from 0 to before the end of the last frame. Without `time`, the
  first frame. The animation is worked out at that time; the current frame does not move.
- **Several views:** `target: { "views": ["front", "top", { "camera": "Side" }], "time": 2 }` is
  one picture of 2 to 6 views in a grid in reading order, each labelled with its view in its
  bottom-left corner.
- **Motion over a span:** `target: { "view": "persp", "range": [0, 2], "frames": 6 }` is one
  picture of 6 frames (2 to 12) spread evenly from 0 s to 2 s, both included, from one view framed
  once for all of them, each labelled with its time and frame. Without a view, the active camera.
  One sheet shows one axis: `views` and `range` together are an error.
- **Without a target:** four views at the first frame: the active camera (`persp` when there is
  none), then `front`, `right` and `top`.
- **Passes:** `pass: "color"` (the default) shows the materials lit by the scene's lights, on the
  viewport's grey background (or the world image). `"id"` draws each object in a flat colour of its
  own on black and answers `legend`, `[{id, name, color}]` for each visible mesh, curve, text or
  surface, so you can tell which object is where; the same scene gives the same colours. `"depth"`
  is grey, nearer lighter, empty space black; `"wireframe"` draws the edges.
- **Size:** `scale` is picture pixels per render pixel (the scene's render size; up to 2, default
  1; each cell of a sheet is drawn at it) and `maxSize` the most pixels on the longer side (16 to
  4096, default 1024); a larger picture is drawn at a smaller scale.

The answer has `frames`, one entry per cell, `{time, frame, label, view, camera}` (`camera` is the
camera's id when looking through one), and `columns` and `rows`. Previews use the fast rasteriser
the viewport uses, never the path tracer, so they have no noise and the same call answers the same
bytes; depth of field, motion blur, volumes and compositing do not show in them. An unknown view,
camera, object or pass, a time outside the animation, `view` with `camera`, `views` with `range`,
or fitting an object through a camera is an `invalid_params` error that gives the valid range or
lists the choices.

## Common tasks

### Exporting

[`file.export`](/kits/scene/commands/file.export/) `{format}` writes the scene as `glb`, `gltf`,
`obj`, `stl`, `fbx`, `usda`, `usdc`, `usdz` or `png` (`frame` picks the frame a PNG renders). It
answers the file's bytes as `base64` and writes no file in the workspace.
[`file.import`](/kits/scene/commands/file.import/) brings glTF, FBX, USD, OBJ, STL and `.blend`
files into the scene.

### UV editing

Enter mesh edit mode and select the faces to unwrap. [`uv.unwrap`](/kits/scene/commands/uv.unwrap/)
accepts `method: "angleBased"` (the default), `"conformal"` or `"minimumStretch"`; the last accepts
`iterations` from 1 to 100 (30 by default). Mark seams to cut a closed surface into charts, and use
[`uv.pin`](/kits/scene/commands/uv.pin/) to hold the selected vertices' UV coordinates. Minimum
Stretch keeps pins, and refuses degenerate or infeasible charts without changing the mesh.

[`uv.liveUnwrap`](/kits/scene/commands/uv.liveUnwrap/) `{on: true, method: "minimumStretch"}` turns
on relaxation when a UV transform moves a pin. [`uv.preview`](/kits/scene/commands/uv.preview/)
`{offset: [u, v]}` answers a proposed layout without editing the scene. Commit the move with
[`uv.translate`](/kits/scene/commands/uv.translate/) `{offset: [u, v]}`: the move and the
relaxation are one undo step. A single moved pin translates its island; several pins constrain
the relaxed shape. The live setting belongs to the local editor and does not change a
collaborator's settings. For a gesture over several requests, read
[`uv.layout`](/kits/scene/commands/uv.layout/) and pass its `source` token to
[`uv.preview`](/kits/scene/commands/uv.preview/) and to the final transform. A changed mesh,
selection or unwrap setting refuses the stale gesture atomically; viewport navigation and rendered
sampling leave the token valid.

### Camera framing

[`camera.set`](/kits/scene/commands/camera.set/) `{object, sensorFit: "auto" | "horizontal" | "vertical"}`
chooses which output dimension the camera holds. Auto, the default, fits the longer dimension using
`sensor` (the sensor width in millimetres). Horizontal holds that width; Vertical holds
`sensorHeight`. Changing the render size with [`render.set`](/kits/scene/commands/render.set/)
`{width, height}` (in pixels) then changes the other dimension. For orthographic cameras,
`orthoScale` holds the chosen dimension in metres instead. The camera view and final renders share
the fit; pixels are square.

Keep the scene as `.kscene` to keep the editable fit policy and both sensor dimensions. Exchange
formats encode the current frame; compare imported framing at the same render aspect. Blender's
USD importer enlarges an orthographic frame tenfold relative to the USD specification.

### Rendered viewport

[`view.rendered`](/kits/scene/commands/view.rendered/) selects progressive shading with the scene's
lights and world. The editor advances samples by itself. In a retained engine session, run
[`view.renderedStep`](/kits/scene/commands/view.renderedStep/) `{samples: 32, wait: true}` before you
ask for a completed viewport picture; `wait: false` advances a short batch and reports progress.
Sample targets range from 1 to 256. Navigation, edits and frame changes discard old samples.
Accumulation adds no undo step and is not saved with the file.

The preview is at most 512 pixels on its longer side; picking and overlays keep the viewport's
full resolution. Final renders use the separate render commands
([`render.image`](/kits/scene/commands/render.image/), [`render.trace.start`](/kits/scene/commands/render.trace.start/))
and the scene's render size; viewport shading does not apply motion blur or compositing.

### Multiresolution recovery

For a subdivided quad mesh with a Multiresolution modifier,
[`multires.unsubdivide`](/kits/scene/commands/multires.unsubdivide/) `{object}` recovers one lower
base level and stores the old surface as detail. Its viewport and sculpt level numbers stay as they
were; raise them with [`modifier.set`](/kits/scene/commands/modifier.set/) to show the previous finest
surface. Existing sculpted levels are kept.
[`multires.rebuildSubdivisions`](/kits/scene/commands/multires.rebuildSubdivisions/) `{object}`
needs a mesh with no multiresolution levels, recovers every supported level, and selects the
highest. Each operation is one undo step.

Recovery supports consistently oriented manifold quad subdivisions with a boundary corner or an
extraordinary interior vertex in every connected component. The limits are six levels, 100,000
base faces and 250,000 faces at the highest level. Linear subdivided UVs are kept. Groups, shape
keys, masks, face sets, hidden faces, seams, UV pins and non-linear UV detail are not supported;
an unsupported mesh is refused without changing it.

### Rigid body motors

Give two meshes rigid bodies with [`physics.rigidBody.add`](/kits/scene/commands/physics.rigidBody.add/),
create an empty for their constraint, and use
[`physics.constraint.add`](/kits/scene/commands/physics.constraint.add/)
`{objects, type: "motor", object1, object2}`. The Physics panel shows the same settings. Turn on
`linearMotor` and/or `angularMotor` with [`physics.constraint.set`](/kits/scene/commands/physics.constraint.set/);
both drives start off. Set `linearTargetVelocity` in m/s and `angularTargetVelocity` in rad/s, plus
their `linearMaxImpulse` and `angularMaxImpulse`. Both target velocities and both impulses default
to 1. A positive velocity drives the first body relative to the second along or about the
constraint's X axis. A motor leaves the other axes free; another constraint can guide the motion.

Use [`physics.bake`](/kits/scene/commands/physics.bake/) to simulate, then
[`frame.set`](/kits/scene/commands/frame.set/) to look at the result. Interactive hosts use
[`physics.bake`](/kits/scene/commands/physics.bake/) `{wait: false}` followed by
[`physics.bakeStep`](/kits/scene/commands/physics.bakeStep/) until it is complete. Changing a motor
setting or its input geometry invalidates the bake. Settings are saved; bakes are recomputed after
reopening. Motor targets are static settings, and bodies set to start asleep stay asleep until
something wakes them.

### Cloth and soft-body field weights

[`physics.cloth.add`](/kits/scene/commands/physics.cloth.add/),
[`physics.cloth.set`](/kits/scene/commands/physics.cloth.set/),
[`physics.softBody.add`](/kits/scene/commands/physics.softBody.add/) and
[`physics.softBody.set`](/kits/scene/commands/physics.softBody.set/) accept partial
`effectorWeights`: `{all, gravity, force, wind, vortex, turbulence, drag}`. Every weight defaults
to 1 and accepts finite numbers from -200 to 200. Omitted weights keep their current values.
Unknown keys, `null`, non-numbers and out-of-range values fail without changing the document.

Gravity is its own signed multiplier and does not depend on All. Each field uses
`max(all * kindWeight, 0)`: a product of zero or less turns it off, while two negatives give a
positive influence. For Force, Wind, Vortex and Turbulence the product scales strength and flow
before the field law is evaluated. For Drag it scales both drag coefficients. It is not an extra
force applied after the solver. The weights affect only that cloth or soft body; particles, hair
dynamics and rigid bodies behave as before.

Bake after setting weights. Edits invalidate a current bake; undo, collaboration and reopening keep
the settings, while every session computes its own cache. A divergent cloth or soft-body bake
answers `failed:`, clears its partial output, and `scene_inspect` reports `physics.state: "failed"`
with an `error` string. Automatic retry stops: correct the settings and run
[`physics.bake`](/kits/scene/commands/physics.bake/) again, or use
[`physics.free`](/kits/scene/commands/physics.free/). The scene stays valid and can be saved.

### Airborne boids

Use [`particles.add`](/kits/scene/commands/particles.add/) `{object, name, physics: "boids"}` to
create a flock, or [`particles.set`](/kits/scene/commands/particles.set/) with `object`, the
existing system's name or index (from 0) in `system`, and `physics: "boids"`. Existing emitters
keep `physics: "newtonian"` until changed. Configure `boids` with `airSpeedMax` in m/s, `airAccMax`
and `airAngularMax` from 0 to 1, and `airPersonalSpace` as a multiple of the particle size.
`airAccMax` and `airAngularMax` are fractions of the maximum speed and of 180 degrees.

`boids.rules` replaces the whole rule list. Each entry has `kind: "goal" | "avoid" | "separate" |
"flock"`; Goal and Avoid can name a target object with `target`. For example,
[`particles.set`](/kits/scene/commands/particles.set/) `{object: "Emitter", system: "Flight",
physics: "boids", boids: {rules: [{kind: "goal", target: "Destination"}]}}` steers an existing
emitter towards an object. Applicable rules are averaged; their order gives no priority. The
default rules are Separate and Flock. Fuzzy evaluation and ground movement are not available.
Boids emit from faces or vertices; switch a volume emitter to either mode before turning on boids.

The limits are 2,048 particles, eight rules, and 1,000 frames from the first emission to the last
possible death. The particle-frame budget and the budget of simulation updates (emission and death
events included) are 500,000 each. Reduce the count or the lifetime when a configuration exceeds
them; a refused edit says which budget to reduce. Neighbour rules look at a bounded neighbourhood
of at most 32 particles, so large flocks can differ from Blender.

Use [`frame.set`](/kits/scene/commands/frame.set/) to seek or rewind. The simulation comes from the
emitter's settings and seed, so saving stores the settings, not a baked flock. Target positions
are taken from the evaluated scene at the displayed frame; moving targets give no flight-path
history. Boids start at rest and ignore Newtonian launch velocity, gravity, drag, and the scene's
force fields and collision objects. Their birth headings do not reproduce Blender's random
headings, and Blender keeps hidden seed-dependent state when turning, so whole flock trajectories
do not match sample by sample. Explicit particle collider and die-on-collision settings are refused
in boid mode.

### Promo shots

Product-ad moves are presets that bake keys, one undo step each; running one again over the same
frames replaces the keys there. Frame the shot first ([`object.transform`](/kits/scene/commands/object.transform/)
and [`object.lookAt`](/kits/scene/commands/object.lookAt/) on the camera), then:

- [`camera.move`](/kits/scene/commands/camera.move/) `{preset, target, start, duration}` keys the
  camera, aimed at `target` (an object, meaning its bounding box's centre, or a point) on every
  frame. Presets: `pushIn` (`amount` 0.3 of the distance, ease cubic-bezier(0.33, 0, 0.15, 1)),
  `pushHover` (hold 4 frames, push in 18 with `yaw` 34° and `tilt` 8°, hover creeping in by at most
  `creep` 1.5 %, settle back; 90 frames), `orbit` (`degrees`, constant speed; `radius` and `height`
  place it, `easeEnds: "in" | "out" | "inOut"` ramps only the ends), `craneRise` (from close and
  low, the target 3 times larger, a 1.5 % push first, then rise `rise` 25° and pull back to where
  the camera is with cubic-bezier(0.2, 0, 0.25, 1); 110 frames), `reveal` (from a close-up `scale`
  2.5 out to where the camera is), `pullBack` (out to `amount` 1.6 times the distance), `whip` (pan
  to `to`, fast in the middle; turns on the scene's motion blur, shutter 0.5, unless
  `motionBlur: false`). Any preset takes `lens` (reached by the end) and `ease: [x1, y1, x2, y2]`
  instead of its main ease. Moves chain: start the next where the last ended (`pushHover` 1 to
  121, then `orbit` from 121).
- One take: every move starts where the camera is and as it looks at `start` (`from: "current"`,
  the default; it reads the keys already there), so a move over frames 121 to 180 carries on from
  wherever the move before left the camera, with no jump in place or aim. The aim turns from where
  the camera looked to the new target over the first third of the move (8 to 30 frames).
  `craneRise` and `reveal` then start close and end `scale` times farther out. Give `position` (or
  `from: "position"`) for a move built round that place, aimed at the target from the first frame;
  `craneRise` and `reveal` end there.
- [`camera.move`](/kits/scene/commands/camera.move/) `{preset: "follow", target: object, start,
  duration, offset, lead, smoothing}` tracks a moving object (sampled every frame from its own
  keys): the camera keeps `offset` (by default its offset from the object's centre at `start`) and
  aims `lead` (0.1) seconds ahead of where the object is, lagging behind as a critically damped
  spring of `smoothing` (0.3) seconds, and carrying on at the speed it had coming into `start`. Key
  the object first.
- [`camera.move`](/kits/scene/commands/camera.move/) `{preset: "zoomThrough", target, duration,
  through, gap, lens}` flies straight at the target (40 frames) until its surface (the first face
  on the line of sight, for an object) fills the frame `gap` (1.5 times the near clipping distance)
  in front of it; the distance to the surface shrinks by the same factor every frame, so the
  approach looks steady. `through: true` arrives at full speed instead of slowing, its colour
  filling the frame, ready to come out somewhere else. It stops in front of the surface, not
  inside: [`render.image`](/kits/scene/commands/render.image/) does not draw the inside of a closed
  surface, so a camera inside the object would see through it. `lens` narrows the view over the
  last 40 %. `pullOut` is the reverse: it starts `gap` in front of the target's surface (the frame
  filled with it) and pulls back along the camera's line of sight, fast first and slowing, to
  `distance` metres (the camera's distance, or 8 times the target's half-size when it is inside
  it) or `position`. Chain a `zoomThrough {through: true}` into one object with a `pullOut` from
  another of the same colour to pass from one place to the next without a visible cut.
- [`camera.shake`](/kits/scene/commands/camera.shake/) `{frame, amplitude, rotation, decay,
  frequency, seed}` jolts the camera at `frame` (a landing, an impact) and lets it die away: up to
  `amplitude` (0.03) metres along its own right and up and `rotation` (0.6°) of pitch and yaw (half
  in roll), as smooth seeded noise at `frequency` (14) jolts a second, falling by e every
  1/`decay` (1/9) seconds and reaching exactly nothing about 0.7 s later. It is added on top of the
  keys already there (re-keying every frame it touches, and the frames out to the neighbouring
  keys, so the rest of the curve is unchanged), so run it after the moves: a
  [`camera.move`](/kits/scene/commands/camera.move/) over those frames afterwards replaces it.
- [`camera.handheld`](/kits/scene/commands/camera.handheld/) `{start, end, amount, rotation, period,
  holds, seed}` lays a slow float over the camera from frame `start` to frame `end`: two sine sways
  of `period` [2.7, 4.1] seconds, up to `amount` (0.01) metres along its right and up and
  `rotation` (0.25°) of pitch and yaw (half in roll). In each hold `[[first, last], ...]` the float
  is exactly nothing, so rests are dead still; it fades out over the 6 frames before a hold, back
  in over the 6 after, and in and out at `start` and `end`. Like
  [`camera.shake`](/kits/scene/commands/camera.shake/), it adds to the keys already there: make the
  moves, then the shake, then the float.
- Keys carry no handles of their own, so eases are baked as one linear key per frame: whole frames
  show the eased curve exactly in fast and path-traced renders.
- Motion blur is a scene setting, not keyed: after a whip it stays on for every frame (path-traced
  renders only); turn it off with [`render.set`](/kits/scene/commands/render.set/)
  `{motionBlur: false}` if only the whip should blur.
- The frame range grows to take in a move that ends after it.
- [`light.studio`](/kits/scene/commands/light.studio/) `{target, preset: "product" | "dramatic" |
  "soft", distance}` builds (or, run again, moves) Key Light (a spot camera-left, 70° cone for
  product), Fill Light (a cool area light, a fifth of the key's power for product) and Rim Light (a
  warm spot from behind), aimed at the target and measured from the camera's side; it sets the
  world strength (0.25 for product), ambient occlusion on with a distance from the target's size,
  and the AgX view with the Punchy look. Edit the lights by name afterwards with
  [`light.set`](/kits/scene/commands/light.set/).
- [`object.drop`](/kits/scene/commands/object.drop/) `{objects, start, duration, height, bounce,
  squash}` drops objects from `height` metres (2) onto where they are at `start`, accelerating as
  under gravity over `duration` (12) frames, then bounces `bounce` (0.12) of the height and
  stretches, squashes and settles (scale 1.06, 0.97, 1 over 4 frames). Before `start` they wait at
  the top.
- [`object.pop`](/kits/scene/commands/object.pop/) `{objects, start, duration, stagger, accelerate}`
  grows objects from nothing with an overshoot (cubic-bezier(0.2, 1.25, 0.3, 1), 12 frames),
  `stagger` (3) frames apart in the order given; `accelerate: true` shrinks the gaps from 4 to
  `minStagger` (0.2) frames.
- [`object.hop`](/kits/scene/commands/object.hop/) `{objects, to, start, duration, height, spin,
  impact}` throws objects on a ballistic arc (a parabola in time: quick off the ground, slow over
  the top, quick down) from where they are at `start` to `to`: a point their bounding-box centre
  lands on, or an object whose top they land on (where it is when they land). The top of the arc
  is `height` (0.6) metres above the higher end; `duration` (18) frames in the air; `spin:
  [x, y, z]` degrees turned on the way. They stretch over the last 3 frames, squash by
  `impact.squash` (0.12) on landing (X and Y widen to keep the volume, the bottom stays put) and
  spring back with one overshoot over `impact.frames` (8); `impact: false` lands without. It
  answers `landed`, the landing frame, to hang the next beat on
  ([`camera.shake`](/kits/scene/commands/camera.shake/) `{frame: landed}`).
- [`object.gather`](/kits/scene/commands/object.gather/) `{objects, center, radius, level, start,
  duration, stagger, accelerate, arc, spin}` closes objects into an evenly spaced ring round
  `center` (a point, or an object's bounding-box centre), like a seal closing. Each spirals in from
  where it is: its distance from the centre eases to `radius` (half their mean distance; `0` packs
  them into a ring just touching) while it swirls `arc` (90) degrees round it and on to its slot,
  with cubic-bezier(0.3, 0, 0.25, 1) over `duration` (30) frames, setting off `stagger` (2) frames
  after the one before in the order given (`accelerate` as in
  [`object.pop`](/kits/scene/commands/object.pop/)). Slots follow the order they stand round the
  centre, so the paths fan out without crossing. Each keeps its height unless `level` is given.
- [`object.wave`](/kits/scene/commands/object.wave/) `{objects, origin, speed, property, amount,
  color, start, duration}` runs a wave out from `origin` at `speed` (4) metres a second: each object
  starts `distance / speed` seconds after `start`. `property: "scale"` bumps it `amount` (0.25)
  larger and back over `duration` (10) frames; `property: "color"` switches its material's base
  colour to `color` and leaves it there, like rows of shops lighting up one by one. Each object
  needs its own material for a colour wave ([`material.new`](/kits/scene/commands/material.new/)
  `{assign: false}`, then [`material.assign`](/kits/scene/commands/material.assign/) per object).
  Emission is not keyable, so make the "lit" colour bright instead. The wave acts on separate
  objects, not on the copies an Array modifier makes: lay the row out as separate objects
  ([`edit.duplicate`](/kits/scene/commands/edit.duplicate/) with an `offset`) instead.

### Geometry-node spline types

Use [`nodes.addNode`](/kits/scene/commands/nodes.addNode/) `{kind: "setSplineType", values:
{splineType: "catmullRom"}}` to convert selected curves inside a geometry graph. The type setting
accepts `poly`, `catmullRom`, `bezier` and `nurbs`; both geometry sockets are named `Curve`. Its
Selection field is on the curve domain. `setNurbsOrder` and `setNurbsWeight` use `Curves` geometry
sockets and have Order (curve domain, default 4) and Weight (point domain, default 1) fields. They
appear in [`nodes.describe`](/kits/scene/commands/nodes.describe/) and in the editor's add menu. Use
[`nodes.setValue`](/kits/scene/commands/nodes.setValue/) to edit their fields and settings, and
[`nodes.link`](/kits/scene/commands/nodes.link/) to connect them to the graph output.

Order is bounded at 16 and weight at 100000000. Coordinates, handles, radius and tilt on these two
spline types are bounded in magnitude at 1000000000000; results must stay finite. Negative weights
become zero. Too few control points for an order give the control polygon. NURBS-to-Bézier accepts
cubic Bézier-knot curves with equal positive weights made by Bézier or Catmull-Rom conversion;
other NURBS-to-Bézier conversions report `scene.nodesError`. Use Resample Curve to make Poly first
when a sampled conversion is intended. These nodes change graph geometry, not native curve
objects.

## Example 1: a table

The new scene has `Cube` (id 2) with material `Material`, `Light` and `Camera`.

```json
scene_run {"path": "scene.kscene", "steps": [
  {"command": "edit.delete", "params": {"objects": "Cube"}},
  {"command": "add.cube", "params": {"name": "Top", "location": [0, 0, 0.75], "scale": [1, 0.6, 0.04]}},
  {"command": "add.cylinder", "params": {"name": "Leg 1", "radius": 0.04, "depth": 0.72, "vertices": 16, "location": [0.9, 0.5, 0.36]}},
  {"command": "add.cylinder", "params": {"name": "Leg 2", "radius": 0.04, "depth": 0.72, "vertices": 16, "location": [-0.9, 0.5, 0.36]}},
  {"command": "add.cylinder", "params": {"name": "Leg 3", "radius": 0.04, "depth": 0.72, "vertices": 16, "location": [0.9, -0.5, 0.36]}},
  {"command": "add.cylinder", "params": {"name": "Leg 4", "radius": 0.04, "depth": 0.72, "vertices": 16, "location": [-0.9, -0.5, 0.36]}},
  {"command": "material.set", "params": {"material": "Material", "name": "Wood", "baseColor": "#8b5a2b", "roughness": 0.6}},
  {"command": "material.assign", "params": {"material": "Wood", "objects": ["Top", "Leg 1", "Leg 2", "Leg 3", "Leg 4"]}},
  {"command": "object.parent", "params": {"objects": ["Leg 1", "Leg 2", "Leg 3", "Leg 4"], "parent": "Top"}},
  {"command": "object.lookAt", "params": {"object": "Camera", "target": [0, 0, 0.5]}}
]}
scene_check {"path": "scene.kscene"}
```

All ten steps answer `"changed": true` (the cube's deletion answers `{"deleted": [2]}`), and the
check finds nothing wrong.

## Example 2: bring an object back into the shot

```json
scene_check {"path": "shot.kscene"}
```

It answers a note, `Cube is outside the camera's view, so renders will not show it`, with the fix
`{"command": "object.lookAt", "params": {"object": 4, "target": [0, 0, 200]}}` (4 is the camera's id).

```json
scene_run {"path": "shot.kscene", "steps": [
  {"command": "object.lookAt", "params": {"object": 4, "target": [0, 0, 200]}}
]}
scene_check {"path": "shot.kscene"}
```

The camera turns (the step answers its new `rotation`), and the check finds nothing wrong.

## Example 3: one material on three objects, and a key at 2 s

```json
scene_run {"path": "scene.kscene", "steps": [
  {"command": "material.new", "params": {"name": "Blue", "baseColor": "#2050ff", "assign": false}},
  {"command": "material.assign", "on": ["Cube", "Left", "Right"], "params": {"material": "Blue"}},
  {"command": "anim.insertKey", "at": {"time": 2}, "params": {"objects": "Right", "properties": ["location"]}}
]}
```

`material.assign` gives Blue to exactly the three objects `on` names, and `anim.insertKey` keys
Right's location at 2 s, frame 49 of a scene that starts at frame 1 at 24 fps (it answers
`"keys": 3`). The selection and the current frame are what they were before the run.

## Example 4: extrude a face without leaving edit mode behind

```json
scene_run {"path": "scene.kscene", "steps": [
  {"command": "mesh.extrude", "params": {"elements": {"object": "Left", "faces": [0]}, "distance": 0.5}}
]}
```

Left's face 0 moves out 0.5 m along its normal with four new side faces (`details.objects`'s
`mesh.faces` goes from 6 to 10), and the scene is still in object mode with nothing selected that
was not before. Without `elements`, the same run would be `mode.set {mode: "edit", object: "Left"}`,
`mesh.select {faces: [0]}`, `mesh.extrude {distance: 0.5}`, and edit mode would end with the run.

## Pitfalls

- **New materials:** [`material.new`](/kits/scene/commands/material.new/) gives the new material to
  the **selected** objects unless `assign: false`. Pass `assign: false`, then
  [`material.assign`](/kits/scene/commands/material.assign/) with the objects you mean.
- **Deleting a material:** [`material.delete`](/kits/scene/commands/material.delete/) `{material}`
  deletes a material that objects still use only with `force: true`, which leaves those objects
  without one.
- **Normals:** [`mesh.recalculateNormals`](/kits/scene/commands/mesh.recalculateNormals/) `{objects}`
  turns meshes outward in object mode; there is no need to enter edit mode first.
- **Path-traced only:** depth of field and bokeh ([`camera.set`](/kits/scene/commands/camera.set/)),
  motion blur ([`render.set`](/kits/scene/commands/render.set/) `{motionBlur, shutter}`) and volumes
  (a shader group: [`nodes.newGroup`](/kits/scene/commands/nodes.newGroup/) `{tree: "shader",
  material}` for a material, or `{tree: "shader", world: true}` for the world, with Volume
  Scatter, Volume Absorption or Principled Volume in the Material Output's Volume) show in
  path-traced renders ([`render.trace.start`](/kits/scene/commands/render.trace.start/)), not in
  [`render.image`](/kits/scene/commands/render.image/).
- **Scale or size:** `scale` multiplies an object's size; `size` and `radius`/`depth` set a new
  primitive's real size in metres.

## Checks

`scene_check` lists what is wrong with the scene. Each diagnostic has a stable `code`, a `severity`
(`error`, `warning` or `info`), a `message`, a `target` and, for some, a `fix`: a command step to
run as it is. Act on the code, not on the message. A `fix` is a suggestion: run it only when it is
what the person asked for. Every code the kit reports is on the [checks page](/kits/scene/checks/).

It reports zero scale, broken Geometry Nodes, empty or inside-out meshes, faces with no area or
mixed normals, image materials without UVs, no camera, no light, meshes out of the camera's view,
and unused materials. Fixes use [`object.transform`](/kits/scene/commands/object.transform/),
[`mesh.recalculateNormals`](/kits/scene/commands/mesh.recalculateNormals/),
[`add.camera`](/kits/scene/commands/add.camera/), [`add.light`](/kits/scene/commands/add.light/),
[`object.lookAt`](/kits/scene/commands/object.lookAt/), [`uv.smartProject`](/kits/scene/commands/uv.smartProject/)
and [`material.delete`](/kits/scene/commands/material.delete/).

- `scene.zeroScale` (error): a scale of 0 on any axis.
- `scene.nodesError` (error): a Geometry Nodes group cannot run (a cycle, a missing Group Output, a
  result too large, or an unsupported NURBS-to-Bézier conversion), so the modifier leaves the mesh
  as it is.
- `scene.outOfShot` (info): deleting or moving objects can leave them outside the camera's view. Aim
  the camera with [`object.lookAt`](/kits/scene/commands/object.lookAt/)
  `{object: "Camera", target: [x, y, z]}`.
- `scene.unusedMaterial` (info): reuse the material with
  [`material.set`](/kits/scene/commands/material.set/) `{material, name, …}`, or delete it with
  [`material.delete`](/kits/scene/commands/material.delete/) `{material}`.

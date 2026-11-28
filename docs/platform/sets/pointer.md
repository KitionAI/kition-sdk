# `KitPointer 1.0`: pointer tools and selection

For integrators and kit authors whose editors let a person point at the
document: select objects or text, place a comment, type into a form field,
drag a handle, draw. The tools stay in the kit; this set fixes what every
tool of a kind does with the same gesture, what the kit reports as selected,
and how an agent finds what a point in a preview shows.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

| | |
| --- | --- |
| Status | Specified in edition 2026.11; not yet implemented by any kit or host. Behaviour rules for touch input come after the first release (section 2.3) |
| Bindings | [Kit UI protocol](../reference/ui-protocol.md) section 7h (`kition-kit-ui/1`) and UI-K7; engine tools U8b and editor tools U10 ([kit editors](../kits/ui.md)); [Kit Process Protocol](../reference/kit-process-protocol.md) `view.hitTest`; [`KitAgent 1.4`](agent.md) A31 to A33 |
| Kit side | PT1 to PT11, PT13, PT14 below; U8b, U10; the engine tools members ([engine contract reference](../reference/contract.md#engine-tools)) |
| Host side | PT2 (read-only), PT9, PT12; UI-S1 to UI-S4 |

## 1. Principles

- **PT-P1 Tools live in the kit.** The kit draws its tools, overlays, and
  handles; the host draws nothing over the kit's frame (UI-H1) and
  implements no tool. This set constrains behaviour and what is reported,
  not implementation: engine tools (U8b) and tools written in the kit's
  editor (U10) both conform.
- **PT-P2 Same gesture, same result, every kit.** A person who learns
  selecting in one kit knows it in all.
- **PT-P3 The pointer is never the only way.** Every pointer action has a
  command with explicit parameters, so keyboards, scripts, and agents reach
  it (PT6).
- **PT-P4 Selection is observable, not ambient, for agents.** An agent can
  read what the person selected; agent commands never depend on it
  implicitly (PT10, A26).
- **PT-P5 Any surface.** The rules bind every view of the document a person
  points at, whatever draws it: a `<canvas>` with engine overlays, SVG, or
  DOM elements (a `contenteditable` region, a code editor, a grid of cells).
  "Canvas" in this set means that view (PT13).

## 2. Scope

### 2.1 Which kits

Every kit whose editor shows the document in a view a person points at
conforms to this set: viewers and editors, kits on engine tools and kits
whose tools are written in their editor, canvas and DOM editors. A kit whose
editor has no such view (a form of fields only) has nothing to declare and
conforms trivially; its fields still follow the `form-fill` keys (section
4.2).

### 2.2 Keys

Keys are given for macOS: `Cmd` is `Ctrl` and `Alt` is `Option` elsewhere
(`Alt` on Windows and Linux). A host's own shortcuts (`ui/initialize`
`shortcuts`) win over every gesture here and are forwarded (UI-K5); a kit
whose default key below is a host shortcut offers the command another way
(a menu, the context menu) and keeps the gesture's meaning for every other
key.

### 2.3 Pointer types

- **PT14** Pointer events carry `button` (`primary`, `secondary`,
  `middle`), `pointerType` (`mouse`, `pen`, `touch`), `clicks` (1, 2, or 3),
  and, for pens, `pressure` and `tilt` (section 6). A kit MUST accept every
  value. A pen's primary contact behaves as a mouse's primary button, with
  pressure and tilt for `draw` tools; its barrel button behaves as
  `secondary`. Behaviour rules for `touch` (one-finger pan or select,
  pinch, long press) are not part of `KitPointer 1.0`; until a later minor
  version specifies them, a kit MAY treat a one-finger touch as the primary
  button and a two-finger pinch as zoom (the `zoom` role's wheel row).

## 3. Tool roles

- **PT1** Every tool a kit offers on its canvas MUST declare a **role**,
  one of the table below. A kit MAY have several tools of one role (a
  marquee and a lasso are both `select`) and kit-specific tools of role
  `custom`, which declare whether they mutate.

| Role | Mutates the document | What it does | Typical kits |
| --- | --- | --- | --- |
| `select` | No (the selection only; dragging a selected object is a `transform` gesture) | Selects objects | Every kit with objects |
| `text-select` | No | Selects text in content the tool does not edit | pdf; any kit's viewer |
| `text-edit` | Yes | Places a caret and edits text | doc, slide, sheet cells, layout, note |
| `hand` | No | Pans the view | Every kit |
| `zoom` | No | Zooms at the pointer | Every kit |
| `place` | Yes | A click places an object at a point; a drag defines its rectangle | pdf comments and stamps, board cards, slide shapes |
| `form-fill` | Yes | Edits a form field in place | pdf forms; table and sheet cells MAY use it |
| `transform` | Yes | Moves, resizes, and rotates objects through handles | Every kit with objects |
| `draw` | Yes | Freehand, pen, shape, and brush strokes | photo, vector, board, pdf ink |
| `custom` | As the tool declares (`mutates`) | Anything else (cad prompts, film's razor) | |

- **PT2** *Read-only.* A tool whose role does not mutate (`select`,
  `text-select`, `hand`, `zoom`, and `custom` tools declared
  `mutates: false`) MUST NOT change the document: its revision, dirty state,
  and history stay as they are. In a read-only session (`document.readOnly`,
  UI-K7) a kit and its SDK MUST let such tools run, so a viewer selects,
  copies, pans, and zooms; and MUST refuse every tool whose role mutates.
  Within a non-mutating role, the gestures that edit (Delete, dragging a
  selected object, cut, paste) are commands, and a read-only session refuses
  them as it refuses any edit. A commenter (UI-K7) also runs the tools
  whose every effect is one of the kit's comment commands (a `place` tool
  for sticky notes, a text markup tool), and no other mutating tool.

> Known conformance gap, found by code reading: `@kition/kit-editor` refuses
> every engine-tool event (`pointer`, `toolKey`, `toolText`) in a read-only
> document (`READ_ONLY_RULES.refusedTools`), so a viewer of an engine-tool
> kit can neither select nor copy. That does not conform to PT2 or UI-K7;
> the SDK is to be fixed, the rule stays.

## 4. Minimal behaviour per role

Every tool of a role MUST behave as below. A kit MAY add behaviour where a
cell says "—" or "kit-defined", and MUST say what it added in the tool's
`hint`; it MUST NOT give a listed gesture another meaning. "The object under
the pointer" is the topmost object the kit hit-tests at that point, the same
answer `ai/hitTest` gives (section 8).

### 4.1 Objects: `select`, `transform`, `place`

| Gesture | `select` | `transform` | `place` |
| --- | --- | --- | --- |
| Click | Select the object under the pointer; on empty space, clear the selection | On a handle, start it; elsewhere as `select` | Place a new object at the point, select it, and hand over to the role that edits it (a note's text goes to `text-edit`) |
| Shift+click | Add the object to the selection, or remove it | As `select` | — |
| Drag on empty space | Marquee: select every object the rectangle touches. With `Alt`, kit-defined (enclosed only, or as without); the hint says which | Marquee, as `select` | Define the new object's rectangle; Shift keeps the default proportions, Alt draws from the centre |
| Drag on a selected object | Move the selection: a `transform` gesture, one undo step (PT4) | Move | — |
| Drag on an unselected object | Select it, then move it | Select it, then move it | — |
| Double click | Enter the object: edit its text, or open the group | As `select` | — |
| Triple click | — | — | — |
| `Escape` | Clear the selection; inside a group, leave the group first | Cancel the gesture in progress and restore what it changed; with none, as `select` | Cancel the placement in progress; with none, switch back to the kit's default tool |
| `Delete`, `Backspace` | Delete the selection | Delete the selection | — |
| Arrows | Nudge the selection by one document unit; Shift: by ten | As `select` | — |
| `Tab`, `Shift+Tab` | Select the next or previous object in the kit's reading order | As `select` | — |
| `Enter` | Enter the selected object (as a double click) | As `select` | Place at the last pointer position |
| `Cmd+A` | Select every object on the page, slide, sheet, or canvas | As `select` | — |
| `Cmd+C`, `Cmd+X`, `Cmd+V` | Copy, cut, and paste objects; the copy also carries a text or image rendering (section 4.5) | As `select` | — |
| Right click | Select the object under the pointer unless it is selected, then open the context menu for the selection | As `select` | Context menu for the point |

### 4.2 Text: `text-select`, `text-edit`, `form-fill`

| Gesture | `text-select` | `text-edit` | `form-fill` |
| --- | --- | --- | --- |
| Click | Clear the selection; place the selection's anchor at the point | Place the caret at the point | Focus the field under the pointer; toggle a checkbox or radio button; open a choice list |
| Shift+click | Extend the selection to the point | Extend the selection to the point | Extend the selection within the field |
| Drag | Select from the press to the pointer in reading order | Select from the press to the pointer; on selected text, move it if the kit moves text, else extend | Select within the field |
| Double click | Select a word | Select a word | Select a word in the field |
| Triple click | Select the line or paragraph (the kit says which in the hint) | Select the paragraph | Select the field's text |
| `Escape` | Collapse the selection | Collapse the selection; again, leave editing to the kit's default tool (or `select` on the object edited) | Leave the field, keeping what was typed |
| `Delete`, `Backspace` | — (the content is not edited) | Delete the selection, or the character after or before the caret | As `text-edit`, within the field |
| Arrows | Move the selection's focus; Shift extends | Move the caret; Shift extends; Alt moves by word; Cmd moves to the line's start or end | As `text-edit`, within the field |
| `Tab`, `Shift+Tab` | — | Kit-defined in text (indent, next cell); the hint says which | Next or previous field in the document's tab order |
| `Enter` | — | Kit-defined (new paragraph, commit a cell) | Commit; in a multi-line field, a new line |
| `Cmd+A` | Select all text in the flow (the page, for a paged viewer without a flow) | Select all text in the object or flow being edited | Select the field's text |
| `Cmd+C`, `Cmd+X`, `Cmd+V` | Copy as `text/plain`, and `text/html` where the kit keeps formatting; no cut or paste | Copy, cut, and paste text | Copy, cut, and paste text |
| Right click | Context menu for the selection; inside no selection, place the anchor first | Context menu for the selection or the caret | Context menu for the field |
| Typed text | — | Inserted at the caret, through the input method (PT5) | Inserted in the field, through the input method (PT5) |

### 4.3 View and drawing: `hand`, `zoom`, `draw`

| Gesture | `hand` | `zoom` | `draw` |
| --- | --- | --- | --- |
| Click | — | Zoom in one step, keeping the point under the pointer; Alt+click zooms out | Kit-defined: a dot, or a path point for a pen tool |
| Shift+click | — | — | Draw a straight segment from the end of the last stroke |
| Drag | Pan the view | Zoom to the rectangle | Draw a stroke; Shift constrains (straight lines at 45-degree steps, or equal proportions for shapes), Alt draws a shape from its centre |
| Double click | Kit-defined (fit the page or canvas) | Kit-defined (actual size) | Finish the path in progress |
| `Escape` | Cancel a pan in progress | Cancel a zoom rectangle | Cancel the stroke in progress; with none, switch back to the kit's default tool |
| `Enter` | — | — | Finish the path in progress |
| `Delete`, `Backspace` | — | — | Remove the last point of a path in progress |
| Arrows | Scroll | Scroll | — |

### 4.4 In every role

| Gesture | Meaning |
| --- | --- |
| Wheel, trackpad scroll | Scroll the view |
| `Cmd`+wheel, trackpad pinch | Zoom at the pointer |
| Hold `Space` and drag | Pan, then return to the tool; not while a text role has a caret, where Space is typed |
| `Cmd+=`, `Cmd+-`, `Cmd+0` | Zoom in, zoom out, fit the page or canvas |
| `Cmd+Z`, `Cmd+Shift+Z` | Undo and redo, not during a gesture (`Escape` first) |
| Middle button drag | Pan |
| Keys during a gesture | Go to the tool (`busy`); a kit-editor bridge does not apply defaults to them |
| `Escape` in Focus (display mode) | Goes to the tool and the kit first, as in every other mode: cancel the gesture, leave the group or text, clear the selection, return to the default tool. Only an `Escape` nothing took leaves Focus. A kit that takes an `Escape` MUST mark it taken (DOM `preventDefault()`), and MUST NOT mark one it did nothing with, or the person cannot leave Focus by key |

### 4.5 Handles, undo, caret, commands, clipboard

- **PT3** *Handles.* A `transform` tool shows eight resize handles, and one
  rotation handle where the object rotates. Shift keeps proportions (or
  frees them, for objects that keep them by default, such as pictures; the
  hint says which), Alt resizes from the centre, and Shift while rotating
  snaps to 15 degrees. Every handle MUST have a hit area of at least 8 screen
  pixels at any zoom, and the cursor of its direction.
- **PT4** *One gesture, one undo step.* A gesture, from press to release
  (or from a key's first press to its last repeat), is one undo step,
  whatever number of commands it ran, labelled by what it did (`Move`,
  `Resize`, `Highlight`). `Escape` during a gesture leaves no undo step.
- **PT5** *Caret.* A tool that takes text MUST report the caret's rectangle
  (section 6) so the input method's candidate window opens at the caret,
  and MUST work with composition (UI-K6).
- **PT6** *Commands behind gestures.* Every effect a tool has on the
  document MUST be reachable as an agent-facing command with explicit
  parameters (the page, the rectangle, the object ids, the text range), and
  the undo label of the gesture MUST be that command's title.
- Copying puts `text/plain` on the clipboard, plus `text/html` where the
  kit keeps formatting and the kit's own type
  (`application/x-kition-<kit>+json`) for objects; pasting takes the kit's
  own type first, then images, then HTML, then plain text. Clipboard access
  happens in the kit's frame, on the person's gesture (section 10).

## 5. Selection

- **PT7** *The selection.* A kit reports its selection in this shape:

  ```json
  { "kind": "objects", "objects": ["4f0c…", "9b21…"], "page": 2,
    "bounds": [72, 144, 268, 76], "summary": "2 comments on page 2" }
  ```

  ```json
  { "kind": "text",
    "text": { "anchor": { "object": "4f0c…", "field": "text", "offset": 4 },
              "focus":  { "object": "77de…", "field": "text", "offset": 17 },
              "excerpt": "Revenue grew in the third quarter" },
    "page": 1, "bounds": [72, 90, 410, 30], "summary": "Text in 2 paragraphs" }
  ```

  | `kind` | Its field | Shape |
  | --- | --- | --- |
  | `none` | | Nothing is selected |
  | `objects` | `objects` | Object ids, in selection order |
  | `text` | `text` | `{ anchor, focus, excerpt? }`; `anchor` and `focus` are positions `{ object, field, offset }`, the same shape as presence's caret (UI protocol 7e); a collapsed selection (a caret) has equal positions |
  | `cells` | `cells` | `{ sheet, ranges, active }`: the sheet's name, ranges in A1 notation, the active cell |
  | `time` | `time` | `{ start, end, tracks? }`: seconds on the timeline, and track ids |
  | `pixels` | `pixels` | `{ layer, bounds }`: the layer's object id and the selected area's bounding box |

  Beside the field of its kind, a selection MAY carry `page` (counted from
  1), `bounds` (`[x, y, width, height]` in document units of that page or
  canvas), and SHOULD carry `summary`, one English phrase for people and
  models. Object ids are KDM ids (M8) for kits on the Kit Data Model, never
  engine-local ids, as presence requires; a kit without the KDM uses the ids
  its `<prefix>_inspect` answer and its commands use. Text offsets count
  Unicode scalar values, as the object model counts text positions.
  `excerpt` is at most the first 1,000 scalar values of the selected text.
  A selection carries at most 256 object ids or 64 ranges; a larger one
  sends the first of them and `truncated: true`.
- **PT8** *Reporting.* A kit sends `selection/changed { selection }` (UI
  protocol section 7h) whenever its selection changes, at most about ten
  times a second during a gesture, and once more when the gesture ends. A
  kit that shares presence (UI protocol section 7e) derives `presence/set`
  from the same selection: the objects (or, for text, the objects of the
  anchor and the focus) as `selection`, and the focus as `caret`.
- **PT9** *Reading and setting it.* A host reads the selection with
  `ai/selection` and sets it with `ai/select { selection, reveal? }`, which
  selects only what the kit finds, changes no document state, and answers the
  selection that resulted. A host MUST NOT send `ai/select` while the person
  is in a gesture (the tool is `busy`), and a kit refuses it then (reason
  `busy`). With `reveal: true` the kit scrolls the selection into view only
  when the person has not pointed, scrolled, or typed in the editor during
  the last two seconds; otherwise it selects without moving the view. A host
  sends `ai/select` only on behalf of the person's own agent, never into
  another person's session.
- **PT10** *Explicit targets.* Agent-facing commands MUST NOT read the live
  selection implicitly: a command that acts on "the selection" in the
  editor takes its target as a parameter (the editor fills it from the
  selection), so a call gives the same result headless and in the page
  (A26). A kit MAY accept `target: "selection"` on a command an agent calls
  through the live bridge; headless, where there is no person and no
  selection, it MUST refuse it with `invalid-params`.
- **PT12** *Selection is personal.* What a person selected in a co-edited
  document is theirs: a host answers `ai/selection` and A33's `selection`
  only to that person's own agent (A11), and MUST NOT give another person's
  selection to an agent. Presence (UI protocol 7e) stays the only way the
  other people see it.

## 6. Engine tools (U8b)

A kit whose engine owns its tools' state machines declares `engine-tools`
and exports the members of U8b ([kit editors](../kits/ui.md#engine-tools));
the engine contract reference lists them. The JSON shapes:

| Type | Fields |
| --- | --- |
| Tool info | `id`, `label`, `shortcut`, `icon`, `group`, `role` (PT1), `mutates` (true for mutating roles; declared by `custom` tools), `hint` (one English sentence for the status bar and for agents, naming what the tool adds to section 4) |
| Pointer event | `action` (`down`, `drag`, `up`, `move`), `x`, `y` (document pixels), `mods`, `zoom`, `button`, `pointerType`, `clicks`, `pressure?`, `tilt?` (`{ x, y }` in degrees) |
| Tool response | `requests`, `overlays`, `cursor`, `busy`, `wantsText`, `selection?` (PT7, when it changed), `caret?` (`{ x, y, height, angle? }` in document units) |
| Request | `dialog`, `switchTool`, `status`, `contextMenu { x, y, commands }` (command ids), `copy { items }` (a map of MIME type to text), `paste { accept }` (MIME types), `reveal { rect }`, `undoGroup { phase: "begin" \| "end", label }` |
| Overlay | `marquee`, `path`, `ants { d, color, width }` (marching ants: dashes moving along the path, a copied area; the editor redraws only while one is shown), `line`, `anchor`, `handle`, `label`, `measure`, `highlight`, `swatch`, `caret`, `focusRing { rect }` (a form field), `guide { axis, at }` (snapping); a `handle` carries `id` and `role` (`resize-n`, `resize-ne`, `resize-e`, `resize-se`, `resize-s`, `resize-sw`, `resize-w`, `resize-nw`, `rotate`, `move`, `anchor`, `control`) |

A double or triple click is a `down` with `clicks` 2 or 3; there is no
separate double-click action. The editor around the canvas (`@kition/kit-editor`'s
bridge) gives every role the keys of section 4 unless the engine takes the
key (`busy` or `wantsText`); runs `copy` and `paste` in the kit's frame;
places its hidden text input at `caret`; draws handles with the 8-pixel hit
area (PT3); opens context menus from command ids; groups undo per gesture
(PT4); runs non-mutating tools in read-only sessions (PT2); and relays
`selection` as `selection/changed` (PT8).

## 7. Editor tools and DOM editors (U10)

- Tools written in the kit's editor (`@kition/kit-editor`'s `KitTool`, or the
  kit's own) declare the same `role`, `mutates`, and `hint`, follow section
  4, and report their selection through the editor's session. `@kition/kit-editor`
  exports the shared key handling of section 4, so they need not write it
  again.
- **PT13** *DOM editors.* An editor whose document view is DOM (a
  `contenteditable` region, a code editor such as CodeMirror, SVG elements,
  a grid of cells) conforms like a canvas editor. Its tools declare roles
  even when the person never picks a tool (a note editor is one `text-edit`
  tool; a board's canvas offers `select`, `transform`, `place`, `hand`, and
  `zoom`). It maps the browser's own selection to PT7 positions in KDM ids
  and scalar offsets, never DOM offsets; it overrides a browser default that
  gives a gesture of section 4 another meaning; and it meets PT5 when the
  focused editable element holds the caret, since the browser then places
  the input method itself. Its handles meet PT3 at every zoom, and its
  gestures are one undo step each (PT4), not one per DOM mutation.

## 8. Hit testing for agents

A vision model that looks at a preview names what it sees by position ("the
box at 412, 230"). Hit testing turns that position into object ids, so the
agent can act on them with explicit targets (PT10). It is optional in this
edition.

- The page binding is `ai/hitTest` (UI protocol section 7h, capability
  `hit-test`); the headless binding is `view.hitTest` (Kit Process Protocol
  section 7); the agent tool is `<prefix>_hit`
  ([`KitAgent 1.4`](agent.md) A31 to A33).
- Params: `{ x, y, space, page?, target?, scale?, maxSize?, draft? }`.
  `space: "preview"` takes `x` and `y` in pixels of the image an earlier
  `ai/preview`, `view.screenshot`, or `<prefix>_inspect` returned for the
  same `page`, `target`, `scale`, and `maxSize`; `space: "document"` takes
  document units of `page` (counted from 1) or of the canvas.
- Result: `{ hits: [{ id, type?, bounds, page? }] }`, the objects under the
  point, topmost first, at most 32; `type` is the object's type name and
  `bounds` is `[x, y, width, height]` in document units. A point on nothing
  answers `hits: []`.
- Hit testing changes nothing: no document state, no selection, no view. It
  answers in read-only sessions.

## 9. Files and drops

Dropping files on the canvas and pasting files are pointer gestures whose
bytes come from outside the kit; they follow [`KitFiles 1.1`](files.md).

- A host that receives a drop of the person's files over the kit's frame (a
  desktop host gets drops at its window) grants `read` handles for them as
  for a pick, the drop being the person's consent, and sends
  `files/dropped { files, x, y }` (UI protocol section 7h): file stats
  (FA3) and the point in the frame's CSS pixels.
- A drop or paste that the browser delivers to the kit's frame itself
  carries `File` objects: bytes and a name, no path. The kit MAY read their
  bytes, since the person's gesture brought them, and MUST NOT look for or
  use a path in them (FA-P2).

## 10. Accessibility

- **PT11** A kit SHOULD expose the selection's `summary` and the selected
  text to assistive technology (an ARIA live region in its frame), and MUST
  offer a keyboard way to every pointer action: the keys of section 4 plus
  the commands of PT6.

## 11. Security considerations

- **Clipboard.** A kit reads and writes the clipboard only in its own frame
  on the person's gesture; the browser enforces it, and a host's frame
  `allow` lists `clipboard-read` and `clipboard-write`. Agents never read
  the clipboard through this set.
- **Selection is personal data** in a co-edited document (PT12).
- **`ai/select` cannot edit.** It changes the selection and, at most, the
  view, never during a gesture, and never in another person's session
  (PT9).
- **Read-only.** Only tools that cannot change the document run in a
  read-only session (PT2); the engine worker's revision check and the
  host's refusal of writes (UI-H7) stay as the backstop.
- **Hit testing** reveals nothing the preview does not already show.
- **Drops** grant `read` only, for the dropped files only (section 9).

## 12. Conformance

A kit conforms to `KitPointer 1.0` when it passes `checkPointerRoles` from
`@kition/kit-dev-host` in Chromium and WebKit, a black-box driver that
scripts the pointer and the keyboard against the kit's editor and a fixture
whose object positions are known. It applies to canvas and DOM editors
alike (PT13), and to engine tools and editor tools alike. A host conforms
when it meets PT2, PT9, and PT12 and UI-S1 to UI-S4. The steps are in
[conformance.md](../conformance.md#kitpointer-10).

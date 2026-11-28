# Kit editors

How a kit draws its own editor, shown by a host in an iframe over [the Kit UI protocol](../reference/ui-protocol.md).

## UI contract

A kit draws its own editor. The kit ships a web UI (`ui.entry`); the host
shows it in an `<iframe>` and talks to it over the **UI protocol**.

- **U1** An embedded kit MUST conform to the kit obligations of the UI
  protocol (UI-K1 to UI-K8), and a host to its host obligations (UI-H1 to
  UI-H7); both also follow the rules of the capabilities they declare (such
  as UI-S1 to UI-S4 for `selection`, UI-N1 for `links`).
- **U2** An embedded kit MUST draw with the host's theme tokens ([Kit UI protocol](../reference/ui-protocol.md)
  section 4), so every kit looks like the host it runs in. Kits SHOULD build
  on the shared `@kition/kit-editor` components, which use only those tokens.
- **U3** An embedded kit MUST ship its strings for `en-US` and SHOULD for the
  host's locales.
- **U4** An embedded kit's engine still conforms to the [engine contract](engine.md), and its
  headless executable ([`KitAgent 1.4`](../sets/agent.md)) runs the same engine, so a person and an
  agent edit the same document the same way.
- **U5** Hosts SHOULD keep timing behavior identical across browser engines:
  audio contexts are resumed and playback clocks started inside the gesture
  (WebKit starts audio contexts suspended). This applies to kit UIs as well.
- **U5a** An embedded kit SHOULD honor UI configuration (UI protocol section 9) and, when it
  does, MUST follow rules UI-C1 to UI-C6 and give every element a person can press an id.
  `@kition/kit-editor` implements it for kits that declare their elements with `defineKitUi`.
- **U5b** A kit MAY declare a brand color, `ui.brand: { "light": "#rrggbb", "dark": "#rrggbb" }`
  in its manifest. `light` MUST give at least 4.5:1 with white text; `dark` at least 4.5:1
  with black text and 3:1 on `#1b1e23` and `#323232`. The kit uses it for its primary color
  unless the host's theme says `brand: "host"`.
- **U5c** A kit MAY declare its editor's default display mode, `ui.display`: `menus` (the
  tabs open as drop-down menus; no command area), `line` (one row of the selected tab's main
  commands), or `classic` (the full ribbon). The person changes it and the editor keeps their
  choice; a host restricts or presets it with the UI configuration's `modes` ([UI protocol](../reference/ui-protocol.md)
  section 9, display modes). Each kit declares the mode its documents are best worked in:
  drawing, whiteboard, photo, video, motion, CAD, 3D, and code or page editors default to `menus`
  (the canvas or source needs the room; their commands are used less often than their tools);
  document, sheet, slide, PDF, and layout editors to `line`. An editor without tabs (a records
  table with its own bars) declares none: it shows Menus. Without it, `@kition/kit-editor` opens
  in `line`.
  Focus draws the canvas and a small floating bar only: a kit's own bars (a formula bar, sheet
  tabs, a notes pane, a command line, rulers, a timeline, a footer) are not drawn there either,
  and nothing of the kit's sits under the bar. A `@kition/kit-editor` kit wraps
  each in `<FrameChrome>`, anywhere inside its `EditorFrame`; `useFrameMode()` returns the mode
  the frame shows, for anything else a kit draws differently by mode.

## Engine tools

- **U8b** *Engine tools.* A kit whose engine owns its tools' state machines
  SHOULD declare the `engine-tools` capability and export these members:
  `tools()`, `tool()`, `selectTool(id, zoom)`, `pointer(event)`,
  `toolKey(key, mods, zoom)`, `toolText(text, zoom)`, and
  `toolState(x, y, mods, zoom)` (and, optionally, `pointerLeft(zoom)` for the
  pointer leaving the canvas), with the shapes of
  [`KitPointer 1.0`](../sets/pointer.md) section 6. Every tool declares its
  role, whether it mutates, and a hint (PT1). Pointer events are in document
  pixels with the view's zoom and carry the button, the pointer type, the
  click count, and a pen's pressure and tilt (PT14). Each answer carries the
  requests only the editor around the canvas can fulfil (dialog, switch
  tool, status, context menu, copy, paste, reveal, undo group), the overlays
  to draw (marquee, path, marching ants, line, anchor, handle with its
  semantic role, label, measure, highlight, swatch, caret, focus ring,
  guide), the cursor,
  whether the tool is busy or wants typed text, and, when they changed, the
  selection (PT7) and the caret rectangle (PT5). The kit's editor runs such
  tools through one generic bridge that gives every role the default keys
  of `KitPointer 1.0` section 4, runs clipboard requests in the frame, puts
  its text input at the caret, groups undo per gesture (PT4), runs
  non-mutating tools in read-only documents (PT2), relays the selection
  (`selection/changed`), and draws the overlays in the kit's own style
  (`@kition/kit-editor` does).

## Editor tools

- **U10** *Editor tools.* Tools a kit writes in its editor instead of its
  engine (`@kition/kit-editor`'s `KitTool`, or a DOM editor's own handling)
  declare the same role, `mutates`, and hint as U8b, follow the behaviour of
  `KitPointer 1.0` section 4 (using the shared key handling `@kition/kit-editor`
  exports), report their selection (PT7, PT8), and meet PT2 to PT6. DOM
  editors (a `contenteditable` region, a code editor, SVG or HTML elements
  over the document) conform the same way as canvas editors (PT13).

- **U10a** *Page replicas.* A kit editor that edits a KDM replica of its document in the page,
  so typing never waits for the engine worker, keeps it in step with the worker's replica
  in one order: its edits go to the worker after each local transaction, and the
  worker's changes (engine commands, agents, a file changed outside) come back when
  the session reports a change, one exchange at a time, in order. An exchange reads the page's
  version only after the worker answered, so an edit made while it waits is still sent.
  `@kition/kit-editor`'s `WorkerRelay` does this; kits SHOULD use it rather than their own.

- **U10b** *Kit-owned undo.* The frame's Undo and Redo (top bar, Focus bar, Edit menu,
  shortcuts) show and run the engine's history unless the kit gives its own: a kit whose
  steps live in more than its engine (a page replica next to the engine's, U10a) passes
  `useKitEditorState`'s `history` option (`KitHistory`: `canUndo`, `canRedo`, `undo`,
  `redo`, `subscribe`), and the frame runs that history under the host's configuration
  for `action:undo`, `action:redo`, `command:edit.undo`, and `command:edit.redo`. Its
  history is the person's: it does not take back the agent's steps (U10a's engine steps
  are the person's scope, [`KitModel 1.1`](../sets/model.md) M12a).

- **U10c** *Input in order.* The person's input takes effect in the order it arrived: every key,
  typed text, click and the command each runs reaches the engine after what was pressed before it
  and before what was pressed after it, and none is dropped while the engine is busy. A key whose
  effect needs an engine answer first is decided in that order and holds the input after it until
  it is decided: a shortcut the list of what can run (read after the last change) calls disabled
  asks the engine and runs there (`@kition/kit-editor`'s `runWhenEnabled`, through the session's
  `inOrder`, which also orders a kit's own multi-step decisions: a command run inside its work
  passes `inOrder: true`), and an editing key the engine tool's last answer does not take, pressed
  while an event that can change what the tool takes is still on its way (a press, a release, a
  click, a tool choice, a key or text sent to the tool, or a key held before it: Enter right after
  the click that starts a text frame, an arrow right after the document opened), waits for their
  answers; behind a hover, a drag's move, a state query (Focus resizing the canvas, a zoom) or a
  command alone it is decided at once. A key that waited and that the tool, on the fresh answer,
  does not take is given back to where it would have gone had it not waited: the frame's own
  handling in its usual order (the kit's key handler, the shortcuts, Escape leaving Focus), exactly
  once and before the input after it, on the focused element, or where it was pressed (its frame)
  when the focus fell to the page meanwhile; it is never lost and never also given to the tool.
  `useEngineTools`'s `escapable` only says whether a tool that takes text or is busy has something
  for Escape to cancel; a kit whose tool takes text only while it edits needs none. A character
  typed into the text sink stays text: a shortcut takes it only when the list read last says it
  can run, never through a decision made later. A kit's own key handler runs its commands through the session
  (`editor.run`, `session.run`), which keeps that order; one that returns false leaves the key
  to the frame, as above.

## Unused requirement IDs

U6 to U9 and U8a are not used: no host draws kit editors, and engine tools
are U8b (`KitPointer 1.0`).

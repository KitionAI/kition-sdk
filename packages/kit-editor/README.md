# @kition/kit-editor

The SDK for a kit's editor: the web app a kit ships (`ui.entry`), which a host shows in an iframe
over [the Kit UI protocol](https://github.com/KitionAI/kition-sdk/blob/main/docs/platform/reference/ui-protocol.md). It holds the kit's side
of the protocol (host connection, document session, leases, conflicts), the editor frame
(`EditorFrame`: top bar, display modes, ribbon, tool rail, panels), the engine canvas and its
tools, and comments and presence. `@kition/kit-host` is the host's side; `@kition/kit-ui-protocol`
holds the messages both send.

The components are Kition Tessera's (`@kition/tessera-ui`, with `@kition/tessera-icons` and
`@kition/tessera-tokens`); see Tessera's docs for each component.

## Import from kit-editor

A kit editor depends on `@kition/kit-editor` only. It re-exports every Tessera component under
its usual name, wires them to the Kit UI protocol (the host's theme, locale, hidden and disabled
elements, host buttons), and loads Tessera's stylesheet from its own.

Icons come from `@kition/tessera-icons/react` when the kit lists it in package.json, or from
kit-editor's `TesseraIcons` namespace otherwise. Bundlers keep only the icons a kit uses.

```ts
import '@kition/kit-editor/styles.css'
import { Button, RibbonGroup, RibbonButton, NumberField, TesseraIcons } from '@kition/kit-editor'
import { LayersIcon } from '@kition/tessera-icons/react' // or TesseraIcons.LayersIcon
```

## Icons for engine commands

Ribbons and menus built from engine commands get their icons from kit-editor's rules: a
command's verb first (`edit.undo`, `layer.mergeDown`), then what it acts on, then the neutral
command mark. A kit names icons for the commands the rules cannot read in
`web/src/commandIcons.ts`, imported once from `main.tsx`.

```ts
import { registerCommandIcons } from '@kition/kit-editor'
import { DimensionAlignedIcon, FilletIcon } from '@kition/tessera-icons/react'

registerCommandIcons({
  dimaligned: DimensionAlignedIcon,
  fillet: FilletIcon,
})
```

## Engine overlays in the kit's style

`useEngineTools` draws the overlays an engine tool answers with (marquee, path, marching ants,
line, anchor, handle, label, measure, highlight, swatch) over the canvas, in Kition's style by default. A kit
that needs its own look passes either or both of these options (keep them stable: module
constants or memoized values, since a new object redraws):

- `overlayStyle` (`OverlayStylePatch`): changes to `DEFAULT_OVERLAY_STYLE` per overlay kind:
  the accent, surface and ink colours, the font, the marquee's fill, opacity, stroke, width,
  dash and whether the stroke lies inside, line and path widths and dashes, anchors' shape
  (`square` with a corner radius, or `circle`), default size, fill and ring width, handles'
  radius, fill and ring, marching ants' dash, speed and gap colour, labels' font, offset, text
  colour and box (fill, border, padding, radius; none by default), the measurement pill's fill, text colour,
  font, padding, height, radius, offset and alignment, and swatches' size, radius and rings.
- `drawOverlay` (`OverlayDrawer`): called for each overlay with an `OverlayDrawContext` (the
  2D context on its own saved state, `toScreen` for document points, the `view` with its zoom,
  the resolved `style`, every overlay of the frame with this one's `index`, a `frame` scratch
  object shared by the frame's calls, and `drawDefault`). It returns `true` when it drew the
  overlay; kit-editor draws the others in the style.

```ts
const STYLE: OverlayStylePatch = { accent: '#00875f', marquee: { fillOpacity: 0.1, dash: [], inside: true } }
const draw: OverlayDrawer = (overlay, { context, toScreen }) => {
  if (overlay.kind !== 'handle') return false
  const p = toScreen(overlay.x, overlay.y)
  context.fillStyle = '#ffffff'
  context.strokeStyle = overlayCss(overlay.color)
  context.beginPath()
  context.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
  context.fill()
  context.stroke()
  return true
}
const tools = useEngineTools(session.tool, ready, session.change, { initial: 'move', overlayStyle: STYLE, drawOverlay: draw })
```

`drawEngineOverlays(overlays, style, draw)` and `drawOverlayInStyle` are the same drawing as a
plain `RasterDecoration`, for a kit that draws overlays from elsewhere.

## Gestures and the canvas

- The canvas gives a tool's pointers `ctrl` (Control itself; `meta` is Command or Control) and a
  press its `clicks` (1 to 3); engine tools get them as `mods.control` and the press's `clicks`.
  The pointer leaving the canvas with no gesture held reaches the engine as `pointerLeft(zoom)`
  when it has one.
- While the engine answers, a waiting drag sample gives way to the next one; `useEngineTools`'s
  `keepsDragSamples(toolId)` keeps every sample of a tool (a pencil's stroke).
- During a gesture (the tool's answers `busy`, before the settled release) the changes it makes
  say so (`KitChange.gesture`): the tool's state and the disabled commands are not asked again
  after each step, only after the release. `useKitDocument`'s `quietGestures` also stops the
  engine reading `inspect()` at each step (`info.inspected` stays as it was until the release),
  for a kit whose panels take live numbers from the tool's answers.
- `useEngineTools` gives the same object until one of its parts changes.
- A pan past the painted frame shows at once, the part it uncovered blank until the strip renders;
  only a jump past every painted pixel keeps the old frame in place until the new one lands. A whole
  render with a frame on screen (an edit, an undo, a zoom) renders the view alone, and the margin
  past it once the canvas has been still for 120 ms, a quarter of the view at a time. Frames lie
  on whole device pixels at every zoom, and the view on screen is placed on one; `onView` and
  `view()` report that placed view, so a kit's own overlays land on the pixels drawn.
- A tool's `hover` may answer a CSS cursor (`text` over text, `move` over a comment): the canvas
  shows it until the next hover, the pointer leaving or another tool, with no new tool object.
  `KitGesture`, `KitToolContext` and `KitOverlay` are exported for writing tools.
- A wheel over the HTML a kit lays over the canvas (`KitDocumentCanvas`'s `children`) scrolls and
  zooms the document as over the canvas; one a child takes (default-prevented) or a scrolling
  element in it can still scroll by stays the child's.
- Marching ants (the engine's `ToolOverlay::Ants`, overlay kind `ants`) move along their path at
  `overlayStyle.ants.speed` CSS pixels a second: while one is shown the canvas redraws the overlays
  on a timer (`useEngineTools`'s `animated`), and an idle canvas without them does not redraw.
- `wheelPan` (on `KitDocumentCanvas` and `KitCanvas`) says where a wheel's scroll takes the view
  (`KitWheelPan`: the deltas, the view, and the top-left the canvas would pan to); it answers the
  top-left to pan to (a sheet's whole rows), or null to pan as usual. Cmd or Ctrl with the wheel
  still zooms.
- `edgeScroll` (`KitEdgeScroll`) scrolls the view while a held gesture's pointer is past the edge
  of the canvas's scrolling part (the canvas without the document's pinned bands): every frame,
  the pointer still or not, at `speed(over, axis)` CSS pixels a second, sending the gesture's move
  again from the pointer's last place; `ways(view)` limits the directions (a column resize does
  not scroll back), `hold` holds the pointer the gesture is given just inside the edge, and
  `onEdge(past)` tells the kit how far past the edges the pointer is, then null once when it is
  back. Past the left or top edge counts only while the view can go back that way. Off by default.
- A mouse wheel's notch with Cmd or Ctrl zooms `WHEEL_NOTCH_ZOOM` (1.2) times, at most five
  notches an event, and a trackpad pinch continuously. `wheelZoom(zoom, { notches, direction,
  deltaY })` (on `KitDocumentCanvas` and `KitCanvas`) answers a kit's own steps (the next multiple
  of 10% a notch); `wheelNotches(event)` and `defaultWheelZoom` are exported.
- A right-click on the canvas calls the tool's `contextMenu(pointer)` in document pixels; on a Mac
  a click with Ctrl held is one too, and no press, for a tool that has one. The browser's menu
  never opens there. `useEngineTools`' `onContextMenu(at, answer)` gives the engine the right-click
  as a press and a release with `button: "secondary"` (`ToolPointer::button`), in the order of the
  input, then calls it with the release's answer, where the kit opens its menu (the engine chose
  what the menu is for, selecting what was under the pointer). A press's `clicks` reach the engine
  as `ToolPointer::clicks` (3: a triple click).
- An answer with `takesKeys` (`KitTools::takes_keys`) gives the tool the editing keys (arrows,
  Home, End, Enter, Tab, Delete, Backspace) though it is neither busy nor taking text; Escape stays
  the frame's. Keys to the tool carry `mods.control` apart from `mods.command`, so a Mac's
  Ctrl+Arrow is not its Cmd+Arrow.
- An input method's composition in the text sink reaches the tool as `toolPreedit(text, cursor,
  zoom)` (`KitTools::preedit`; `TextSink`'s `onCompose`, `useEngineTools`' `compose`), ended with
  the empty text before its finished text comes as `toolText`. An answer's `caret` (`{ x, y,
  height }` in document pixels, `KitTools::caret`) is `useEngineTools`' `caret` while the tool
  takes text, and the canvas keeps the text sink on it (one line as tall as the caret) as the view
  moves, so the candidate window opens under the caret's line.
- `tools.select(id, { locked: true })` chooses a tool locked (Lock Drawing Mode: it stays for one
  object after another until Escape or another tool, `KitTools::lock_tool`); `tools.locked` says
  whether the engine keeps it (`toolLocked`).
- A damage of the empty area at the origin (`ToolDamage::NONE`) repaints nothing: the answer moved
  the document's state, not its pixels. `useKitSession` takes `quietGestures` too.
- `useEngineTools`' `quietAnswers` keeps the tool's answers out of the caller's state: `decorate`
  stays one function drawing the latest answer's overlays, which the canvas redraws as each answer
  comes (`answers`: `get()` and `subscribe(listener)`), and the result changes only with the
  cursor, whether the tool takes text, its caret, its lock or the marching ants.

## Keys, reads and the frame

- A Cmd or Ctrl shortcut the list of what can run calls disabled is asked of the engine while that
  list may be behind it (`editor.listBehind()`: not read for the last change yet, or commands and
  tool events on their way): Cmd+Z right after an edit undoes it. Copy, cut and paste keep their
  clipboard event. With the list current, the key keeps its default.
- An agent's `ai/run` step whose command only reads (the catalog's `mutates: false`; Undo and Redo
  always count as edits) runs with `reads: true` (`KitRunOptions`): when it moved nothing `info`
  holds, the change counter stays, so the person's text selection and find matches kept per change
  stay too, and nothing repaints or reaches the host.
- A key pressed while the page's body holds the keyboard goes to the shell's `keyboardHome()` (the
  frame by default) with the key, once; copy, cut and paste only move the keyboard there. It is
  heard as the key bubbles to the document, after a kit's own listeners.
- `onFit` says what the status bar's Fit and Cmd+0 fit (a pager's current page).
- A bare Home and End are command shortcuts as Page Up and Page Down are (a tool that takes keys
  has them first), and a command runs from each of its keys: its `shortcut`, which menus show, and
  its `moreShortcuts` (`KitCommand::more_shortcuts`; `commandShortcuts(command)` lists them).
- In Single line, a primary `RibbonMenu`'s open menu is drawn in the row with it.
- `zoomKeys` says who has Cmd+0, Cmd+= and Cmd+-: `frame` (the default) fits and zooms before any
  command; `commands` lets a command whose shortcut is one of them run first (a sheet's Hide
  Columns on Cmd+0) and zooms only for a key no command has; `none` never zooms by key.
- `ctrlShortcuts: 'primary'` presses a command's `Ctrl+…` shortcut with Ctrl off a Mac, the main
  modifier there (by default it is the Control key, which no key off a Mac matches); a `Cmd+…`
  shortcut of the same key wins. On a Mac `Ctrl` is the Control key either way.
- `commandDialog` (`CommandDialogOptions`) shapes the parameters dialog: `label(param, command,
  schema)` and `choice(param, value, command)` name fields and enum choices in the person's
  language, and `structured` gives a list one field an item (Add, Remove), a list of named
  numbers (`[x, y]`) a field each, a list of choices a check box each and an object a field per
  property, instead of one JSON text box. A list of objects stays a JSON text box.

`KitDocumentCanvas` draws a kit's `decorateUnder` under the overlays and its `decorate` over
them, so canvas chrome can sit on either side (grids and frame labels under the selection, a
size pill and rulers over it). When the view zooms, the active engine tool is asked for its
state again, so overlays the engine sizes in screen pixels follow the zoom.

An engine that paints the area around its document itself (the pasteboard around pages, slides
or spreads) cannot be reached by CSS. `useEngineBackdrop(doc, canvas)` gives it the theme's
`--kit-canvas` as `#rrggbb` through its `setBackdrop` engine extra when the document opens and
again on every theme change (`applyTheme` writes the tokens on the root's style and marks its
`data-color-scheme`), then repaints `canvas`; `{ method, token, root }` name another engine extra,
token or element. `canvasColor(root?, token?)` is the resolution it uses: any CSS colour the host
sends (Kition sends `hsl(...)`) as `#rrggbb` through a 2D canvas, `null` when it is unset, not a
colour, or not opaque. Only the on-screen editor sets a backdrop; previews, export and print keep
the engine's own.

## Rules for kits

- Draw every colour, radius, and shadow from the theme tokens (`var(--kit-*)`), never literal
  values, so the host's theme and skins reach your editor. An engine's own pasteboard follows
  `--kit-canvas` through `useEngineBackdrop`.
- Pass icon sizes and `strokeWidth={ICON_STROKE}` from kit-editor; never a number of your own.
- New icons go into Tessera (`packages/icons/svg/`, its `docs/icon-style.md`), not into the kit.
- Give elements a Kit UI id (`uiId`, `RibbonGroup id`) so hosts can hide or disable them.

## A new kit

`tools/new-kit-ui.mjs` scaffolds a kit editor on kit-editor and Tessera Icons, with its dev
server allowed to read a kition-tessera checkout beside kition-sdk.

```sh
node tools/new-kit-ui.mjs --repo ../kition-mykit --id kit.mykit --name MyKit --crate mykit \
  --module kition_mykit_kit --class MyKitDocument --sample sample.mykit --accept .mykit --port 5300
```

<!-- kition-family:begin (generated by kition-sdk from templates/community/repositories.json, its family; edit the data there, not this text) -->
## Part of the Kition SDK

`@kition/kit-editor` is a package of the [Kition SDK](https://github.com/KitionAI/kition-sdk) ([its source](https://github.com/KitionAI/kition-sdk/tree/main/packages/kit-editor)), which lets you put Kition's editors in your product, and give the same files to your AI agent. Guides and reference: [developer.kition.ai](https://developer.kition.ai).

## The Kition family

Kition is the open pro suite for AI: 16 kits, editors that people and AI agents use on the same files, and the products around them ([all repositories](https://github.com/KitionAI)).

| Product | What it is | Links |
| --- | --- | --- |
| Kition Desktop | The open pro suite for AI: 16 editors and an agent in one desktop app | [GitHub](https://github.com/KitionAI/kition) · [kition.ai](https://kition.ai) |
| **Kition SDK** | Put Kition's editors in your product, and give the same files to your AI agent | [GitHub](https://github.com/KitionAI/kition-sdk) · [developer.kition.ai](https://developer.kition.ai) |
| `kition` command line | Install kits on demand and run them for your agent: `npx @kition/cli` | [developer.kition.ai](https://developer.kition.ai) · [Guide](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md) |
| Kition One | A self-hosted team workspace built on Kition's kits | [one.kition.ai](https://one.kition.ai) |
| Kition Server | Real-time co-editing for kits, self-hosted | [developer.kition.ai](https://developer.kition.ai) |
| Kit Harness Protocol (KHP) | The open protocol between a kit and its host | [GitHub](https://github.com/kitharness/kitharness) · [kitharness.org](https://kitharness.org) |
| Kition Tessera | The design system for kits | [GitHub](https://github.com/KitionAI/kition-tessera) · [tessera.kition.ai](https://tessera.kition.ai) |
| Kition Showcase | Sample files for every kit | [GitHub](https://github.com/KitionAI/kition-showcase) |
| Kition Universe | A 3D map of the kits and what they make | [GitHub](https://github.com/KitionAI/kition-universe) · [universe.kition.ai](https://universe.kition.ai) |
| Kition Fonts | The open fonts the editors use | [GitHub](https://github.com/KitionAI/kition-fonts) |

| Product line | Kits |
| --- | --- |
| Office | [Note](https://github.com/KitionAI/kition-note) · [Table](https://github.com/KitionAI/kition-table) · [Board](https://github.com/KitionAI/kition-board) · [Doc](https://github.com/KitionAI/kition-doc) · [Sheet](https://github.com/KitionAI/kition-sheet) · [Slide](https://github.com/KitionAI/kition-slide) · [PDF](https://github.com/KitionAI/kition-pdf) · [HTML](https://github.com/KitionAI/kition-html) (Preview) |
| Design | [Photo](https://github.com/KitionAI/kition-photo) · [Vector](https://github.com/KitionAI/kition-vector) · [Layout](https://github.com/KitionAI/kition-layout) · [Design](https://github.com/KitionAI/kition-design) (Preview) |
| Media | [Film](https://github.com/KitionAI/kition-film) · [Motion](https://github.com/KitionAI/kition-motion) |
| Engineering | [CAD](https://github.com/KitionAI/kition-cad) · [Scene](https://github.com/KitionAI/kition-scene) (Preview) |

## License

Apache-2.0 ([LICENSE](https://github.com/KitionAI/kition-sdk/blob/main/LICENSE)).
<!-- kition-family:end -->

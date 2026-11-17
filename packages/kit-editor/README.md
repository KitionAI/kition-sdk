# @kition/kit-editor

The SDK for a kit's editor: the web app a kit ships (`ui.entry`), which a host shows in an iframe
over [the Kit UI protocol](../../docs/platform/reference/ui-protocol.md). It holds the kit's side
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

`useEngineTools` draws the overlays an engine tool answers with (marquee, path, line, anchor,
handle, label, measure, highlight, swatch) over the canvas, in Kition's style by default. A kit
that needs its own look passes either or both of these options (keep them stable: module
constants or memoized values, since a new object redraws):

- `overlayStyle` (`OverlayStylePatch`): changes to `DEFAULT_OVERLAY_STYLE` per overlay kind:
  the accent, surface and ink colours, the font, the marquee's fill, opacity, stroke, width,
  dash and whether the stroke lies inside, line and path widths and dashes, anchors' shape
  (`square` with a corner radius, or `circle`), default size, fill and ring width, handles'
  radius, fill and ring, labels' font and offset, the measurement pill's fill, text colour,
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

`KitDocumentCanvas` draws a kit's `decorateUnder` under the overlays and its `decorate` over
them, so canvas chrome can sit on either side (grids and frame labels under the selection, a
size pill and rulers over it). When the view zooms, the active engine tool is asked for its
state again, so overlays the engine sizes in screen pixels follow the zoom.

## Rules for kits

- Draw every colour, radius, and shadow from the theme tokens (`var(--kit-*)`), never literal
  values, so the host's theme and skins reach your editor.
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

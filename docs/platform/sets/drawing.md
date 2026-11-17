# `KitDrawing 1.0`: drawing objects

For integrators, agent authors, and kit authors whose documents hold drawing
objects: shapes and text boxes on a slide, a sheet, or a page. This set fixes
how such an object is described, which commands insert and edit it, and what
every kit guarantees about undo, collaboration, and saving, so an agent that
can edit a shape in one kit can edit it in all of them.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

| | |
| --- | --- |
| Status | Draft in edition 2026.11; not yet implemented by any kit |
| Builds on | [`KitModel 1.0`](model.md) (transactions, identity, undo), [`KitPointer 1.0`](pointer.md) (gestures and selection), [`KitAgent 1.4`](agent.md) (commands and their schemas) |
| Kit side | DR1 to DR14; DR15 to DR17 for charts (1.1); DR18 to DR20 for ink (1.2); DR26 to DR28 for text warp (1.3); DR21 to DR25 for arrange, groups, gradients, effects and connectors (1.4) |
| Host side | None: drawing objects are the kit's own |

Minor versions add members for charts (1.1), ink (1.2), text warp for
WordArt (1.3), and arrange, groups, gradients, effects and connectors (1.4).
A kit MAY offer a feature through its own commands until it implements the
version that standardizes it.

## 1. Principles

- **DR-P1 One object, many placements.** A rectangle is described the same
  way in every kit. Where it sits differs: on a slide, floating on or inline
  in a page, or anchored to cells. The description separates the two.
- **DR-P2 The person and the agent use one path.** A pointer gesture and the
  equivalent command make the same change to the document.
- **DR-P3 Editable means editable after saving.** An edit that does not
  survive saving and reopening as editable data is not an edit.

## 2. Describing an object

- **DR1** `drawing.describe` (section 3) MUST return, for each object, a
  `DrawingObject`:

```json
{
  "id": "s-12",
  "kind": "shape",
  "frame": { "x": 72, "y": 144, "w": 216, "h": 108, "rot": 0, "flipH": false, "flipV": false },
  "placement": { "kind": "slide" },
  "geometry": { "preset": "ellipse", "adjust": {} },
  "fill": { "color": { "rgb": "#5645D4" } },
  "stroke": { "color": { "theme": "accent1", "mods": [["lumMod", 75000]] }, "width": 1 },
  "text": {
    "paragraphs": [{ "align": "center", "runs": [{ "text": "Q3", "size": 18, "bold": true }] }],
    "anchor": "middle",
    "insets": [7.2, 3.6, 7.2, 3.6]
  }
}
```

- **DR2** `id` is the kit's object id as a string. It MUST be the same on
  every replica of the document and stay the same for the object's lifetime
  in it, including across saving and reopening the document with its replica.
  When a file is opened without its replica, a kit whose format keeps object
  ids (DrawingML's `cNvPr`/`docPr` `id`) SHOULD derive the ids from them. A
  copy MUST get a new id (DR12).
- **DR3** `kind` is `shape` or `textBox` in 1.0 (`group` since 1.4, DR22). A kit MAY describe other
  kinds of object it holds (`picture`, `chart`, `group`) with the members it
  supports; an agent ignores kinds it does not know.
- **DR4** `frame` is the object's unrotated box in points, in the
  coordinate space of the slide, the page, or the sheet the object is on, with
  `rot` in degrees clockwise about the box's centre. The frame is what the
  person sees; a kit computes it from its placement when it is not stored.
- **DR5** `placement` says how the frame is kept. `kind` is one of `slide`,
  `float` (a page object positioned relative to the page, a margin, a column,
  or a paragraph), `inline` (a page object in the text flow), or `cell` (an
  object anchored to sheet cells). A kit MAY add kit-specific members, such
  as Word's wrap or Sheet's move-and-size mode; an agent passes them back
  unchanged.
- **DR6** `geometry` is either `{ "preset", "adjust" }`, a DrawingML preset
  shape name (ECMA-376 Part 1, 20.1.10.56) with adjust values by guide name,
  or `{ "paths" }` for custom geometry. A kit MUST accept `rect`,
  `roundRect`, and `ellipse` in 1.0 and SHOULD accept every preset it draws.
- **DR7** A color is `{ "rgb": "#RRGGBB" }` or `{ "theme": slot }`, where
  `slot` is a DrawingML scheme color name (`accent1` to `accent6`, `tx1`,
  `bg1`, `tx2`, `bg2`, `hlink`, `folHlink`), with optional `alpha` (0 to 1)
  and `mods` (DrawingML color transforms with their values). `fill` is
  `{ "color" }` or `{ "none": true }`; `stroke` is `{ "color", "width",
  "dash"? }` or `{ "none": true }`. A property inherited from a theme or a
  style and not set on the object is described with `"inherited": true`
  beside its resolved value.
- **DR8** `text` lists paragraphs of runs with their properties (`font`,
  `size` in points, `bold`, `italic`, `underline`, `color`) and the body's
  `anchor` (`top`, `middle`, `bottom`), `insets` (left, top, right, bottom,
  points), `wrap`, and `autofit` (`none`, `shrink`, `resize`).
- **DR29** The `text` that `drawing.insert` and `drawing.text` take is a
  string (a line break starts a paragraph) or the text object
  `drawing.describe` gives (DR8), so an agent can pass back what it read.
  `body` (`{ anchor, insets, wrap, autofit }`) lays the text out;
  `drawing.text` with only `body` or only `warp` keeps the paragraphs.

## 3. Commands

Every command below MUST be in the kit's command list with a parameter
schema (`KitAgent 1.4`). Commands that change the document are one
transaction each (M1), whatever number of objects they touch; a failure
changes nothing.

| Command | Parameters | Result |
| --- | --- | --- |
| `drawing.describe` | `{ ids? }`: the objects, or the person's selection, or every drawing object on the current slide, page, or sheet | `{ objects: DrawingObject[] }` |
| `drawing.insert` | `{ kind, geometry?, frame?, placement?, fill?, stroke?, text? }` | `{ id }` |
| `drawing.delete` | `{ ids }` | `{ deleted: number }` |
| `drawing.transform` | `{ ids, frame? \| dx?, dy?, rotateBy?, flipH?, flipV? }` | `{ frames: Frame[] }` |
| `drawing.format` | `{ ids, fill?, stroke?, geometry? }` | `{}` |
| `drawing.text` | `{ id, text? \| paragraphs?, body?, warp? }` | `{}` |
| `drawing.arrange` (1.4) | `{ ids, order }`: `front`, `back`, `forward`, or `backward` | `{}` |
| `drawing.group` (1.4) | `{ ids }`: two or more objects on one slide, page, or sheet | `{ id }` |
| `drawing.ungroup` (1.4) | `{ ids }`: groups | `{ ids }`: their members |
| `drawing.connect` (1.4) | `{ from, to, fromSite?, toSite?, geometry? }`: a connector preset (`straightConnector1`, `bentConnector3`, `curvedConnector3`) | `{ id }` |
| `drawing.reconnect` (1.4) | `{ id, end: start \| end, to?, site?, point? }`: one end of connector `id` glued to site `site` of `to`, or left free (at `point` when given) | `{}` |

- **DR9** A command MUST NOT depend on the person's selection when it is
  given `ids` (PT-P4). `drawing.describe` without `ids` describes the
  selection so an agent can read what the person points at.
- **DR10** Describing several objects (a selection) MUST report a property
  whose values differ as `{ "mixed": true }`, never one object's value.
- **DR11** A property the kit cannot set on the object (a preset it does not
  draw, a placement member the format cannot store) MUST fail the command
  with error code `unsupported` and the property's name in `data.property`.
  A kit MUST NOT report success without changing the object. Other errors use
  `not-found` (an unknown id), `invalid` (a value outside its range), and
  `read-only` (the document is read-only for this person, UI-K7).

- **DR21** (1.4) `drawing.arrange` MUST move the objects in the stack of the
  slide, page, or sheet they are on as Office's Arrange commands do: `front`
  above every other object, `back` below every other, `forward` above the next
  object over them, `backward` below the next object under them. The moved
  objects keep their order among themselves, the new order MUST be what
  `drawing.describe` lists (bottom to top) and what saving writes, and an
  object the kit cannot place in a stack (Word's inline pictures) fails with
  `unsupported`. kition-sdk's `kition_office_core::arrange` computes the order.

- **DR23** (1.4) A `fill` MAY be `{ "gradient": { "stops", "angle", "path"? } }`:
  two to ten stops `{ pos, color }` in order (`pos` 0 to 1 along the
  gradient), a linear direction `angle` in degrees clockwise from left to
  right, or a `path` (`circle`, `rect`, `shape`) from the centre. A kit that
  draws gradients MUST describe them so and take them in `drawing.format`; one
  that does not fails with `unsupported` (`fill`). A colour transform a kit
  cannot resolve in a stop fails the same way.

- **DR24** (1.4) An object's `effects` are `{ "shadow"?, "glow"? }`: an outer
  shadow `{ color, blur, distance, angle }` (points; `angle` in degrees
  clockwise from right; the colour's `alpha` its opacity) and a glow
  `{ color, size }`. `drawing.format` takes `effects` with either member, a
  value setting it and `null` removing it; a member left out stays. A kit that
  draws neither fails with `unsupported` (`effects`).

- **DR25** (1.4) A connector is a line object whose `connection` names the
  objects its `start` and `end` are glued to, each `{ id, site }` (an index
  into the object's connection sites, its geometry's `cxn` points). When a
  glued object moves, resizes, or turns, the kit MUST move that end of the
  connector to the site in the same transaction; deleting the object leaves
  the end where it was, free. `drawing.connect` makes one between two objects,
  gluing it to the sites named or else to the nearest pair. `drawing.reconnect`
  glues one end of a connector to another site, or frees it; dragging an end
  with the pointer SHOULD snap to a site in reach and run it on release, one
  undo step. kition-sdk's `kition_office_core::connect` computes sites and frames
  (`EndDrag` for the drag).

- **DR22** (1.4) `drawing.group` MUST make one object of kind `group` whose
  `members` are the given objects, bottom to top in the stack they were in,
  placed where the topmost of them was; its frame bounds them. The members
  keep their ids, look and place on the page, and `drawing.describe` of a
  member still describes it. Moving, resizing, or turning the group carries
  its members; deleting it deletes them. `drawing.ungroup` MUST put a group's
  members back in the group's place in the stack, where they appear, and
  answer their ids. An object that cannot be grouped (an inline object in
  Word, a chart in a kit whose groups hold only shapes) fails with
  `unsupported`; each is one transaction.

Kits keep their existing command names as aliases of these commands; an
alias changes the document exactly as the command does.

## 4. Gestures and undo

- **DR12** Duplicating or pasting an object MUST give it a new id and remap
  the references it holds to copied objects (a connector's ends, a group's
  members). Pasting into another kit MUST keep every property the target can
  hold and report the others as `unsupported` properties in the paste's
  result.
- **DR13** A pointer gesture that moves, resizes, rotates, or adjusts objects
  MUST show its preview without changing the document and MUST commit one
  transaction when the pointer is released, so one gesture is one undo step
  (M12). Escape and pointer cancellation MUST discard the preview and leave
  the document unchanged. Selecting MUST NOT change the document.

## 5. Collaboration and saving

- **DR14** A kit MUST keep a drawing object's frame, its text, and its other
  properties so that two people's concurrent edits to different ones of
  these all survive a merge (M15): the frame and each text paragraph are
  their own KDM fields, as a text body is in `KitModel 1.0`. Storing a whole
  slide, page, or sheet of objects in one field is not allowed.

The following outcomes are required of concurrent edits to one object:

| Person A | Person B | Merged result |
| --- | --- | --- |
| Types in the text | Changes the fill | Both |
| Moves the object | Changes the outline | Both |
| Moves the object | Moves the object | One frame wins, the same on every replica |
| Deletes the object | Edits it | The object is deleted |
| Undoes their last change | Changed another property meanwhile | A's change is reverted; B's remains |

Saving MUST write every property set through this set's commands in the
kit's file format, and reopening MUST describe the same values (within the
format's precision: EMU for DrawingML lengths, 1/60,000 degree for angles).
Content of the object the kit does not model MUST be kept when the object
survives an edit, and an edited property MUST win over kept content that
covers it (M24).

## 6. Charts (1.1, draft)

`KitDrawing 1.1` adds charts. A chart is a drawing object of `kind`
`chart`: its frame, placement, and DR2 to DR5 apply unchanged, and
`drawing.describe` adds a `chart` member, a `ChartSpec`:

```json
{
  "kind": "column",
  "title": "Sales",
  "categories": ["Q1", "Q2", "Q3"],
  "series": [{ "name": "East", "values": [10, null, 30], "color": { "theme": "accent1" } }],
  "legend": "bottom",
  "dataLabels": false,
  "gridlines": true,
  "xTitle": "Quarter",
  "yTitle": "USD"
}
```

- **DR15** `kind` is one of `column`, `stackedColumn`, `percentColumn`,
  `bar`, `stackedBar`, `percentBar`, `line`, `lineMarkers`, `stackedLine`,
  `area`, `stackedArea`, `pie`, `doughnut`, `scatter`, and `radar`. A chart
  of another type (stock, surface, bubble, 3-D) is described as
  `{ "other": element }` with its DrawingML element name; its data and titles
  edit, its type does not change. A series of a combination chart has its own
  `kind`. A series has one value per category, `null` for a gap; a scatter
  chart's categories are its X values.
- **DR16** `drawing.insert` with `kind: "chart"` takes `chart`, a
  `ChartSpec` (members left out take a sample chart's values).
  `drawing.chart` takes `{ id, kind?, title?, legend?, dataLabels?,
  gridlines?, xTitle?, yTitle?, categories?, series? }` and changes those
  members in one transaction; `null` removes a title or the legend. A kit
  whose chart data are its own cells (a spreadsheet) MUST refuse
  `categories` and `series` with `unsupported` and edit the cells instead.
- **DR16a** A chart also describes its axes' scale and labels, `xAxis` and
  `yAxis` (`{ min?, max?, major?, numberFormat?, hidden? }`, members left out
  automatic), where its data labels sit (`dataLabelPosition`: `bestFit`, `b`,
  `ctr`, `inBase`, `inEnd`, `l`, `outEnd`, `r`, `t`), and each series' look
  (`lineWidth` in points, `marker`, `smooth`). `drawing.chart` takes `xAxis`
  and `yAxis` (a `null` member returns it to automatic), `dataLabelPosition`,
  and `seriesFormat: [{ index, color?, lineWidth?, marker?, smooth? }]`, which
  changes series' looks without their data, so a kit whose data are cells
  takes it.
- **DR16b** A bar, column, line, area or scatter series MAY have a
  `trendline` (`{ kind, order?, period?, forward?, backward? }`, `kind` one of
  `linear`, `exp`, `log`, `poly`, `power`, `movingAvg`) and `errorBars`
  (`{ kind, value? }`, `kind` one of `fixedVal`, `percentage`, `stdDev`,
  `stdErr`, both ways on its values). `seriesFormat` sets them (a kind's name
  alone, or the whole description) and `null` removes them; a pie, doughnut or
  radar series refuses them as `unsupported`. kition-sdk's
  `kition_office_core::chart::trend` fits the curves and measures the bars, so
  every kit draws the same ones; standard deviation bars stand around the
  series' mean, as Office draws them.
- **DR16c** A series of a combination has its own `kind` (a column, bar,
  line, area or scatter type) and MAY be `secondary`: plotted against a value
  axis on the right. `seriesFormat` sets both (`kind: null` returns a series to
  the chart's type); a pie, doughnut or radar series has neither. A kit MUST
  keep series in their order (`c:order`), whatever chart-type elements group
  them, and SHOULD draw a secondary value axis with its own scale.
- **DR17** Saving MUST write a chart as a DrawingML chart part
  (`c:chartSpace`, ECMA-376 Part 1, 21.2). Editing a chart MUST keep what
  the description leaves out: formatting, axes, number formats, cell
  references, and extensions. The shared codec in `kition-office-core`
  (`chart::codec::patch`) changes a part in place to this end. A chart whose
  data were changed, or that was made by the kit, SHOULD be saved with an
  embedded workbook of its data (`chart::workbook`, bound by
  `chart::codec::bind_workbook`), so its data stay editable as cells.

## 7. Ink (1.2, draft)

`KitDrawing 1.2` adds ink. An ink object is a drawing object of `kind`
`ink` with an `ink` member listing its strokes; a kit MAY keep each stroke
as its own object or several in one (a slide's ink layer).

```json
{ "tool": "pen", "color": { "rgb": "#C00000" }, "width": 1.5, "points": [[72, 144, 0.5], [80, 150, 0.6]] }
```

- **DR18** A stroke has a `tool` (`pen`, `pencil`, or `highlighter`), a
  `color`, a `width` in points (0.25 to 72), and `points` as `[x, y,
  pressure]` in the coordinates of its slide, page, or sheet, pressure 0 to 1.
  A highlighter is translucent and drawn behind text.
- **DR19** `drawing.ink` takes `{ strokes: [stroke], placement? }` and adds
  them in one transaction; a member left out takes the kit's current pen.
  `drawing.erase` takes `{ path: [[x, y]], radius? }` (or one point, `x` and
  `y`) and deletes every stroke the swept path touches, in one transaction.
  Both answer what they changed.
- **DR20** Drawing with the pointer previews the stroke and adds it on
  release as one undo step; erasing removes what the drag touched on release
  as one undo step. Escape discards either.

## 8. Text warp (1.3, draft)

`KitDrawing 1.3` adds WordArt: a shape's or a text box's text bent by a
DrawingML preset text warp (`a:bodyPr/a:prstTxWarp`, ECMA-376 Part 1,
20.1.10.76), its fill, outline and effects the runs' own.

- **DR26** `text.warp` is the preset's name (`textArchUp`, `textWave1`,
  `textInflate`, ...) with its adjust values by guide name, as
  `{ "preset", "adjust" }`; `textPlain` or no `warp` is unbent text. A kit
  MUST keep a warp it reads through saving and reopening, and SHOULD draw
  every preset in `kition_office_core::warp::WARPS`, bending the text's glyph
  outlines with `warp::warp_path` (text laid out flat in its box, then
  mapped), so a warp looks the same in every kit.
- **DR27** `drawing.text` and `drawing.insert` take `warp`; `{ "warp":
  null }` removes it. A preset the kit cannot draw fails with `unsupported`
  (DR11).
- **DR28** Runs MAY carry `outline` (a stroke, DR7) and `fill` (a fill,
  including a gradient, DR23) of their glyphs, and the body MAY carry
  effects (DR24) drawn under the text. A kit that does not draw them MUST
  keep them through saving.

/**
 * Icons for the engines' tools and commands. The kit engines name their tool icons `tool-<kind>`
 * (`EngineToolInfo.icon`); each kind maps to the closest Tessera icon, and an unknown one to a
 * generic shape. A command has no icon of its own: one is chosen from the words in its id and
 * title, with a generic icon when none matches, so a ribbon built from commands is never a wall of
 * bare labels.
 */
import { ActivityIcon as Activity, ArrowUpDownIcon as ArrowUpDown, BlendIcon as Blend, BookmarkIcon as Bookmark, BoxIcon as Box, BrushIcon as Brush, CalendarIcon as Calendar, ChartColumnIcon as ChartColumn, CircleIcon as Circle, ClipboardPasteIcon as ClipboardPaste, Columns2Icon as Columns2, CopyIcon as Copy, CopyPlusIcon as CopyPlus, CornerDownRightIcon as CornerDownRight, CropIcon as Crop, DiameterIcon as Diameter, EraserIcon as Eraser, EyeIcon as Eye, FileIcon as File, FilePlusIcon as FilePlus, FrameIcon as Frame, FunnelIcon as Funnel, Grid3x3Icon as Grid3x3, GroupIcon as Group, HandIcon as Hand, HashIcon as Hash, ImageIcon as Image, ItalicIcon as Italic, LanguagesIcon as Languages, LassoIcon as Lasso, LayersIcon as Layers, LayoutTemplateIcon as LayoutTemplate, LinkIcon as Link, LockIcon as Lock, MessageSquareIcon as MessageSquare, MinusIcon as Minus, MoveIcon as Move, Move3dIcon as Move3d, MoveHorizontalIcon as MoveHorizontal, MousePointerIcon as MousePointer, MousePointer2Icon as MousePointer2, OmegaIcon as Omega, PackageIcon as Package, PaintBucketIcon as PaintBucket, PaletteIcon as Palette, PanelBottomIcon as PanelBottom, PanelTopIcon as PanelTop, PencilIcon as Pencil, PenToolIcon as PenTool, PipetteIcon as Pipette, PrinterIcon as Printer, QrCodeIcon as QrCode, RadiusIcon as Radius, RainbowIcon as Rainbow, RefreshCwIcon as RefreshCw, ReplaceIcon as Replace, RotateCwIcon as RotateCw, Rows3Icon as Rows3, RulerIcon as Ruler, RulerDimensionLineIcon as RulerDimensionLine, ScalingIcon as Scaling, ScissorsIcon as Scissors, SearchIcon as Search, SettingsIcon as Settings, ShapesIcon as Shapes, ShellIcon as Shell, SigmaIcon as Sigma, SignatureIcon as Signature, SplineIcon as Spline, SpellCheckIcon as SpellCheck, SquareIcon as Square, SquareCheckBigIcon as SquareCheckBig, SquareDashedMousePointerIcon as SquareDashedMousePointer, SquareFunctionIcon as SquareFunction, StickyNoteIcon as StickyNote, StickerIcon as Sticker, TableIcon as Table, TablePropertiesIcon as TableProperties, TagIcon as Tag, TrashIcon as Trash, TypeIcon as Type, UngroupIcon as Ungroup, VectorPolygonIcon as VectorPolygon, VectorSquareIcon as VectorSquare, VideoIcon as Video, MusicIcon as Music, WandSparklesIcon as Wand2, WavesHorizontalIcon as Waves, WaypointsIcon as Waypoints, ZoomInIcon as ZoomIn, type IconComponent } from '@kition/tessera-icons/react'
import { AlignCenterHorizontalIcon, ArrowDownIcon, ArrowDownToLineIcon, ArrowLeftIcon, ArrowLeftToLineIcon, ArrowRightIcon, ArrowRightLeftIcon, ArrowRightToLineIcon, ArrowUpIcon, ArrowUpDownIcon, BlendIcon, BoldIcon, BookOpenIcon, BookmarkIcon, BoxIcon, BringToFrontIcon, BrushIcon, CameraIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, ClapperboardIcon, ClipExtractIcon, ClipLiftIcon, ClipboardIcon, ClipboardPasteIcon, ClockIcon, CodeIcon, CommandGenericIcon, ComponentIcon, ContrastIcon, CopyIcon, CropIcon, CrosshairIcon, DatabaseIcon, DiamondIcon, DiscIcon, EyeIcon, EyeOffIcon, FastForwardIcon, FileIcon, FileInputIcon, FileOutputIcon, FilmIcon, FlipHorizontalIcon, FolderIcon, FolderOpenIcon, FrameIcon, FunnelIcon, GaugeIcon, Grid2x2Icon, Grid3x3Icon, GroupIcon, HandIcon, HashIcon, HeadingIcon, HighlighterIcon, ItalicIcon, LayersIcon, LifeBuoyIcon, LightbulbIcon, LinkIcon, ListIcon, ListOrderedIcon, ListTreeIcon, LockIcon, LockOpenIcon, MagnetIcon, MergeIcon, MessageSquareIcon, MousePointer2Icon, MousePointerClickIcon, MoveIcon, MoveUpRightIcon, NetworkIcon, PaintBucketIcon, PaintbrushIcon, PaletteIcon, PauseIcon, PenLineIcon, PenToolIcon, PencilIcon, PencilLineIcon, PilcrowIcon, PlayIcon, PlusIcon, PrinterIcon, Redo2Icon, RefreshCwIcon, RepeatIcon, ReplaceIcon, RotateCcwIcon, RotateCwIcon, Rows3Icon, RulerIcon, SaveIcon, ScalingIcon, ScissorsIcon, SearchIcon, SettingsIcon, ShapesIcon, ShieldCheckIcon, SlidersHorizontalIcon, SplineIcon, SplitIcon, SquareIcon, SquareDashedIcon, SquareFunctionIcon, StepForwardIcon, StrikethroughIcon, SubscriptIcon, SuperscriptIcon, SwatchBookIcon, TableIcon, TextCursorIcon, TextCursorInputIcon, ToggleLeftIcon, TrashIcon, TypeIcon, UnderlineIcon, Undo2Icon, UngroupIcon, UnlinkIcon, VideoIcon, Volume2Icon, WandSparklesIcon, WaypointsIcon, WholeWordIcon, XIcon, ZapIcon, ZoomInIcon } from '@kition/tessera-icons/react'

const TOOL_ICONS: Array<[RegExp, IconComponent]> = [
  [/^tool-selection$/, MousePointer2],
  [/^tool-page$/, File],
  [/^tool-gap$/, Columns2],
  [/^tool-(collector|placer)/, Package],
  [/^tool-(rect-frame|ellipse-frame|polygon-frame)/, Frame],
  [/^tool-note/, StickyNote],
  [/^tool-color-theme/, Palette],
  [/^tool-gradient-feather/, Blend],
  [/^tool-(direct|group-select|live-select|perspective-select)/, MousePointer],
  [/^tool-magic-wand/, Wand2],
  [/^tool-lasso/, Lasso],
  [/^tool-(pen|anchor)/, PenTool],
  [/^tool-curvature/, Spline],
  [/^tool-(type|touch-type)/, Type],
  [/^tool-line$/, Minus],
  [/^tool-arc/, Rainbow],
  [/^tool-spiral/, Shell],
  [/^tool-(rect-grid|polar-grid|perspective)/, Grid3x3],
  [/^tool-(rect|rounded-rect|polygon|star|flare)/, Square],
  [/^tool-ellipse/, Circle],
  [/^tool-(brush|blob-brush)/, Brush],
  [/^tool-(pencil|smooth|shaper|join|path-eraser)/, Pencil],
  [/^tool-eraser?$/, Eraser],
  [/^tool-(scissors|knife|mirror-cut|line-cut|rect-cut)/, Scissors],
  [/^tool-(rotate|reflect)/, RotateCw],
  [/^tool-scale/, Scaling],
  [/^tool-shear/, Italic],
  [/^tool-reshape/, VectorPolygon],
  [/^tool-free-transform/, VectorSquare],
  [/^tool-puppet/, Waypoints],
  [/^tool-(width|warp|twirl|pucker|bloat|scallop|crystallize|wrinkle)/, Waves],
  [/^tool-shape-builder/, Shapes],
  [/^tool-bucket/, PaintBucket],
  [/^tool-mesh/, Move3d],
  [/^tool-gradient/, Blend],
  [/^tool-eyedropper/, Pipette],
  [/^tool-measure/, Ruler],
  [/^tool-blend/, Blend],
  [/^tool-artboard/, Frame],
  [/^tool-slice/, Crop],
  [/^tool-move$/, Move],
  [/^tool-copy$/, Copy],
  [/^tool-offset$/, CopyPlus],
  [/^tool-extend$/, MoveHorizontal],
  [/^tool-fillet$/, CornerDownRight],
  [/^tool-hand/, Hand],
  [/^tool-zoom/, ZoomIn],
]

/**
 * Tools that share an icon name but are different tools, told apart by their id (CAD's dimension
 * tools are all `tool-measure`).
 */
const TOOL_ID_ICONS: Array<[RegExp, IconComponent]> = [
  [/^dim-?linear$/, RulerDimensionLine],
  [/^dim-?aligned$/, Ruler],
  [/^dim-?radius$/, Radius],
  [/^dim-?diameter$/, Diameter],
]

/**
 * The icon for an engine tool's icon name (`tool-line`). With the tool's `id`, tools that share an
 * icon name (CAD's `dimlinear`, `dimaligned`, and `dimradius`) get their own icons.
 */
export function toolIcon(name: string, id?: string): IconComponent {
  const byId = id ? TOOL_ID_ICONS.find(([pattern]) => pattern.test(id))?.[1] : undefined
  return byId ?? TOOL_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? Shapes
}

/**
 * Words in a command's id or title, most specific first ("pivot table" before "table",
 * "sparkline" before "line"), and their icons.
 */
const COMMAND_ICONS: Array<[RegExp, IconComponent]> = [
  [/pivot/, TableProperties],
  [/sparkline/, Activity],
  [/chart|graph/, ChartColumn],
  [/table/, Table],
  [/picture|image|photo/, Image],
  [/\bicons?\b|sticker/, Sticker],
  [/shape|drawing/, Shapes],
  [/header/, PanelTop],
  [/footer/, PanelBottom],
  [/hyperlink|\blink/, Link],
  [/bookmark/, Bookmark],
  [/equation|formula|function/, SquareFunction],
  [/sum|sigma/, Sigma],
  [/symbol|special char/, Omega],
  [/check ?box|checkbox/, SquareCheckBig],
  [/comment|note/, MessageSquare],
  [/text|word ?art|caption/, Type],
  [/signature/, Signature],
  [/date|time/, Calendar],
  [/number|numbering/, Hash],
  [/video|movie|media/, Video],
  [/audio|sound|music/, Music],
  [/qr|barcode/, QrCode],
  [/block|object|3d|model/, Box],
  [/layer/, Layers],
  [/layout|template|theme/, LayoutTemplate],
  [/page|section|break|sheet|slide/, FilePlus],
  [/rows?\b/, Rows3],
  [/columns?\b/, Columns2],
  [/filter/, Funnel],
  [/sort/, ArrowUpDown],
  [/ungroup/, Ungroup],
  [/group/, Group],
  [/find|search/, Search],
  [/replace/, Replace],
  [/spell|proof/, SpellCheck],
  [/translat|language/, Languages],
  [/print/, Printer],
  [/paste/, ClipboardPaste],
  [/copy|duplicate/, Copy],
  [/cut\b/, Scissors],
  [/delete|remove|clear/, Trash],
  [/refresh|recalc/, RefreshCw],
  [/protect|lock/, Lock],
  [/name|label|tag/, Tag],
  [/show|hide|view/, Eye],
  [/option|setting|propert/, Settings],
  [/\bfile\b|document/, File],
]

/**
 * A command's action, from its verb (the first word of the id's last segment, `layer.mergeDown` →
 * "merge", or of its title): checked first, so "Undo" and "Export" are never read by their object.
 */
const VERB_ICONS: Array<[RegExp, IconComponent]> = [
  [/^(?:bold)$/, BoldIcon],
  [/^(?:italic)$/, ItalicIcon],
  [/^(?:underline)$/, UnderlineIcon],
  [/^(?:strike|strikethrough)$/, StrikethroughIcon],
  [/^(?:subscript)$/, SubscriptIcon],
  [/^(?:superscript)$/, SuperscriptIcon],
  [/^(?:deselect|none)$/, SquareDashedIcon],
  [/^(?:inverse|invert)$/, ContrastIcon],
  [/^(?:pan)$/, HandIcon],
  [/^(?:measure)$/, RulerIcon],
  [/^(?:collapse)$/, ChevronsDownUpIcon],
  [/^(?:expand)$/, ChevronsUpDownIcon],
  [/^(?:bind|attach)$/, LinkIcon],
  [/^(?:audit|check|verify|validate)$/, ShieldCheckIcon],
  [/^(?:recover|repair)$/, LifeBuoyIcon],
  [/^(?:purge)$/, TrashIcon],
  [/^(?:sketch)$/, PencilIcon],
  [/^(?:read)$/, BookOpenIcon],
  [/^(?:left)$/, ArrowLeftIcon],
  [/^(?:right)$/, ArrowRightIcon],
  [/^(?:up)$/, ArrowUpIcon],
  [/^(?:down)$/, ArrowDownIcon],
  [/^(?:home|start)$/, ArrowLeftToLineIcon],
  [/^(?:end)$/, ArrowRightToLineIcon],
  [/^(?:lift)$/, ClipLiftIcon],
  [/^(?:extract)$/, ClipExtractIcon],
  [/^(?:shuttle)$/, FastForwardIcon],
  [/^(?:tick|advance)$/, StepForwardIcon],
  [/^(?:batch)$/, LayersIcon],
  [/^(?:redact)$/, EyeOffIcon],
  [/^(?:reselect)$/, MousePointer2Icon],
  [/^(?:click|tap|press)$/, MousePointerClickIcon],
  [/^(?:undo)$/, Undo2Icon],
  [/^(?:redo)$/, Redo2Icon],
  [/^(?:save)$/, SaveIcon],
  [/^(?:export|publish)$/, FileOutputIcon],
  [/^(?:import|place)$/, FileInputIcon],
  [/^(?:open|browse)$/, FolderOpenIcon],
  [/^(?:close)$/, XIcon],
  [/^(?:print)$/, PrinterIcon],
  [/^(?:delete|remove|clear|erase)$/, TrashIcon],
  [/^(?:duplicate|copy|clone)$/, CopyIcon],
  [/^(?:cut)$/, ScissorsIcon],
  [/^(?:paste)$/, ClipboardPasteIcon],
  [/^(?:rename)$/, PencilLineIcon],
  [/^(?:find|search|locate)$/, SearchIcon],
  [/^(?:replace)$/, ReplaceIcon],
  [/^(?:align|distribute)$/, AlignCenterHorizontalIcon],
  [/^(?:rotate)$/, RotateCwIcon],
  [/^(?:flip|mirror|reflect)$/, FlipHorizontalIcon],
  [/^(?:move|nudge|offset|shift)$/, MoveIcon],
  [/^(?:scale|resize|transform|warp|distort)$/, ScalingIcon],
  [/^(?:merge|join|combine|flatten)$/, MergeIcon],
  [/^(?:split|divide|separate)$/, SplitIcon],
  [/^(?:group)$/, GroupIcon],
  [/^(?:ungroup)$/, UngroupIcon],
  [/^(?:lock)$/, LockIcon],
  [/^(?:unlock)$/, LockOpenIcon],
  [/^(?:hide)$/, EyeOffIcon],
  [/^(?:show|reveal|view)$/, EyeIcon],
  [/^(?:zoom)$/, ZoomInIcon],
  [/^(?:play|preview)$/, PlayIcon],
  [/^(?:pause)$/, PauseIcon],
  [/^(?:stop)$/, SquareIcon],
  [/^(?:record|capture)$/, DiscIcon],
  [/^(?:render|bake|encode)$/, ClapperboardIcon],
  [/^(?:reset|revert|restore|default)$/, RotateCcwIcon],
  [/^(?:apply|commit|confirm|accept)$/, CheckIcon],
  [/^(?:cancel|reject|discard)$/, XIcon],
  [/^(?:toggle|enable|disable|switch)$/, ToggleLeftIcon],
  [/^(?:next|forward)$/, ChevronRightIcon],
  [/^(?:previous|prev|back)$/, ChevronLeftIcon],
  [/^(?:step)$/, StepForwardIcon],
  [/^(?:go|jump|seek)$/, ArrowRightIcon],
  [/^(?:trim|crop)$/, CropIcon],
  [/^(?:insert|add|new|create|make)$/, PlusIcon],
  [/^(?:select|pick)$/, MousePointer2Icon],
  [/^(?:list|inspect|info|get|query|state)$/, ListIcon],
  [/^(?:convert|change)$/, RepeatIcon],
  [/^(?:sort)$/, ArrowUpDownIcon],
  [/^(?:filter)$/, FunnelIcon],
  [/^(?:link)$/, LinkIcon],
  [/^(?:unlink)$/, UnlinkIcon],
  [/^(?:increase|grow|raise)$/, ArrowUpIcon],
  [/^(?:decrease|shrink|lower)$/, ArrowDownIcon],
  [/^(?:refresh|reload|update|sync)$/, RefreshCwIcon],
  [/^(?:define|edit|modify|configure)$/, PencilIcon],
  [/^(?:arrange|order|bring|send)$/, BringToFrontIcon],
  [/^(?:snap)$/, MagnetIcon],
  [/^(?:smooth|simplify)$/, SplineIcon],
  [/^(?:stroke|outline)$/, PenLineIcon],
  [/^(?:fill)$/, PaintBucketIcon],
  [/^(?:mask)$/, SquareDashedIcon],
]

/** What a command acts on, anywhere in its words: checked when its verb has no icon. */
const OBJECT_ICONS: Array<[RegExp, IconComponent]> = [
  [/\b(?:heading|title)\b/, HeadingIcon],
  [/\b(?:level|outline|tree)\b/, ListTreeIcon],
  [/\b(?:code)\b/, CodeIcon],
  [/\b(?:direction)\b/, ArrowRightLeftIcon],
  [/\b(?:waypoints?|bends?)\b/, WaypointsIcon],
  [/\b(?:stats|statistics|performance)\b/, GaugeIcon],
  [/\b(?:mixer)\b/, SlidersHorizontalIcon],
  [/\b(?:clipboard)\b/, ClipboardIcon],
  [/\b(?:cache)\b/, DatabaseIcon],
  [/\b(?:values?)\b/, HashIcon],
  [/\b(?:autofill|series)\b/, ArrowDownToLineIcon],
  [/\b(?:flash)\b/, ZapIcon],
  [/\b(?:painter)\b/, PaintbrushIcon],
  [/\b(?:field|form)\b/, TextCursorInputIcon],
  [/\b(?:tab order)\b/, ListOrderedIcon],
  [/\b(?:smart ?graphics?|diagram)\b/, NetworkIcon],
  [/\b(?:action button|button)\b/, MousePointerClickIcon],
  [/\b(?:pen)\b/, PenToolIcon],
  [/\b(?:pencil)\b/, PencilIcon],
  [/\b(?:highlighter)\b/, HighlighterIcon],
  [/\b(?:word)\b/, WholeWordIcon],
  [/\b(?:caret|cursor)\b/, TextCursorIcon],
  [/\b(?:distance|perimeter|area)\b/, RulerIcon],
  [/\b(?:work area)\b/, ClapperboardIcon],
  [/\b(?:brush|paint)\b/, BrushIcon],
  [/\b(?:gradient)\b/, BlendIcon],
  [/\b(?:transparen|opacity|blend)\b/, BlendIcon],
  [/\b(?:colou?rs?|swatch|palette)\b/, PaletteIcon],
  [/\b(?:font|character|typograph|text|type)\b/, TypeIcon],
  [/\b(?:para(graph)?)\b/, PilcrowIcon],
  [/\b(?:presets?|styles?)\b/, SwatchBookIcon],
  [/\b(?:layers?)\b/, LayersIcon],
  [/\b(?:paths?|anchor|point|bezier|curve)\b/, SplineIcon],
  [/\b(?:camera)\b/, CameraIcon],
  [/\b(?:track)\b/, Rows3Icon],
  [/\b(?:clip|footage|sequence|timeline|multicam)\b/, FilmIcon],
  [/\b(?:markers?|bookmark)\b/, BookmarkIcon],
  [/\b(?:keys?|keyframe)\b/, DiamondIcon],
  [/\b(?:channel)\b/, SlidersHorizontalIcon],
  [/\b(?:perspective|3d)\b/, BoxIcon],
  [/\b(?:grid|guide)\b/, Grid3x3Icon],
  [/\b(?:frame|artboard)\b/, FrameIcon],
  [/\b(?:data|database|source)\b/, DatabaseIcon],
  [/\b(?:queue)\b/, ListOrderedIcon],
  [/\b(?:project)\b/, FolderIcon],
  [/\b(?:comp(osition)?)\b/, LayersIcon],
  [/\b(?:playhead|time|duration)\b/, ClockIcon],
  [/\b(?:audio|sound|volume)\b/, Volume2Icon],
  [/\b(?:video)\b/, VideoIcon],
  [/\b(?:preferences|settings|options)\b/, SettingsIcon],
  [/\b(?:shape|rectangle|ellipse|polygon)\b/, ShapesIcon],
  [/\b(?:light|lamp)\b/, LightbulbIcon],
  [/\b(?:solid)\b/, SquareIcon],
  [/\b(?:null)\b/, CrosshairIcon],
  [/\b(?:adjustment)\b/, SlidersHorizontalIcon],
  [/\b(?:footage|media)\b/, FilmIcon],
  [/\b(?:folder)\b/, FolderIcon],
  [/\b(?:mosaic)\b/, Grid2x2Icon],
  [/\b(?:gradient mesh|mesh)\b/, Grid3x3Icon],
  [/\b(?:line|arrow)\b/, MoveUpRightIcon],
  [/\b(?:comment|note)\b/, MessageSquareIcon],
  [/\b(?:page)\b/, FileIcon],
  [/\b(?:cell|row|column)\b/, TableIcon],
  [/\b(?:formula|function)\b/, SquareFunctionIcon],
  [/\b(?:symbol)\b/, ComponentIcon],
  [/\b(?:effect|filter)\b/, WandSparklesIcon],
  [/\b(?:selection)\b/, MousePointer2Icon],
]

/**
 * The icon of a command nothing matches: a neutral mark that claims no meaning (it used to be the
 * selection tool's icon, which made unknown commands read as Select).
 */
export const COMMAND_FALLBACK_ICON: IconComponent = CommandGenericIcon

/** Verbs that make something: their object names the icon. */
const CREATES = /^(?:insert|add|new|create|make)$/

const KIT_COMMAND_ICONS = new Map<string, IconComponent>()

/**
 * A kit's own icons for its commands, by command id: they win over every rule. A kit registers
 * them once, when its editor loads, for the commands the rules cannot read (CAD's `dimaligned`,
 * Film's `transcript.generate`).
 */
export function registerCommandIcons(icons: Readonly<Record<string, IconComponent>>) {
  for (const [id, icon] of Object.entries(icons)) KIT_COMMAND_ICONS.set(id, icon)
}

/**
 * An icon for an engine command: the kit's own (`registerCommandIcons`), else by its verb, then
 * by its object, then by the specific words of `COMMAND_ICONS`; the neutral mark when none match.
 */
export function commandIcon(command: { id: string; title?: string | null }): IconComponent {
  const own = KIT_COMMAND_ICONS.get(command.id)
  if (own) return own
  const split = (text: string) => text.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').toLowerCase()
  const verb = split(command.id.split('.').pop() ?? '').split(' ')[0]
  const first = (command.title ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  // `insert.pivotTable` reads as "insert pivot table".
  const words = `${split(command.id)} ${(command.title ?? '').toLowerCase()}`
  // A command that makes something shows what it makes (New Camera, a camera), not a row of pluses.
  if (CREATES.test(verb) || CREATES.test(first)) {
    // What it makes is in its own name and title, not its namespace (`layer.newCamera` makes a camera).
    const own = `${split(command.id.split('.').pop() ?? '')} ${(command.title ?? '').toLowerCase()}`
    const made = OBJECT_ICONS.find(([pattern]) => pattern.test(own))?.[1]
    if (made) return made
  }
  const byVerb = VERB_ICONS.find(([pattern]) => pattern.test(verb) || pattern.test(first))?.[1]
  if (byVerb) return byVerb
  return OBJECT_ICONS.find(([pattern]) => pattern.test(words))?.[1] ?? COMMAND_ICONS.find(([pattern]) => pattern.test(words))?.[1] ?? COMMAND_FALLBACK_ICON
}

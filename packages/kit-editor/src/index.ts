/**
 * @kition/kit-editor: build a kit's embedded editor (the Kition kit platform's kit editors, docs/platform/kits/ui.md). The host connection
 * (`connectHost`) and document session (`useKitSession`), the engine client, canvas, and engine
 * tools, and shared components styled with the host's theme. Import `@kition/kit-editor/styles.css`
 * once. The shared components come from Kition Tessera (`@kition/tessera-ui`) and are re-exported
 * here under the same names.
 */
export { connectHost, applyTheme, isMac, type HostConnection, type InitializeParams, type KitTheme } from './host'
export { createFilesClient, FILE_CHUNK_BYTES, type KitEngineOutput, type KitFilesClient } from './files'
export { fileErrorReason, type KitFileErrorReason, type KitFileStat, type KitFilesPickParams } from '@kition/kit-ui-protocol'
export { useKitSession, type KitSessionOptions } from './useKitSession'
export { createStrings, type Catalog } from './strings'
export { TextSink } from './TextSink'
export { CommandDialog, needsParams } from './CommandDialog'
export { PreviewDialog, type PreviewDialogPreview, type PreviewDialogProps, type PreviewStatus } from '@kition/tessera-ui'
export {
  Button,
  ColorGrid,
  ContextMenu,
  Dialog,
  ICON_STROKE,
  IconButton,
  LineMoreLabelContext,
  MenuButton,
  MenuItem,
  MenuSeparator,
  OverflowStrip,
  PALETTE_COLORS,
  Panel,
  RibbonButton,
  RibbonGroup,
  RibbonItem,
  RibbonPresentationContext,
  RibbonRow,
  RibbonStack,
  STANDARD_COLORS,
  StatusBar,
  StatusSpacer,
  TableSizePicker,
  Toaster,
  ZoomControl,
  lineSize,
  menuKeyDown,
  overflowOf,
  toast,
  type ContextMenuPoint,
  type RibbonButtonProps,
  type RibbonPresentation,
} from '@kition/tessera-ui'
export { DRAWING_SHAPES, DRAWING_WARPS, DRAWING_WEIGHTS, DrawingFormatGroup, DrawingInsertGroup, DrawingWarpMenu } from './drawing'
export { INK_TOOLS, INK_WEIGHTS, InkGroup, type DrawState } from './ink'
export { CHART_FORMATS, CHART_KINDS, CHART_MARKERS, ChartAxisDialog, ChartDataDialog, ChartDesignGroups, ChartInsertMenu, ChartSeriesDialog, labelPositions, linesOf, useChartSpec, type ChartAxis, type ChartFormat, type ChartSpec } from './chart'
export { NumberField, type NumberFieldProps } from '@kition/tessera-ui'
export { BarChart, LineChart, PieChart, useAutoSize, type AutoSize, type BarChartProps, type ChartHeight, type LineChartProps, type PieChartProps, type ToastId, type ToastLevel, type ToastOptions } from '@kition/tessera-ui'
// Forms, overlays, and app controls, for kit editors with their own screens (Table's grid and dialogs).
export {
  Badge,
  Card,
  CardContent,
  CardHeader,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  // kit-editor's CommandItem runs an engine command from a menu; Tessera's searchable list item is this.
  CommandItem as CommandListItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ConfirmProvider,
  Disclosure,
  Field,
  Modal,
  ModalBody,
  ModalClose,
  ModalCloseButton,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
  PasswordInput,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Select,
  Sheet,
  Spinner,
  Switch,
  TextInput,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useConfirm,
  useDialogFocus,
  useDismissableLayer,
  useMediaQuery,
  type ButtonVariant,
  type ConfirmFn,
  type ConfirmOptions,
  type ControlSize,
  type ModalContentProps,
  type SheetProps,
  type TesseraButtonProps,
} from '@kition/tessera-ui'
export { BarSeparator, Checkbox, Choice, Hint, Segmented, type CheckboxProps, type ChoiceProps, type Segment, type SegmentedProps } from '@kition/tessera-ui'
/** The workspace frame tree's functions (`workspaceTree.closePanel`, `workspaceTree.validateTree`, …). */
export * as workspaceTree from './workspaceTree'
export type { WorkspaceNode, WorkspaceSize, WorkspaceSplit, WorkspaceTabs } from './workspaceTree'
export { WorkspaceLayout, type WorkspaceLayoutProps, type WorkspacePanel } from '@kition/tessera-ui'
export { DockArea, dockHeights, type DockAreaHandle, type DockAreaProps, type DockGroup, type DockSizing, type DockTab } from '@kition/tessera-ui'
export { FloatingPanels, automaticFloatingPosition, clampFloatingRect, resizeFloatingRect, type FloatingEdge, type FloatingPanel, type FloatingPanelsProps, type FloatingRect, type FloatingSize } from '@kition/tessera-ui'
export { EyeButton, PanelFooter, RenameField, Thumbnail, deviceScale, type EyeSweep, type ThumbnailImage } from '@kition/tessera-ui'
export { useWorkspaces, workspaceSlug, WORKSPACE_ACTIONS, type SavedWorkspace, type WorkspacePrefs, type Workspaces, type WorkspacesOptions } from '@kition/tessera-ui'
export { kitStoreKey, readKitStore, removeKitStore, storedBytes, useKitStore, writeKitStore, type KitStoreOptions, type KitStoreWrite } from '@kition/tessera-ui'
export { Histogram, rankScale, smoothHistogram, type HistogramProps } from '@kition/tessera-ui'
export { TimecodeField, formatTimecode, parseTimecode, type TimecodeFieldProps } from '@kition/tessera-ui'
export { TransportBar, type TransportButton } from '@kition/tessera-ui'
export { LevelMeter, meterFraction, meterLayout, type LevelMeterHandle, type LevelMeterProps, type MeterBox, type MeterLayout } from '@kition/tessera-ui'
export { KeyframeLane, type Keyframe, type KeyframeLaneProps } from '@kition/tessera-ui'
export { ColorPicker, parseHex, rgbToHex, type ColorPickerProps, type RGB } from '@kition/tessera-ui'
export { CurveEditor, RGB_IDENTITY, addCurvePoint, hitCurvePoint, moveCurvePoint, removeCurvePoint, sampleCurve, sortCurve, type CurveEditorProps, type CurveKind, type CurvePoint } from '@kition/tessera-ui'
export { ColorWheel, lightnessAt, wheelRadius, wheelValueAt, type ColorWheelProps } from '@kition/tessera-ui'
export { GradientSlider, SLIDER_GRADIENTS, sliderFraction, sliderValueAt, type GradientSliderProps } from '@kition/tessera-ui'
export type { DragPhase } from '@kition/tessera-ui'
export { EditorFrame, FrameChrome, useFrameDisplay, useFrameMode, type EditorFrameProps } from './frame/EditorFrame'
export type { DisplayModeState } from './frame/useFrameLayout'
export { catalogTabs, commandMenuTabs, tabUiId, type FrameTab, type MenuAction, type MenuTabOptions, type MenuTree } from './frame/menus'
export { DISPLAY_MODES, LINE_MIN_WIDTH, modeStorageKey, type DisplayMode, type KitDisplay } from './frame/modes'
export type { FocusTool } from './frame/FocusBar'
export { catalogMenuTree, type CatalogMenu, type CatalogNode } from './catalogMenus'
export type { MenuRow } from './uiCatalog'
export { KitCanvas, type KitCanvasHandle, type KitCanvasView } from './engine/KitCanvas'
export { canvasColor, useEngineBackdrop, type EngineBackdropOptions } from './engine/backdrop'
export { KitEngine, type KitEngineInfo, type KitEngineSchema } from './engine/kitEngine'
export { WorkerRelay, type EngineReplica, type WorkerRelayOptions, type WorkerRelayPage } from './engine/workerRelay'
export { useEngineTools, type EngineToolInfo } from './engine/engineTools'
export {
  DEFAULT_OVERLAY_STYLE,
  drawEngineOverlays,
  drawOverlayInStyle,
  overlayCss,
  overlayStyle,
  type EngineOverlay,
  type OverlayDrawContext,
  type OverlayDrawer,
  type OverlayRgba,
  type OverlayStyle,
  type OverlayStylePatch,
} from './engine/engineOverlays'
export { HAND_TOOL, ZOOM_TOOL, dragRect, type KitPointer, type KitTool } from './engine/kitTools'
export type { KitCommand, KitModuleManifest, KitModuleRuntime } from './engine/kitModule'
export type { RasterDecoration, RasterPane, RasterPins, RasterRect, RasterView, RasterViewportStats } from './engine/rasterViewport'
export { viewPanes } from './engine/rasterViewport'
export { stackDecorations } from './engine/decorations'
export { FileChangedError, isFileChangedError } from './engine/useKitDocument'
export type { KitChange, KitDocumentOptions, KitRefresh, KitRepaint, KitRepaints, KitRunOptions } from './engine/useKitDocument'
export { RESERVED_SHORTCUTS, bindableShortcut, commandForShortcut, shortcutMatches } from './engine/kitShortcuts'
export { oneInFlight } from './oneInFlight'
export { kitLeases, leaseHeldByOther, scopesCollide, useLease, useLeases, type KitLease, type KitLeases, type LeaseOutcome } from './lease'
export { parseConflicts, reportConflicts, useConflictReport, type KitConflict } from './conflicts'
export { drawPresence, kitPresence, peerColor, remoteCarets, remoteSelections, usePresence, useRemoteCarets, useRemoteSelections, PRESENCE_INTERVAL_MS, type KitPeerPresence, type KitPresence, type KitPresenceCaret, type KitPresenceStore, type PresenceRect, type RemoteCaret, type RemoteSelection } from './presence'
export { CommentsPanel, COMMENTS_PANEL_LABELS, type CommentsPanelLabels, type CommentsPanelProps } from './CommentsPanel'
export { commentMarkers, useCommentAnchors, type CommentAnchorsOptions, type CommentMarker, type CommentMarkerRect } from './useCommentAnchors'
export { READ_ONLY_REASON, READ_ONLY_RULES, ReadOnlyError, editsDocument, isReadOnlyError } from './engine/readOnly'
export {
  KIT_UI_CATALOGS,
  createKitStrings,
  useKitEditorState,
  KitEditorProvider,
  useKitEditor,
  useKitTools,
  useReadOnly,
  CommandButton,
  ToolButton,
  RibbonMenu,
  CommandItem,
  CommandTab,
  commandGroups,
  commandsOfGroup,
  CommandGroupButtons,
  commandMenus,
  KitDocumentCanvas,
  SubMenu,
  ToolRail,
  EngineToolRail,
  PanelSection,
  type RailTool,
  type KitReport,
  type KitEditorOptions,
  type KitHistory,
  base64,
  PICTURE_TYPES,
  useHostPick,
  useEngineQuery,
  type KitEditor,
  type KitSession,
  type KitTools,
  type Strings,
} from './editor'
export { loadPhrases, parsePhrases, parseRustPhrases, catalogNames, withPhrases, type Phrases } from './phrases'
export { COMMAND_FALLBACK_ICON, commandIcon, registerCommandIcons, toolIcon } from './toolIcons'
/** Tessera Icons, for kits that take everything from kit-editor (`TesseraIcons.StarIcon`); bundlers keep only the icons used. */
export * as TesseraIcons from '@kition/tessera-icons/react'
/** The type of an icon prop: Tessera's icons, or another set's with the same props. */
export type { IconComponent, IconProps } from '@kition/tessera-icons/react'
export { defineKitUi, type KitUiDeclaration, type KitUiItem } from './uiCatalog'
export { KitElement, useUi } from './uiContext'
export { HostButtons, HOST_ICONS } from './HostButtons'
export { brandTokens, contrast, type KitBrand } from './brand'
export type { UiConfig, UiState } from './uiConfig'
export type { UiStore } from './uiStore'
export type { KitUiElement, KitUiHostButton, KitUiConfig, KitView } from '@kition/kit-ui-protocol'
export { isOpenableUrl, openErrorReason, type KitLinkRef, type KitOpenErrorReason, type KitOpenParams, type KitOpenResult } from '@kition/kit-ui-protocol'

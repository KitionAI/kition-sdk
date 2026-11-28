/**
 * The parts every kit editor shares: the engine's commands (which can run, running one, a
 * parameters dialog for one that needs values), ribbon buttons and tabs built from them, and the
 * editor shell the frame draws (`frame/EditorFrame.tsx`): the document actions (Undo, Redo, Ask
 * Agent, and Save), the status bar, the dialog and notices, and the standard shortcuts.
 */
import { createContext, Fragment, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { ChevronDownIcon as ChevronDown, ChevronRightIcon as ChevronRight, ChevronsLeftIcon as ChevronsLeft, ChevronsRightIcon as ChevronsRight, EllipsisIcon as MoreHorizontal, Redo2Icon as Redo2, SaveIcon as Save, SparklesIcon as Sparkles, Undo2Icon as Undo2, type IconComponent } from '@kition/tessera-icons/react'
import { matchesShortcut, type KitUiElement } from '@kition/kit-ui-protocol'
import { Button, ICON_STROKE, IconButton, MenuButton, MenuItem, MenuSeparator, menuKeyDown, OverflowStrip, RibbonButton, RibbonFitContext, FULL_RIBBON_FIT, RibbonGroup, RibbonItem, RibbonPresentationContext, StatusBar, lineSize, StatusSpacer, Toaster, ZoomControl, toast, StringsProvider, type RibbonButtonProps } from '@kition/tessera-ui'
import { COMMAND_FALLBACK_ICON, commandIcon, toolIcon } from './toolIcons'
import { CommandDialog, needsParams, type CommandDialogOptions } from './CommandDialog'
import { TextSink } from './TextSink'
import { createStrings, type Catalog } from './strings'
import type { Phrases } from './phrases'
import { composingKey, isMac, type HostConnection } from './host'
import type { useKitSession } from './useKitSession'
import type { KitCommand } from './engine/kitModule'
import { commandForShortcut, type CtrlShortcuts } from './engine/kitShortcuts'
import { KitCanvas, type KitCanvasHandle, type KitCanvasView, type KitEdgeScroll, type KitWheelPan } from './engine/KitCanvas'
import { repaintTaken, type KitRunOptions } from './engine/useKitDocument'
import type { RasterDecoration, RasterRect, RasterView, RasterViewportStats } from './engine/rasterViewport'
import { HAND_TOOL, type KitTool } from './engine/kitTools'
import { stackDecorations } from './engine/decorations'
import type { useEngineTools } from './engine/engineTools'
import { uiState } from './uiConfig'
import { commenterHistory, hiddenForCommenter, isReadOnlyError, refusedReadOnly } from './engine/readOnly'
import { buildCatalog, declaredIds } from './uiCatalog'
import { UiContext, UiProvider, useUi, warnUndeclared, type UiContextValue } from './uiContext'
import { HostButtons } from './HostButtons'
import { CustomizeDialog } from './CustomizeDialog'
import { RenderFailure } from './RenderFailure'

export type KitSession<T> = ReturnType<typeof useKitSession<T>>
export type KitTools = ReturnType<typeof useEngineTools>
export type Strings = (key: string, values?: Record<string, string | number>) => string

/** The shell's own strings; a kit's catalogs may override any of them. */
export const KIT_UI_CATALOGS: Record<string, Catalog> = {
  'en-US': {
    undo: 'Undo',
    redo: 'Redo',
    askAgent: 'Ask Agent',
    save: 'Save',
    saved: 'Saved',
    saveFailed: 'Could not save',
    commandFailed: 'The command failed',
    run: 'Run',
    cancel: 'Cancel',
    required: 'Required',
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    fit: 'Fit',
    opening: 'Opening…',
    openFailed: 'This file could not be opened',
    renderFailed: 'This view could not be rendered',
    retryRender: 'Retry',
    unsaved: 'Unsaved changes',
    fileChanged: 'This file changed outside the editor, and you have unsaved edits.',
    keepMine: 'Keep my edits',
    reloadFile: 'Load the new version',
    noHost: 'This editor runs inside a host, such as Kition.',
    selected: '{count} selected',
    moreOptions: 'More options',
    addItem: 'Add',
    removeItem: 'Remove',
    menuBar: 'Menu',
    ribbonScrollStart: 'Scroll ribbon left',
    ribbonScrollEnd: 'Scroll ribbon right',
    menusScrollStart: 'Scroll menus left',
    menusScrollEnd: 'Scroll menus right',
    optionsScrollStart: 'Scroll tool options left',
    optionsScrollEnd: 'Scroll tool options right',
    agentEdited: 'Edited by the agent',
    hostEdited: 'Edited by the app',
    agentLeaseHeld: "{name} is editing this part of the document, so the agent's edit was not made. Try again when they are done.",
    someone: 'Someone',
    viewOnly: 'View only',
    viewOnlyRefused: 'This document is view only',
    commentOnly: 'Can comment',
    commentOnlyRefused: 'You can only comment on this document',
    more: 'More',
    customize: 'Customize interface…',
    customizeTitle: 'Customize interface',
    customizeSearch: 'Search',
    customizeRestore: 'Restore defaults',
    customizeSave: 'Save',
    customizeFailed: 'Could not keep your customization',
    hideElement: 'Hide',
    expandPanelGroup: 'Expand panel group',
    collapsePanelGroup: 'Collapse panel group',
    closePanel: 'Close Panel',
    maximizeFrame: 'Maximize Frame',
    restoreWorkspace: 'Restore Workspace',
    panelMenu: 'Panel menu',
    moreTabs: 'More tabs',
    resizePanels: 'Resize panels',
    colorPickerSquare: 'Saturation and brightness',
    colorPickerHue: 'Hue',
    colorPickerHex: 'Hex color',
    railTwoColumns: 'Show tools in two columns',
    railOneColumn: 'Show tools in one column',
    transportControls: 'Transport controls',
    levelMeter: 'Audio levels',
    keyframeLane: 'Keyframes',
    keyframeAt: 'Keyframe at {time}',
    previewDialogOk: 'OK',
    previewDialogCancel: 'Cancel',
    previewDialogReset: 'Reset',
    previewDialogPreview: 'Preview',
    previewDialogPending: 'Updating the preview…',
    previewDialogOff: 'Preview is off: {error}',
    curveEditor: 'Curve',
    curveEditorPoint: 'Point {index}: {x}, {y}',
    colorWheel: 'color wheel',
    colorWheelLightness: '{label} lightness',
    colorWheelOffset: '{label}: {x}, {y}',
    floatingPanelClose: 'Close {title}',
    floatingPanelResize: 'Resize',
    drawingIllustrations: 'Illustrations',
    drawingShapes: 'Shapes',
    drawingTextBox: 'Text Box',
    drawingRect: 'Rectangle',
    drawingRoundRect: 'Rounded Rectangle',
    drawingEllipse: 'Oval',
    drawingTriangle: 'Triangle',
    drawingDiamond: 'Diamond',
    drawingArrow: 'Arrow',
    drawingStar: 'Star',
    drawingLine: 'Line',
    drawingShapeStyles: 'Shape Styles',
    drawingFill: 'Shape Fill',
    drawingNoFill: 'No Fill',
    drawingOutline: 'Shape Outline',
    drawingNoOutline: 'No Outline',
    drawingWeight: '{value} pt',
    drawingArrange: 'Arrange',
    drawingChangeShape: 'Change Shape',
    drawingRotateRight: 'Rotate Right 90°',
    drawingBringForward: 'Bring Forward',
    drawingBringToFront: 'Bring to Front',
    drawingSendBackward: 'Send Backward',
    drawingSendToBack: 'Send to Back',
    drawingGroup: 'Group',
    drawingConnect: 'Connect',
    drawingEffects: 'Shape Effects',
    drawingShadowBottomRight: 'Shadow: Offset Bottom Right',
    drawingShadowBottom: 'Shadow: Offset Bottom',
    drawingShadowAround: 'Shadow: Around',
    drawingNoShadow: 'No Shadow',
    drawingGlow: 'Glow',
    drawingNoGlow: 'No Glow',
    drawingTransform: 'Transform',
    drawingWarpArchUp: 'Arch Up',
    drawingWarpArchDown: 'Arch Down',
    drawingWarpCircle: 'Circle',
    drawingWarpWave1: 'Wave 1',
    drawingWarpWave2: 'Wave 2',
    drawingWarpInflate: 'Inflate',
    drawingWarpDeflate: 'Deflate',
    drawingWarpSlantUp: 'Slant Up',
    drawingWarpSlantDown: 'Slant Down',
    drawingWarpTriangle: 'Triangle Up',
    drawingWarpChevron: 'Chevron Up',
    drawingWarpCurveUp: 'Curve Up',
    drawingWarpCurveDown: 'Curve Down',
    drawingWarpCanUp: 'Can Up',
    drawingNoTransform: 'No Transform',
    drawingGradientDown: 'Gradient: Linear Down',
    drawingGradientRight: 'Gradient: Linear Right',
    drawingGradientDiagonal: 'Gradient: Linear Diagonal',
    drawingGradientCenter: 'Gradient: From Center',
    drawingUngroup: 'Ungroup',
    drawingDelete: 'Delete',
    drawingShapeFormat: 'Shape Format',
    chartInsert: 'Chart',
    chartColumn: 'Clustered Column',
    chartStackedColumn: 'Stacked Column',
    chartBar: 'Clustered Bar',
    chartLine: 'Line',
    chartLineMarkers: 'Line with Markers',
    chartArea: 'Area',
    chartPie: 'Pie',
    chartDoughnut: 'Doughnut',
    chartScatter: 'Scatter',
    chartRadar: 'Radar',
    chartType: 'Type',
    chartChangeType: 'Change Chart Type',
    chartElements: 'Chart Elements',
    chartTitle: 'Chart Title',
    chartTitleText: 'Chart Title',
    chartLegend: 'Legend',
    chartLegend_top: 'Top',
    chartLegend_bottom: 'Bottom',
    chartLegend_left: 'Left',
    chartLegend_right: 'Right',
    chartLegendNone: 'None',
    chartDataLabels: 'Data Labels',
    chartGridlines: 'Gridlines',
    chartAxisTitles: 'Axis Titles',
    chartTrendline: 'Trendline',
    chartTrendLinear: 'Linear',
    chartTrendExp: 'Exponential',
    chartTrendForecast: 'Linear Forecast',
    chartTrendMovingAvg: 'Two-Period Moving Average',
    chartErrorBars: 'Error Bars',
    chartErrStdErr: 'Standard Error',
    chartErrPercent: 'Percentage',
    chartErrStdDev: 'Standard Deviation',
    chartNone: 'None',
    chartSeriesType: 'Chart Type',
    chartSeriesTypeChart: "The chart's",
    chartSecondaryAxis: 'Secondary Axis',
    chartAxisTitleText: 'Axis Title',
    chartData: 'Data',
    chartEditData: 'Edit Data',
    chartSeriesName: 'Series {n} name',
    chartCategoryName: 'Category {n}',
    chartValue: '{series}, {category}',
    chartCategoryText: 'Category {n}',
    chartSeriesText: 'Series {n}',
    chartAddCategory: 'Add Category',
    chartAddSeries: 'Add Series',
    chartRemoveCategory: 'Remove Category',
    chartRemoveSeries: 'Remove Series',
    chartOk: 'OK',
    chartFormat: 'Format',
    chartFormatAxis: 'Format Axis',
    chartAxis: 'Axis',
    chartAxisValue: 'Vertical (Value) Axis',
    chartAxisCategory: 'Horizontal (Category) Axis',
    chartAxisMin: 'Minimum',
    chartAxisMax: 'Maximum',
    chartAxisMajor: 'Major unit',
    chartAxisNumberFormat: 'Number format',
    chartAxisAuto: 'Auto',
    chartAxisShow: 'Show axis',
    chartLabelPosition: 'Label Position',
    chartLabel_bestFit: 'Best Fit',
    chartLabel_ctr: 'Center',
    chartLabel_inBase: 'Inside Base',
    chartLabel_inEnd: 'Inside End',
    chartLabel_outEnd: 'Outside End',
    chartLabel_l: 'Left',
    chartLabel_r: 'Right',
    chartLabel_t: 'Above',
    chartLabel_b: 'Below',
    chartFormatSeries: 'Format Series',
    chartSeries: 'Series',
    chartLineWidth: 'Line width (pt)',
    chartMarker: 'Marker',
    chartMarker_auto: 'Automatic',
    chartMarker_none: 'None',
    chartMarker_circle: 'Circle',
    chartMarker_dash: 'Dash',
    chartMarker_diamond: 'Diamond',
    chartMarker_dot: 'Dot',
    chartMarker_plus: 'Plus',
    chartMarker_square: 'Square',
    chartMarker_star: 'Star',
    chartMarker_triangle: 'Triangle',
    chartMarker_x: 'X',
    chartSmooth: 'Smoothed line',
    inkTools: 'Tools',
    inkPens: 'Pens',
    inkSelect: 'Select',
    inkPen: 'Pen',
    inkPencil: 'Pencil',
    inkHighlighter: 'Highlighter',
    inkEraser: 'Eraser',
    inkColor: 'Ink Color',
    inkWeight: 'Thickness',
    modeMenu: 'Display mode',
    modeButton: 'Display mode: {mode}',
    modeStepped: 'Display mode: {mode} (showing {shown} to fit the window)',
    mode_menus: 'Menus',
    mode_line: 'Single line',
    mode_classic: 'Classic',
    mode_focus: 'Focus',
    focusBar: 'Focus',
    exitFocus: 'Exit focus',
    lineMore: 'More: {group}',
  },
  'zh-CN': {
    undo: '撤销',
    redo: '重做',
    askAgent: '询问 Agent',
    save: '保存',
    saved: '已保存',
    saveFailed: '无法保存',
    commandFailed: '命令执行失败',
    run: '运行',
    cancel: '取消',
    required: '必填',
    zoomOut: '缩小',
    zoomIn: '放大',
    fit: '适应窗口',
    opening: '正在打开…',
    openFailed: '无法打开此文件',
    renderFailed: '无法渲染此视图',
    retryRender: '重试',
    unsaved: '有未保存的更改',
    fileChanged: '此文件在编辑器外被修改，而你有未保存的更改。',
    keepMine: '保留我的更改',
    reloadFile: '加载新版本',
    noHost: '此编辑器需在宿主（如 Kition）中运行。',
    selected: '已选 {count} 项',
    moreOptions: '更多选项',
    addItem: '添加',
    removeItem: '移除',
    menuBar: '菜单',
    ribbonScrollStart: '向左滚动功能区',
    ribbonScrollEnd: '向右滚动功能区',
    menusScrollStart: '向左滚动菜单',
    menusScrollEnd: '向右滚动菜单',
    optionsScrollStart: '向左滚动工具选项',
    optionsScrollEnd: '向右滚动工具选项',
    agentEdited: '由 Agent 编辑',
    hostEdited: '由应用编辑',
    agentLeaseHeld: '{name} 正在编辑文档的这一部分，因此未执行 Agent 的编辑。请等其完成后再试。',
    someone: '有人',
    viewOnly: '仅查看',
    viewOnlyRefused: '此文档仅供查看',
    commentOnly: '可评论',
    commentOnlyRefused: '你只能评论此文档',
    more: '更多',
    customize: '自定义界面…',
    customizeTitle: '自定义界面',
    customizeSearch: '搜索',
    customizeRestore: '恢复默认',
    customizeSave: '保存',
    customizeFailed: '无法保存你的自定义设置',
    hideElement: '隐藏',
    expandPanelGroup: '展开面板组',
    collapsePanelGroup: '折叠面板组',
    closePanel: '关闭面板',
    maximizeFrame: '最大化框架',
    restoreWorkspace: '恢复工作区',
    panelMenu: '面板菜单',
    moreTabs: '更多选项卡',
    resizePanels: '调整面板大小',
    colorPickerSquare: '饱和度和明度',
    colorPickerHue: '色相',
    colorPickerHex: '十六进制颜色',
    railTwoColumns: '以两列显示工具',
    railOneColumn: '以一列显示工具',
    transportControls: '播放控件',
    levelMeter: '音频电平',
    keyframeLane: '关键帧',
    keyframeAt: '{time} 处的关键帧',
    previewDialogOk: '确定',
    previewDialogCancel: '取消',
    previewDialogReset: '重置',
    previewDialogPreview: '预览',
    previewDialogPending: '正在更新预览…',
    previewDialogOff: '预览已关闭：{error}',
    curveEditor: '曲线',
    curveEditorPoint: '点 {index}：{x}，{y}',
    colorWheel: '色轮',
    colorWheelLightness: '{label}亮度',
    colorWheelOffset: '{label}：{x}，{y}',
    floatingPanelClose: '关闭{title}',
    floatingPanelResize: '调整大小',
    drawingIllustrations: '插图',
    drawingShapes: '形状',
    drawingTextBox: '文本框',
    drawingRect: '矩形',
    drawingRoundRect: '圆角矩形',
    drawingEllipse: '椭圆',
    drawingTriangle: '三角形',
    drawingDiamond: '菱形',
    drawingArrow: '箭头',
    drawingStar: '星形',
    drawingLine: '直线',
    drawingShapeStyles: '形状样式',
    drawingFill: '形状填充',
    drawingNoFill: '无填充',
    drawingOutline: '形状轮廓',
    drawingNoOutline: '无轮廓',
    drawingWeight: '{value} 磅',
    drawingArrange: '排列',
    drawingChangeShape: '更改形状',
    drawingRotateRight: '向右旋转 90°',
    drawingBringForward: '上移一层',
    drawingBringToFront: '置于顶层',
    drawingSendBackward: '下移一层',
    drawingSendToBack: '置于底层',
    drawingGroup: '组合',
    drawingConnect: '连接',
    drawingEffects: '形状效果',
    drawingShadowBottomRight: '阴影：右下偏移',
    drawingShadowBottom: '阴影：下方偏移',
    drawingShadowAround: '阴影：四周',
    drawingNoShadow: '无阴影',
    drawingGlow: '发光',
    drawingNoGlow: '无发光',
    drawingTransform: '转换',
    drawingWarpArchUp: '上弯弧',
    drawingWarpArchDown: '下弯弧',
    drawingWarpCircle: '圆',
    drawingWarpWave1: '波形 1',
    drawingWarpWave2: '波形 2',
    drawingWarpInflate: '膨胀',
    drawingWarpDeflate: '收缩',
    drawingWarpSlantUp: '上斜',
    drawingWarpSlantDown: '下斜',
    drawingWarpTriangle: '正三角',
    drawingWarpChevron: 'V 形：正',
    drawingWarpCurveUp: '上弯',
    drawingWarpCurveDown: '下弯',
    drawingWarpCanUp: '桶形：正',
    drawingNoTransform: '无转换',
    drawingGradientDown: '渐变：线性向下',
    drawingGradientRight: '渐变：线性向右',
    drawingGradientDiagonal: '渐变：线性对角',
    drawingGradientCenter: '渐变：从中心',
    drawingUngroup: '取消组合',
    drawingDelete: '删除',
    drawingShapeFormat: '形状格式',
    chartInsert: '图表',
    chartColumn: '簇状柱形图',
    chartStackedColumn: '堆积柱形图',
    chartBar: '簇状条形图',
    chartLine: '折线图',
    chartLineMarkers: '带数据标记的折线图',
    chartArea: '面积图',
    chartPie: '饼图',
    chartDoughnut: '圆环图',
    chartScatter: '散点图',
    chartRadar: '雷达图',
    chartType: '类型',
    chartChangeType: '更改图表类型',
    chartElements: '图表元素',
    chartTitle: '图表标题',
    chartTitleText: '图表标题',
    chartLegend: '图例',
    chartLegend_top: '顶部',
    chartLegend_bottom: '底部',
    chartLegend_left: '左侧',
    chartLegend_right: '右侧',
    chartLegendNone: '无',
    chartDataLabels: '数据标签',
    chartGridlines: '网格线',
    chartAxisTitles: '坐标轴标题',
    chartTrendline: '趋势线',
    chartTrendLinear: '线性',
    chartTrendExp: '指数',
    chartTrendForecast: '线性预测',
    chartTrendMovingAvg: '双周期移动平均',
    chartErrorBars: '误差线',
    chartErrStdErr: '标准误差',
    chartErrPercent: '百分比',
    chartErrStdDev: '标准偏差',
    chartNone: '无',
    chartSeriesType: '图表类型',
    chartSeriesTypeChart: '与图表相同',
    chartSecondaryAxis: '次坐标轴',
    chartAxisTitleText: '坐标轴标题',
    chartData: '数据',
    chartEditData: '编辑数据',
    chartSeriesName: '系列 {n} 名称',
    chartCategoryName: '类别 {n}',
    chartValue: '{series}，{category}',
    chartCategoryText: '类别 {n}',
    chartSeriesText: '系列 {n}',
    chartAddCategory: '添加类别',
    chartAddSeries: '添加系列',
    chartRemoveCategory: '删除类别',
    chartRemoveSeries: '删除系列',
    chartOk: '确定',
    chartFormat: '格式',
    chartFormatAxis: '设置坐标轴格式',
    chartAxis: '坐标轴',
    chartAxisValue: '垂直(值)轴',
    chartAxisCategory: '水平(类别)轴',
    chartAxisMin: '最小值',
    chartAxisMax: '最大值',
    chartAxisMajor: '主要单位',
    chartAxisNumberFormat: '数字格式',
    chartAxisAuto: '自动',
    chartAxisShow: '显示坐标轴',
    chartLabelPosition: '标签位置',
    chartLabel_bestFit: '最佳匹配',
    chartLabel_ctr: '居中',
    chartLabel_inBase: '轴内侧',
    chartLabel_inEnd: '数据标签内',
    chartLabel_outEnd: '数据标签外',
    chartLabel_l: '靠左',
    chartLabel_r: '靠右',
    chartLabel_t: '靠上',
    chartLabel_b: '靠下',
    chartFormatSeries: '设置数据系列格式',
    chartSeries: '系列',
    chartLineWidth: '线条宽度(磅)',
    chartMarker: '数据标记',
    chartMarker_auto: '自动',
    chartMarker_none: '无',
    chartMarker_circle: '圆形',
    chartMarker_dash: '短划线',
    chartMarker_diamond: '菱形',
    chartMarker_dot: '圆点',
    chartMarker_plus: '加号',
    chartMarker_square: '正方形',
    chartMarker_star: '星形',
    chartMarker_triangle: '三角形',
    chartMarker_x: 'X 形',
    chartSmooth: '平滑线',
    inkTools: '工具',
    inkPens: '笔',
    inkSelect: '选择',
    inkPen: '笔',
    inkPencil: '铅笔',
    inkHighlighter: '荧光笔',
    inkEraser: '橡皮擦',
    inkColor: '墨迹颜色',
    inkWeight: '粗细',
    modeMenu: '显示模式',
    modeButton: '显示模式：{mode}',
    modeStepped: '显示模式：{mode}（为适应窗口，显示为{shown}）',
    mode_menus: '菜单',
    mode_line: '单行',
    mode_classic: '经典',
    mode_focus: '专注',
    focusBar: '专注',
    exitFocus: '退出专注',
    lineMore: '更多：{group}',
  },
}

/** A kit's strings over the shell's, for `locale` (fallbacks as in `createStrings`). */
export function createKitStrings(catalogs: Record<string, Catalog>, locale: string): Strings {
  const merged: Record<string, Catalog> = { ...KIT_UI_CATALOGS }
  for (const [tag, catalog] of Object.entries(catalogs)) merged[tag] = { ...merged[tag], ...catalog }
  return createStrings(merged, locale)
}

/** A session that runs no comment commands (a viewer's, an editor's, or one made without them). */
const NO_COMMENTS: ReadonlySet<string> = new Set()
const NO_IDS: ReadonlySet<string> = new Set()
/** A command run from inside `session.inOrder`'s work. */
const IN_ORDER: KitRunOptions = { inOrder: true }

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a command failed because the document is read-only (the session's or the engine's refusal). */
function isRefusedAsReadOnly(error: unknown) {
  return isReadOnlyError(error) || (error as { data?: { reason?: unknown } } | null)?.data?.reason === 'read-only'
}

/** `editor.report`, or an error toast for an editor made without one. */
function reportFailure(editor: { report?: (title: string, error: unknown) => void }, title: string, error: unknown) {
  if (editor.report) editor.report(title, error)
  else toast('error', title, errorText(error))
}

/**
 * How an editor reports a failure: `title` says what failed (`commandFailed`, `saveFailed`), and
 * `error` why. The default is an error toast; an editor that ports an app with a status bar
 * passes its own (Film shows every error there, as upstream does).
 */
export type KitReport = (title: string, error: unknown) => void

export type KitEditorOptions = {
  /** Where failures go; an error toast when unset. */
  report?: KitReport
  /**
   * The kit's own undo history, when it is more than its engine's: an editor that keeps steps of
   * its own next to its engine's has steps in both. The frame's Undo and Redo
   * (buttons, menus, shortcuts, the Focus bar) then show and run this history instead of the
   * engine's `edit.undo` and `edit.redo`, still under the host's configuration.
   */
  history?: KitHistory
}

/**
 * A kit's own undo history for the frame (`KitEditorOptions.history`). `undo` and `redo` answer
 * whether they took a step (or a promise of it); `subscribe` calls its listener whenever
 * `canUndo` or `canRedo` may have changed, and answers the unsubscribe.
 */
export type KitHistory = {
  canUndo(): boolean
  canRedo(): boolean
  undo(): boolean | Promise<boolean>
  redo(): boolean | Promise<boolean>
  subscribe(listener: () => void): () => void
}

/** The engine commands a kit's own history (`KitHistory`) stands in for. */
const HISTORY_COMMANDS: Readonly<Record<string, 'undo' | 'redo'>> = { 'edit.undo': 'undo', 'edit.redo': 'redo' }

/**
 * The engine's commands for an editor: which exist and can run (refreshed after every change),
 * running one (opening its parameters dialog when it needs values and none are given), queries
 * answered as JSON, and saving. `testId` prefixes the test ids of the shared controls.
 */
export function useKitEditorState<T>(
  session: KitSession<T>,
  host: HostConnection,
  t: Strings,
  testId: string,
  phrase: Phrases = (english) => english,
  /** Values a command's dialog starts with, from where the person is (the current page). */
  defaults?: (command: KitCommand) => Record<string, unknown>,
  options: KitEditorOptions = {},
) {
  const latestReport = useRef(options.report)
  latestReport.current = options.report
  /** Reports a failure through `options.report`, else as an error toast. Stable. */
  const report = useCallback<KitReport>((title, error) => (latestReport.current ? latestReport.current(title, error) : toast('error', title, errorText(error))), [])
  const { doc, change } = session
  const [commands, setCommands] = useState<KitCommand[]>([])
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialogState] = useState<{ command: KitCommand; values: Record<string, unknown> } | null>(null)
  const latestDefaults = useRef(defaults)
  latestDefaults.current = defaults
  /** Opens `command`'s parameters dialog, started from the editor's defaults (or closes it). */
  const setDialog = useCallback(
    (command: KitCommand | null, values: Record<string, unknown> = {}) => setDialogState(command ? { command, values: { ...latestDefaults.current?.(command), ...values } } : null),
    [],
  )
  const latest = useRef(session)
  latest.current = session
  const ui = useSyncExternalStore(host.ui.subscribe, host.ui.get)
  const history = options.history ?? null
  const [, historyChanged] = useState(0)
  useEffect(() => history?.subscribe(() => historyChanged((tick) => tick + 1)), [history])
  const latestHistory = useRef(history)
  latestHistory.current = history
  /**
   * A read-only document (`host.readOnly`) offers no command that edits (see `engine/readOnly.ts`)
   * but, for a commenter, the comment commands and the Undo and Redo of their comments.
   */
  const readOnly = host.readOnly === true
  const comments = session.comments ?? NO_COMMENTS
  /** Whether the read-only rules refuse `command` here (never in an editable document). */
  const refused = useCallback((command: KitCommand) => readOnly && refusedReadOnly(command, comments), [comments, readOnly])

  useEffect(() => {
    if (doc) void doc.commands().then(setCommands)
  }, [doc])

  /** The document and change the list of disabled commands (`disabled`) was read for. */
  const [listed, setListed] = useState<{ doc: unknown; revision: number } | null>(null)
  // Asked again after each change but a drag's steps (`change.gesture`): its release asks once.
  useEffect(() => {
    if (!doc || change.gesture) return undefined
    let stale = false
    const revision = change.revision
    void doc
      .disabledCommands()
      .catch(() => [] as string[])
      .then((off) => {
        if (stale) return
        setDisabled(new Set(off))
        setListed({ doc, revision })
      })
    return () => {
      stale = true
    }
  }, [change.revision, change.gesture, doc])
  const listedRef = useRef(listed)
  listedRef.current = listed
  /**
   * Whether the list of what can run (`enabled`) may be behind the engine: it was not read for
   * the document's last change yet (a change just made, a drag's steps), or commands and tool
   * events are still on their way to the engine. A shortcut the list calls disabled is then asked
   * of the engine (`runWhenEnabled`), with Cmd or Ctrl too: Cmd+Z right after an edit undoes it.
   */
  const listBehind = useCallback(() => {
    const now = latest.current
    const read = listedRef.current
    return !read || read.doc !== now.doc || read.revision !== now.change.revision || now.pending?.() === true
  }, [])

  /**
   * A query: a command that reads without editing, answered as JSON (no repaint). Read-only
   * queries are the kit's own engine reads, so the UI configuration does not refuse them; a
   * command the engine marks as editing (`mutates`) that the host denies answers null without
   * running. Other edits go through the session's `run`.
   */
  const query = useCallback(async <R,>(id: string, params: Record<string, unknown> = {}): Promise<R | null> => {
    const open = latest.current.doc
    if (!open) return null
    const known = latestById.current.get(id)
    if (known?.mutates && uiState(host.ui.get(), `command:${id}`, known.menu).denied) return null
    if (known && refused(known)) return null
    try {
      return JSON.parse(await open.execute(id, params)) as R
    } catch {
      return null
    }
  }, [host, refused])

  const byId = useMemo(() => new Map(commands.map((command) => [command.id, command])), [commands])
  const latestById = useRef(byId)
  latestById.current = byId

  const run = useCallback(
    /** `options.inOrder`: run from inside `session.inOrder`'s work (`runWhenEnabled`). */
    async (id: string, params?: Record<string, unknown>, options?: KitRunOptions) => {
      const command = byId.get(id)
      const own = latestHistory.current
      const step = own ? HISTORY_COMMANDS[id] : undefined
      if (own && step) {
        // The kit's own history: still refused where the host denies the command or its action.
        if (uiState(host.ui.get(), `command:${id}`, command?.menu).denied || uiState(host.ui.get(), `action:${step}`).denied) return null
        try {
          return JSON.stringify({ done: (await own[step]()) !== false })
        } catch (error) {
          report(t('commandFailed'), error)
          return null
        }
      }
      // A command the host denies gets no dialog: the session's `run` refuses it, as on every path.
      if (!params && command && needsParams(command) && !uiState(host.ui.get(), `command:${id}`, command.menu).denied && !refused(command)) {
        setDialog(command)
        return null
      }
      try {
        return await (options ? latest.current.run(id, params ?? {}, null, options) : latest.current.run(id, params ?? {}))
      } catch (error) {
        if (readOnly && isRefusedAsReadOnly(error)) toast('info', t(comments.size ? 'commentOnlyRefused' : 'viewOnlyRefused'))
        else report(t('commandFailed'), error)
        return null
      }
    },
    [byId, comments, host, readOnly, refused, report, setDialog, t],
  )
  const latestRun = useRef(run)
  latestRun.current = run

  // A commenter's Undo and Redo run only while their comments left a step to take (`info`). A
  // kit's own history answers for itself (its `subscribe` renders the editor again).
  const canUndo = history ? history.canUndo() : (doc?.info?.canUndo ?? false)
  const canRedo = history ? history.canRedo() : (doc?.info?.canRedo ?? false)
  const enabledWith = useCallback(
    (id: string, off: ReadonlySet<string>) => {
      const command = byId.get(id)
      if (!command || uiState(ui, `command:${id}`, command.menu).denied) return false
      const own = history ? HISTORY_COMMANDS[id] : undefined
      if (own) return own === 'undo' ? canUndo : canRedo
      if (off.has(id) || refused(command)) return false
      const step = readOnly ? commenterHistory(id, comments) : null
      return step === null || (step === 'undo' ? canUndo : canRedo)
    },
    [byId, canRedo, canUndo, comments, history, readOnly, refused, ui],
  )
  const enabled = useCallback((id: string) => enabledWith(id, disabled), [disabled, enabledWith])
  /**
   * Whether `id` could run if the engine's list of what it refuses allowed it: false when the
   * host's configuration, the read-only rules or the kit's own history refuse it, which no engine
   * answer changes.
   */
  const enabledByEngine = useCallback((id: string) => enabledWith(id, NO_IDS), [enabledWith])
  const latestEnabledWith = useRef(enabledWith)
  latestEnabledWith.current = enabledWith
  /**
   * Runs `id` if the engine says it can run now, rather than the list read after the last change:
   * a key pressed as the engine answers an event (Delete right after a marquee, F8 right after the
   * click or the key that let it run) would otherwise find the command disabled until that list is
   * read again. Asked and run in the order of the person's input (`session.inOrder`): the tool
   * events and commands before it go first, and every key, text and command after it waits until
   * it ran, so it never acts after a key pressed later.
   */
  const runWhenEnabled = useCallback(
    (id: string) =>
      latest.current.inOrder(async () => {
        const open = latest.current.doc
        if (!open) return null
        const off = await open.disabledCommands().catch(() => null)
        if (off == null || latest.current.doc !== open || !latestEnabledWith.current(id, new Set(off))) return null
        return latestRun.current(id, {}, IN_ORDER)
      }),
    [],
  )

  const save = useCallback(async () => {
    try {
      await latest.current.save()
      toast('success', t('saved'))
    } catch (error) {
      report(t('saveFailed'), error)
    }
  }, [report, t])

  /** Opens a command's parameters dialog even when none are required (a link's address), with `values` set; a denied command is refused instead. */
  const ask = useCallback(
    (id: string, values?: Record<string, unknown>) => {
      if (uiState(host.ui.get(), `command:${id}`, byId.get(id)?.menu).denied) void run(id, values ?? {})
      else setDialog(byId.get(id) ?? null, values)
    },
    [byId, host, run, setDialog],
  )

  return { session, host, t, phrase, testId, commands, byId, enabled, enabledByEngine, listBehind, runWhenEnabled, run, ask, query, save, report, dialog, setDialog, comments, canUndo, canRedo }
}

export type KitEditor = ReturnType<typeof useKitEditorState<unknown>>

type EditorContext = { editor: KitEditor; tools: KitTools | null }
const KitEditorContext = createContext<EditorContext | null>(null)

/**
 * Gives the shared controls below the editor (and the engine's tools, if it has any), and the UI
 * configuration. The engine's tools get the configuration's check, so a tool the host denies is
 * never active, whichever path chose it.
 */
export function KitEditorProvider({ editor, tools = null, children }: { editor: KitEditor; tools?: KitTools | null; children: ReactNode }) {
  const value = useMemo(() => ({ editor, tools }), [editor, tools])
  const { host, byId, session } = editor
  const config = useSyncExternalStore(host.ui.subscribe, host.ui.get)
  const setDenied = tools?.setDenied
  // A read-only document denies every engine tool: the canvas keeps the hand.
  const readOnly = host.readOnly === true
  useLayoutEffect(() => {
    setDenied?.((id) => readOnly || uiState(config, `tool:${id}`).denied)
  }, [config, readOnly, setDenied])
  const declared = useMemo(() => declaredIds(host.declaration), [host])
  const doc = useRef(session.doc)
  doc.current = session.doc
  // An editor made by hand (a kit's own, a test's) may have none.
  const comments = editor.comments ?? NO_COMMENTS
  const ui = useMemo<UiContextValue>(
    () => ({
      store: host.ui,
      locale: host.init.locale,
      // O(1): `useUi().state` calls it for every command on every render.
      menuOf: (id) => byId.get(id)?.menu ?? [],
      declared,
      press: (id) => host.ui.action({ id, document: { path: host.init.document.path, dirty: doc.current?.info.dirty ?? false, revision: doc.current?.info.revision ?? 0 } }),
      offerHide: null,
      openCustomize: null,
      hide: null,
      renderButtons: (place, as) => <HostButtons place={place} as={as} />,
      // A commenter sees what they can run, not a document of disabled edits.
      sessionHidden: comments.size ? (id) => hiddenForCommenter(byId.get(id) ?? { id }, comments) : undefined,
    }),
    [byId, comments, declared, host],
  )
  // `ui/elements` (section 9), answered from the engine itself: the host may ask before the
  // editor has loaded its commands or the engine's tools.
  const catalog = useRef<() => Promise<KitUiElement[]>>(async () => [])
  catalog.current = async () => {
    const commands = await session.commands()
    const engineTools = tools && !tools.tools.length ? ((await session.tool<KitTools['tools']>('tools')) ?? []) : (tools?.tools ?? [])
    return buildCatalog({ commands, declaration: host.declaration, engineTools, agent: host.init.capabilities.includes('agent'), t: editor.t, phrase: editor.phrase, config: host.ui.get() })
  }
  useEffect(() => {
    if (host.declaration) host.peer.handle('ui/elements', () => catalog.current())
  }, [host])
  return (
    <KitEditorContext.Provider value={value}>
      <StringsProvider strings={editor.t}>
        <UiProvider value={ui}>{children}</UiProvider>
      </StringsProvider>
    </KitEditorContext.Provider>
  )
}

export function useKitEditor() {
  const context = useContext(KitEditorContext)
  if (!context) throw new Error('useKitEditor outside KitEditorProvider')
  return context.editor
}

/**
 * Whether the document is read-only for this session (`document.readOnly`). The shared controls
 * and the engine already refuse edits; a kit uses this for its own panels (a field that edits).
 */
export function useReadOnly() {
  return useKitEditor().host.readOnly === true
}

/** The engine's tools, when the editor has them. */
export function useKitTools() {
  return useContext(KitEditorContext)?.tools ?? null
}

/** "Hide" on an element's context menu, when the host keeps personal hides. */
function useHideOnContextMenu(id: string) {
  const { offerHide } = useUi()
  return offerHide
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault()
        offerHide(id, event.clientX, event.clientY)
      }
    : undefined
}

/**
 * A ribbon button that runs an engine command, enabled when the engine says it can run (a kit's
 * `disabled` only disables it further). `onRun` runs it through the kit's own entry point instead
 * of the editor's `run` (Film's `invoke`), as `CommandItem`'s does; a command that needs values
 * still opens its parameters dialog.
 */
export function CommandButton({ command, params, ask, onRun, ...props }: Omit<RibbonButtonProps, 'onClick' | 'label'> & { command: string; params?: Record<string, unknown>; label?: string; ask?: boolean; onRun?: (command: string) => void }) {
  const editor = useKitEditor()
  const { enabled, byId, testId, phrase } = editor
  const ui = useUi()
  const onContextMenu = useHideOnContextMenu(`command:${command}`)
  if (ui.state(`command:${command}`).hidden) return null
  const known = byId.get(command)
  return (
    <RibbonButton
      {...props}
      label={props.label ?? phrase(known?.title ?? command)}
      disabled={props.disabled || !enabled(command)}
      onClick={() => {
        if (ask) editor.ask(command)
        else if (onRun && params === undefined && !(known && needsParams(known))) onRun(command)
        else void editor.run(command, params)
      }}
      onContextMenu={onContextMenu ?? props.onContextMenu}
      data-testid={`${testId}-cmd-${command}`}
      data-kit-ui-id={`command:${command}`}
    />
  )
}

/** A ribbon button that chooses one of the engine's tools, pressed while it is active; `testId` names it where a tool rail draws the same tool (the rail keeps `<testId>-tool-<tool>`). */
export function ToolButton({ tool, testId: ownTestId, ...props }: Omit<RibbonButtonProps, 'onClick' | 'pressed'> & { tool: string; testId?: string }) {
  const tools = useKitTools()
  const { testId } = useKitEditor()
  const ui = useUi()
  const state = ui.state(`tool:${tool}`)
  if (state.hidden) return null
  return (
    <RibbonButton
      {...props}
      pressed={tools?.active === tool}
      disabled={props.disabled || !tools || state.disabled}
      onClick={() => {
        if (!state.denied) tools?.select(tool)
      }}
      data-testid={ownTestId ?? `${testId}-tool-${tool}`}
      data-kit-ui-id={`tool:${tool}`}
    />
  )
}

/**
 * A ribbon button that opens a menu (a split button's arrow, a gallery); `primary` shows it in
 * Single line's row (its icon alone unless `lineLabel`), and its open menu's rows with it: the row
 * draws only controls under a primary item, so the whole menu is under one.
 */
export function RibbonMenu({ icon, label, size = 'small', children, disabled, swatch, testId, primary, lineLabel }: { icon?: IconComponent; label: string; size?: 'large' | 'small' | 'icon'; children: ReactNode; disabled?: boolean; swatch?: string; testId?: string; primary?: boolean; lineLabel?: boolean }) {
  const presentation = useContext(RibbonPresentationContext)
  const fit = useContext(RibbonFitContext)
  if (presentation === 'primary' && !primary) return null
  const shown = lineSize(presentation, size, icon != null, lineLabel, fit.size)
  const menu = (
    <MenuButton
      trigger={({ toggle, open }) => (
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          <RibbonButton icon={icon} label={label} size={shown} disabled={disabled} pressed={open} swatch={swatch} onClick={toggle} data-testid={testId} primary={primary} lineLabel={lineLabel} />
          {shown !== 'large' ? <ChevronDown size={11} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ marginLeft: -4, opacity: 0.6 }} onClick={toggle} /> : null}
        </span>
      )}
    >
      {/* The menu shows whole, whatever the row around its button draws. */}
      <RibbonPresentationContext.Provider value="full">
        <RibbonFitContext.Provider value={FULL_RIBBON_FIT}>{children}</RibbonFitContext.Provider>
      </RibbonPresentationContext.Provider>
    </MenuButton>
  )
  return primary ? <RibbonItem primary>{menu}</RibbonItem> : menu
}

/**
 * A menu item that runs an engine command. `shortcut` replaces the engine's own (null shows none);
 * `checked` makes it a toggle with a check mark. `path` is the menu it is drawn under when that is
 * not the engine's own (a catalog's): hides and disables of that menu apply too.
 */
export function CommandItem({
  command,
  params,
  label,
  icon,
  ask,
  shortcut,
  checked,
  path,
  onRun,
}: {
  command: string
  params?: Record<string, unknown>
  label?: string
  icon?: IconComponent
  ask?: boolean
  shortcut?: string | null
  checked?: boolean
  path?: readonly string[]
  /**
   * Runs the command instead of the editor's `run` (an app's own entry point, as Film's `invoke`).
   * A command that needs values still opens its parameters dialog.
   */
  onRun?: (command: string) => void
}) {
  const editor = useKitEditor()
  const { enabled, byId, testId, phrase } = editor
  const ui = useUi()
  const onContextMenu = useHideOnContextMenu(`command:${command}`)
  const drawnUnder = path ? ui.state(`command:${command}`, path) : null
  if (ui.state(`command:${command}`).hidden || drawnUnder?.hidden) return null
  const known = byId.get(command)
  return (
    <div onContextMenu={onContextMenu} style={{ display: 'contents' }}>
      <MenuItem
        icon={icon}
        label={label ?? phrase(known?.title ?? command)}
        shortcut={shortcut === undefined ? known?.shortcut : shortcut}
        disabled={!enabled(command) || Boolean(drawnUnder?.disabled)}
        checked={checked}
        onSelect={() => {
          if (ask) editor.ask(command)
          else if (onRun && params === undefined && !(known && needsParams(known))) onRun(command)
          else void editor.run(command, params)
        }}
        testId={`${testId}-cmd-${command}`}
        uiId={`command:${command}`}
      />
    </div>
  )
}

/** A menu label without its trailing ellipsis ("Block..." and "Block…" are "Block"). */
const withoutEllipsis = (label: string) => label.replace(/(\.\.\.|…)\s*$/, '').trim()

/**
 * The commands under `menu` (and `extra` menus), grouped by their second menu segment. A group
 * that is only one command named after itself (the engine's `["Insert", "Block..."]`), or any
 * group whose name ends in an ellipsis, is not a group: its commands join one general group named
 * after their menu (the tab), in the place the first of them came.
 */
export function commandGroups(commands: readonly KitCommand[], menus: readonly string[]) {
  const groups = new Map<string, { path: string; items: KitCommand[] }>()
  for (const command of commands) {
    if (!menus.includes(command.menu[0] ?? '')) continue
    const group = command.menu[1] ?? command.menu[0] ?? ''
    const path = command.menu.slice(0, command.menu[1] ? 2 : 1).join('/')
    const entry = groups.get(group) ?? { path, items: [] }
    entry.items.push(command)
    groups.set(group, entry)
  }
  const merged = new Map<string, { path: string; items: KitCommand[] }>()
  for (const [group, entry] of groups) {
    const top = entry.path.split('/')[0] ?? group
    const own = entry.items.length === 1 && withoutEllipsis(entry.items[0].title) === withoutEllipsis(group)
    const general = group !== top && (own || withoutEllipsis(group) !== group)
    const key = general ? top : group
    const into = merged.get(key) ?? { path: general ? top : entry.path, items: [] }
    into.items.push(...entry.items)
    merged.set(key, into)
  }
  return merged
}

/**
 * The engine's commands in the group at `path` (`"Insert/Illustrations"`, as `commandGroups`
 * keys them), less any whose title is one of `titles`: the buttons a hand-made group of the same
 * name already draws (its own "Shapes" beside the engine's).
 */
export function commandsOfGroup(commands: readonly KitCommand[], path: string, titles: readonly string[] = []) {
  const [menu = '', group] = path.split('/')
  const own = new Set(titles.map((title) => withoutEllipsis(title).toLowerCase()))
  return (commandGroups(commands, [menu]).get(group ?? menu)?.items ?? []).filter((command) => !own.has(withoutEllipsis(command.title).toLowerCase()))
}

/**
 * An engine command's button in a grid built from the engine's menus, with its command icon. In
 * Single line's row it keeps its label while that icon is only the fallback (no word of the
 * command matched one), so the row never shows several identical anonymous glyphs.
 */
function CommandGridButton({ command, primary }: { command: KitCommand; primary?: boolean }) {
  const icon = commandIcon(command)
  return <CommandButton command={command.id} icon={icon} primary={primary} lineLabel={icon === COMMAND_FALLBACK_ICON} />
}

/**
 * The engine's commands of the group at `path` as ribbon buttons, for a hand-made group that
 * takes the engine's group of the same name into itself (pair it with `CommandTab`'s `omit`).
 * `primary` lists the commands shown in Single line's row; the row reaches this element only when
 * `primary` is given.
 */
export function CommandGroupButtons({ path, titles = [], exclude = [], primary = [] }: { path: string; titles?: readonly string[]; exclude?: readonly string[]; primary?: readonly string[] }) {
  const { commands } = useKitEditor()
  const items = commandsOfGroup(
    commands.filter((command) => !exclude.includes(command.id)),
    path,
    titles,
  )
  if (items.length === 0) return null
  return (
    <div className="kui-command-grid">
      {items.map((command) => (
        <CommandGridButton key={command.id} command={command} primary={primary.includes(command.id)} />
      ))}
    </div>
  )
}

/**
 * A ribbon tab built from the engine's own command paths (`menu: [tab, group]`), for tabs the
 * editor does not lay out by hand: every command stays reachable, and one that needs values
 * opens its parameters dialog. `label` names a group (the engine's name by default); `omit`
 * leaves out groups a hand-made group already shows (see `CommandGroupButtons`). `primary` lists
 * the commands shown in Single line's row.
 */
export function CommandTab({ menu, extra = [], exclude = [], omit = [], label, primary = [] }: { menu: string; extra?: string[]; exclude?: string[]; omit?: string[]; label?: (group: string) => string; primary?: readonly string[] }) {
  const { commands, phrase } = useKitEditor()
  const groups = commandGroups(
    commands.filter((command) => !exclude.includes(command.id)),
    [menu, ...extra],
  )
  for (const group of omit) groups.delete(group)
  return (
    <>
      {[...groups].map(([group, { path, items }]) => (
        <RibbonGroup key={group} id={`menu:${path}`} label={label ? label(group) : phrase(group)} icon={items[0] ? commandIcon(items[0]) : undefined}>
          <div className="kui-command-grid">
            {items.map((command) => (
              <CommandGridButton key={command.id} command={command} primary={primary.includes(command.id)} />
            ))}
          </div>
        </RibbonGroup>
      ))}
    </>
  )
}

/** The engine's top-level menus in `order` (others after), as ribbon tabs. */
export function commandMenus(commands: readonly KitCommand[], order: readonly string[]) {
  const seen = new Set(commands.map((command) => command.menu[0]).filter((menu): menu is string => Boolean(menu)))
  const rank = (menu: string) => (order.includes(menu) ? order.indexOf(menu) : order.length)
  return [...seen].sort((a, b) => rank(a) - rank(b))
}

/**
 * The document area: the engine's canvas once open, why not when it failed, and the field that
 * takes typed text for the engine's text tools (so input methods compose).
 */
export function KitDocumentCanvas({
  canvas,
  viewMemory,
  initialArea = null,
  panBounds = null,
  framed,
  animated,
  onView,
  testId,
  tool,
  decorate,
  decorateUnder,
  wheelPan,
  edgeScroll,
  children,
}: {
  canvas: RefObject<KitCanvasHandle | null>
  viewMemory?: RefObject<RasterView | null>
  initialArea?: RasterRect | null
  /** The page bounds scrolling stops at; absent for a freely pannable canvas. */
  panBounds?: RasterRect | null
  framed?: boolean
  animated?: boolean
  onView?: (view: KitCanvasView, stats: RasterViewportStats | null) => void
  testId?: string
  /** The editor's own pointer tool, for engines without tools of their own (the engine's by default). */
  tool?: KitTool
  /**
   * The editor's own decoration (selection outlines, other people's selections, comment pins),
   * drawn over the document and over the engine's overlays (its caret and selection), which it
   * can never hide.
   */
  decorate?: RasterDecoration | null
  /**
   * The editor's decoration under the engine's overlays, over the document: what the engine's
   * selection and handles must cover (layout grids, frame name labels, a pixel grid).
   */
  decorateUnder?: RasterDecoration | null
  /** Where a wheel's scroll takes the view (a sheet's whole rows); the canvas's own pan by default (`KitWheelPan`). */
  wheelPan?: ((pan: KitWheelPan) => { x: number; y: number } | null | undefined) | null
  /** Scrolling while a held gesture's pointer is past the canvas's edge (`KitEdgeScroll`); none by default. */
  edgeScroll?: KitEdgeScroll | null
  /** Over the canvas: an editor's in-place fields (new text). */
  children?: ReactNode
}) {
  const editor = useKitEditor()
  const tools = useKitTools()
  const own = useRef<RasterView | null>(null)
  const { doc, change, failure, repaints } = editor.session
  const [renderFailure, setRenderFailure] = useState<{ doc: typeof doc; message: string } | null>(null)
  // Repaints without a document change render this canvas only, not the editor around it.
  const repaint = useSyncExternalStore(repaints.subscribe, repaints.get)
  // Once committed, the areas this repaint holds are no longer owed (several ticks taken in one
  // render hold what all of them owe).
  useLayoutEffect(() => repaintTaken(repaints, repaint.tick), [repaints, repaint])
  const { t } = editor
  // The engine's overlays first, the kit's decoration over them.
  const engineOverlays = tools?.decorate ?? null
  const decoration = useMemo(() => stackDecorations(stackDecorations(decorateUnder, engineOverlays), decorate), [decorate, decorateUnder, engineOverlays])
  return (
    <div className="kui-canvas-region" data-testid={testId ?? `${editor.testId}-canvas-region`}>
      {failure ? (
        <div className="kui-message" role="alert">
          <strong>{t('openFailed')}</strong>
          <span className="kui-muted">{failure}</span>
        </div>
      ) : doc ? (
        <KitCanvas
          ref={canvas}
          viewMemory={viewMemory ?? own}
          doc={doc}
          change={change}
          repaint={repaint}
          tool={tool ?? tools?.canvasTool ?? HAND_TOOL}
          decorate={decoration}
          spacePans={!tools?.wantsText}
          initialArea={initialArea}
          panBounds={panBounds}
          framed={framed}
          animated={animated || tools?.animated === true}
          wheelPan={wheelPan}
          edgeScroll={edgeScroll}
          onView={(view, stats) => {
            // Overlays sized in screen pixels follow the zoom.
            tools?.viewZoom?.(view.zoom)
            onView?.(view, stats)
          }}
          onRender={(error) => setRenderFailure(error === null ? null : { doc, message: errorText(error) })}
        >
          {children}
          {renderFailure?.doc === doc ? <RenderFailure message={renderFailure.message} title={t('renderFailed')} retryLabel={t('retryRender')} onRetry={() => { void canvas.current?.retryRender() }} /> : null}
        </KitCanvas>
      ) : (
        <div className="kui-message kui-muted">{t('opening')}</div>
      )}
      {tools ? <TextSink active={tools.wantsText} onText={tools.typeText} onKey={(event) => tools.keyDown(event)} /> : null}
    </div>
  )
}

const ZOOM_STEP = 1.25

/** A field that keeps its own keys: any input, select, or text area but the text sink. */
/** Input types that take no typed text: keys pressed on them are the editor's shortcuts. */
const KEYLESS_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])

/** Whether the target takes typed text (so the editor's shortcuts leave its keys alone). */
export function isField(target: EventTarget | null) {
  if (target instanceof HTMLInputElement) return !KEYLESS_INPUTS.has(target.type)
  return target instanceof HTMLSelectElement || (target instanceof HTMLTextAreaElement && !target.classList.contains('kui-text-sink'))
}

export type ShellProps = {
  status?: ReactNode
  statusEnd?: ReactNode
  /**
   * A click on the status bar (outside its buttons), for an editor whose status bar is one click
   * target, as a ported app's that clears its message on a click.
   */
  onStatusClick?: () => void
  canvas?: RefObject<KitCanvasHandle | null>
  /** The canvas zoom, for the status bar's zoom control. */
  zoom?: number | null
  /** The editor's own keys; return true when handled. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => boolean
  /**
   * Whether the status bar is drawn (default true). Off, the whole bar goes, like a native app's
   * View or Window toggle: `status`, the unsaved and agent-edited marks, and the zoom control;
   * Save stays enabled while there are unsaved changes.
   */
  statusBar?: boolean
  /**
   * Engine commands the kit never shows (a browser cannot run them): their shortcuts run nothing,
   * and the key goes on as if no command had it (to a tool letter; a host button's comes first).
   */
  hiddenCommands?: (command: string) => boolean
  /**
   * Whether the frame asks what to do when the file changed on disk while the document has unsaved
   * edits (the session's `conflict`): keep the edits (the next save replaces the file) or load the
   * new version. Default true; a kit that asks in its own way (a merge) turns it off. Without an
   * answer every save is refused, so the person could not keep their edits.
   */
  fileChangedBar?: boolean
  /**
   * What fits the document in view, for the status bar's Fit and Cmd+0 (a pager's current page);
   * the canvas's whole document by default.
   */
  onFit?: () => void
  /**
   * The element that holds the keyboard when nothing does (a pager's pages); the frame by default.
   * A key pressed while the page's body has the keyboard (a control that let go of it, a dialog
   * closed) gives it the keyboard and the key, once; copy, cut and paste only move the keyboard
   * there, so their clipboard event follows to it.
   */
  keyboardHome?: () => HTMLElement | null
  /**
   * Who has Cmd+0, Cmd+= (Cmd++) and Cmd+-, the frame's Fit, zoom in and zoom out: `frame` (the
   * default) before any command's shortcut; `commands` the engine's command shortcuts first, so a
   * command whose shortcut is one of them runs (a sheet's Hide Columns on Cmd+0, Delete Rows on
   * Cmd+-), and the frame zooms only for a key no command has; `none` never the frame (the status
   * bar's zoom control stays). A command `hiddenCommands` hides has no key here either.
   */
  zoomKeys?: 'frame' | 'commands' | 'none'
  /**
   * What a command's `Ctrl+…` shortcut means off a Mac (`CtrlShortcuts`): `control` (the default)
   * the Control key, which no key off a Mac matches; `primary` Ctrl, the main modifier there, as
   * for `Cmd+…` (a shortcut written with Cmd wins where both match). On a Mac it is the Control key.
   */
  ctrlShortcuts?: CtrlShortcuts
  /**
   * How the parameters dialog (a command run from a menu with values to give) shows its fields:
   * the parameters' names and whether lists and objects get fields of their own
   * (`CommandDialogOptions`); by default the schema's names and one JSON text box.
   */
  commandDialog?: CommandDialogOptions
  children: ReactNode
}

/** Copy, cut and paste: the keys whose default is the clipboard event. */
const CLIPBOARD_KEYS = new Set(['c', 'x', 'v'])

/** Whether no element holds the keyboard (the page's body has it). */
function keyboardLost() {
  const active = document.activeElement
  return !active || active === document.body || active === document.documentElement || !active.isConnected
}

/**
 * Undo's and Redo's state where the frame draws them (the top bar, the Focus bar): each also
 * follows its engine command (hidden with it by the host, disabled when it is denied), and a
 * read-only document offers them only to a commenter (their own comments).
 * @internal
 */
export function useHistoryState() {
  const editor = useKitEditor()
  const ui = useUi()
  const readOnly = editor.host.readOnly === true
  const commenting = readOnly && (editor.comments?.size ?? 0) > 0
  const one = (id: 'undo' | 'redo', command: string, can: boolean) => {
    const own = ui.state(`action:${id}`)
    const engine = ui.state(`command:${command}`)
    return { hidden: own.hidden || engine.hostHidden || (readOnly && !commenting), disabled: !can || own.disabled || engine.denied }
  }
  return { undo: one('undo', 'edit.undo', editor.canUndo), redo: one('redo', 'edit.redo', editor.canRedo), readOnly, commenting }
}

/** The host's buttons, Undo, Redo, Ask Agent (when the host has an agent), the mode button, Save, and More (Customize). @internal */
export function DocumentActions({ before, mode }: { before?: ReactNode; mode?: ReactNode }) {
  const editor = useKitEditor()
  const ui = useUi()
  const { session, host, t, testId } = editor
  const { dirty } = session
  const state = (id: string) => ui.state(`action:${id}`)
  const { undo, redo, readOnly, commenting } = useHistoryState()
  return (
    <>
      {before}
      <HostButtons place="action" as="action" />
      {readOnly ? (
        <span className="kui-view-only" data-testid={`${testId}-view-only`} data-comment-only={commenting ? 'true' : undefined}>
          {t(commenting ? 'commentOnly' : 'viewOnly')}
        </span>
      ) : null}
      {undo.hidden ? null : <IconButton icon={Undo2} label={t('undo')} disabled={undo.disabled} onClick={() => void editor.run('edit.undo', {})} data-testid={`${testId}-undo`} data-kit-ui-id="action:undo" />}
      {redo.hidden ? null : <IconButton icon={Redo2} label={t('redo')} disabled={redo.disabled} onClick={() => void editor.run('edit.redo', {})} data-testid={`${testId}-redo`} data-kit-ui-id="action:redo" />}
      {host.init.capabilities.includes('agent') && !state('agent').hidden ? (
        <Button variant="ghost" disabled={state('agent').disabled} onClick={() => void host.openAgent()} data-testid={`${testId}-ask-agent`} data-kit-ui-id="action:agent">
          <Sparkles size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('askAgent')}
        </Button>
      ) : null}
      {mode}
      {state('save').hidden || readOnly ? null : (
        <Button variant="primary" disabled={!dirty || session.saving || state('save').disabled} onClick={() => void editor.save()} data-testid={`${testId}-save`} data-kit-ui-id="action:save">
          <Save size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('save')}
        </Button>
      )}
      {ui.openCustomize && !state('more').hidden ? (
        <MenuButton align="end" trigger={({ toggle, open }) => <IconButton icon={MoreHorizontal} label={t('more')} pressed={open} disabled={state('more').disabled} onClick={toggle} data-testid={`${testId}-more`} data-kit-ui-id="action:more" />}>
          <MenuItem label={t('customize')} onSelect={() => ui.openCustomize?.()} testId={`${testId}-customize`} uiId="action:more" />
        </MenuButton>
      ) : null}
    </>
  )
}

/** "Hide" at a screen point (an element's right-click), kept inside the window; Escape or a press elsewhere closes it. */
function HideMenu({ x, y, label, testId, onHide, onClose }: { x: number; y: number; label: string; testId: string; onHide: () => void; onClose: () => void }) {
  const popover = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const width = popover.current?.offsetWidth ?? 160
    const height = popover.current?.offsetHeight ?? 40
    setPosition({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) })
  }, [x, y])
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="kui-dialog-backdrop kui-hide-menu-backdrop" onPointerDown={onClose}>
      <div ref={popover} className="kui-popover kui-hide-menu" role="menu" style={position ?? { left: x, top: y, visibility: 'hidden' }} onPointerDown={(event) => event.stopPropagation()}>
        <MenuItem label={label} onSelect={onHide} testId={testId} />
      </div>
    </div>
  )
}

/** What `EditorFrame` gives the shell: its root (for the step-down's width), its modes, its density, and its own keys (Focus). @internal */
export type ShellFrameState = { ref: RefObject<HTMLDivElement | null>; mode: string; chosen: string; touch: boolean; viewOnly: boolean; keyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean; escape: () => boolean }

/**
 * What both shells share: keys, the body, the status bar with zoom, the parameters dialog, the
 * customize dialog and the Hide menu (when the host keeps personal hides and the kit declares its
 * UI), and notices. Keys go,
 * in order, to the engine's tool, the editor's own handler, the host buttons' shortcuts (so a
 * host can bind Cmd+S), Cmd+S (unless the host denies Save), zoom, the engine's command
 * shortcuts (except `hiddenCommands`'), and tool letters; none of them fire while typing in a field.
 * The frame's own key (Cmd+\) comes before all of them and works in a field too. Escape in Focus
 * comes after them: the kit's first (a tool, gesture, or selection to cancel, a field), and only
 * an Escape nothing took (left not default-prevented) leaves Focus.
 * @internal
 */
export function ShellFrame({ top, status, statusEnd, onStatusClick, canvas, zoom, onKeyDown, statusBar = true, hiddenCommands, fileChangedBar = true, onFit, keyboardHome, zoomKeys = 'frame', ctrlShortcuts = 'control', commandDialog, frame, children }: ShellProps & { top: ReactNode; frame?: ShellFrameState }) {
  const editor = useKitEditor()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const frameRoot = useRef(frame?.ref)
  frameRoot.current = frame?.ref
  // The frame's root, for the frame (`frame.ref`) and for the keyboard's safety net below.
  const setRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node
    if (frameRoot.current) frameRoot.current.current = node
  }, [])
  const home = useRef(keyboardHome)
  home.current = keyboardHome
  // The safety net (S5): a key that finds the page's body holding the keyboard goes to the
  // keyboard's home, so a way of losing the focus nobody thought of never leaves the keys dead.
  // Heard on the document as the key bubbles, after a kit's own listeners (a key one took is
  // default-prevented or stopped).
  useEffect(() => {
    const fallback = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || composingKey(event) || !keyboardLost()) return
      if (event.target !== document.body && event.target !== document.documentElement) return
      const root = rootRef.current
      if (!root?.isConnected || document.querySelector('.kui-dialog-backdrop')) return
      const target = home.current?.() ?? root
      target.focus({ preventScroll: true })
      if (document.activeElement !== target) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && CLIPBOARD_KEYS.has(event.key.toLowerCase())) return
      event.preventDefault()
      event.stopImmediatePropagation()
      target.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: event.key, code: event.code, location: event.location, repeat: event.repeat, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, bubbles: true, cancelable: true, composed: true }))
    }
    document.addEventListener('keydown', fallback)
    return () => document.removeEventListener('keydown', fallback)
  }, [])
  const tools = useKitTools()
  const { session, t, testId } = editor
  const { dirty } = session
  const outer = useContext(UiContext)
  const ui = useUi()
  /**
   * The customize dialog's elements, taken when it opens (so the dialog's tree is not rebuilt on
   * every render). A `ui/configure` that arrives while the dialog is open shows the next time it
   * opens.
   */
  const [customizing, setCustomizing] = useState<KitUiElement[] | null>(null)
  const [hideAt, setHideAt] = useState<{ id: string; x: number; y: number } | null>(null)
  const closeHide = useCallback(() => setHideAt(null), [])
  // Refs, so the context below stays the same object while strings and the catalog change.
  const keep = useRef<(hide: string[]) => Promise<void>>(async () => undefined)
  keep.current = async (hide) => {
    try {
      await ui.store.setPersonal(hide)
    } catch (error) {
      reportFailure(editor, t('customizeFailed'), error)
    }
  }
  const catalog = useRef(() => [] as KitUiElement[])
  catalog.current = () => buildCatalog({ commands: editor.commands, declaration: editor.host.declaration, engineTools: tools?.tools ?? [], agent: editor.host.init.capabilities.includes('agent'), t, phrase: editor.phrase, config: { ...ui.store.get(), personal: [] } })
  const { store } = ui
  // Customize and Hide need the host to keep personal hides and the kit to declare its UI.
  const customizable = store.customizable && editor.host.declaration !== null
  const inner = useMemo<UiContextValue | null>(
    () =>
      outer && customizable
        ? {
            ...outer,
            offerHide: (id, x, y) => setHideAt({ id, x, y }),
            openCustomize: () => setCustomizing(catalog.current()),
            hide: (id) => void keep.current([...store.get().personal, id]),
          }
        : outer,
    [customizable, outer, store],
  )

  /** A dialog's keys are its own: a modal one's all of them, a non-modal one's (`modal={false}`) those pressed in it. */
  const inDialog = (event: KeyboardEvent<HTMLDivElement>) => event.currentTarget.ownerDocument.querySelector('.kui-dialog-backdrop') != null || (event.target instanceof Element && event.target.closest('.kui-dialog') != null)

  // The frame's key (Mod+\, Focus) comes first, in the capture phase: before the text sink gives
  // the active tool its keys. Mod+\ is no editing key: Focus still toggles from a field.
  const frameKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!frame || composingKey(event.nativeEvent) || inDialog(event)) return
    if (frame.keyDown(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    editorKeyDown(event)
    // Escape after everything else had it: one the kit, its tool, a command, or a field took does
    // not leave Focus as well (pointer set: Escape cancels first).
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (frame && plain && event.key === 'Escape' && !event.defaultPrevented && !composingKey(event.nativeEvent) && !inDialog(event) && !isField(event.target) && frame.escape()) event.preventDefault()
  }

  const editorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A key of a composition is the input method's (Backspace, Enter, Escape, Space, letters):
    // no tool, kit key, host button, shortcut or command takes it.
    if (inDialog(event) || composingKey(event.nativeEvent)) return
    // The text sink gives editing keys to the tool itself; its shortcuts still come here.
    const target = event.target
    const field = isField(target)
    // A field keeps its keys, but Save is no editing key: Cmd+S saves from a field too.
    if (field && !((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's')) return
    const fromSink = target instanceof HTMLTextAreaElement
    // A key the sink already gave the tool (it prevented the default) is not a shortcut as well:
    // Delete would otherwise delete twice, once in the tool and again through a Delete command.
    if (fromSink && event.defaultPrevented) return
    // Space and Enter on a focused button or menu row press it (the keyboard's way to use a control), not an editor key.
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (plain && (event.key === ' ' || event.key === 'Enter') && target instanceof Element && target.matches('button, [role="menuitem"], input[type="checkbox"], input[type="radio"]')) return
    if (!field && !fromSink && tools?.keyDown(event)) {
      event.preventDefault()
      return
    }
    if (!field && onKeyDown?.(event)) {
      event.preventDefault()
      return
    }
    const hostButton = ui.config.add.find((item) => item.shortcut && !item.disabled && matchesShortcut(item.shortcut, event, isMac()))
    if (hostButton) {
      event.preventDefault()
      ui.press(hostButton.id)
      return
    }
    const command = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (command && key === 's') {
      event.preventDefault()
      if (!ui.state('action:save').denied && !editor.host.readOnly) void editor.save()
      return
    }
    const shortcut = commandForShortcut(hiddenCommands ? editor.commands.filter((item) => !hiddenCommands(item.id)) : editor.commands, event, isMac(), ctrlShortcuts)
    // The zoom keys are the frame's, unless the kit gives them to its commands (`zoomKeys`).
    const zoomKey = command && (key === '0' || key === '=' || key === '+' || key === '-')
    if (canvas?.current && zoomKey && (zoomKeys === 'frame' || (zoomKeys === 'commands' && !shortcut))) {
      event.preventDefault()
      if (key === '0') {
        if (onFit) onFit()
        else canvas.current.fit()
      }
      else canvas.current.zoomBy(key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP)
      return
    }
    if (shortcut && editor.enabled(shortcut.id)) {
      event.preventDefault()
      void editor.run(shortcut.id, {})
      return
    }
    // A key with Cmd or Ctrl whose command the list calls disabled while that list may be behind
    // the engine (`listBehind`: Cmd+Z right after an edit) is the engine's to decide, as a plain
    // key is below. Copy, cut and paste keep their default, the clipboard event, whatever the list.
    const clipboard = command && !event.altKey && !event.shiftKey && (key === 'c' || key === 'x' || key === 'v')
    if (shortcut && command && !clipboard && editor.enabledByEngine(shortcut.id) && editor.listBehind?.()) {
      event.preventDefault()
      void editor.runWhenEnabled(shortcut.id)
      return
    }
    // A key without Cmd or Ctrl has no default here to keep: when the list of what can run says
    // no, the engine itself answers, as that list may not have caught up with the last event yet,
    // in the order of the input (`runWhenEnabled`: the keys after it wait). A character typed into
    // the text sink stays text: decided later, it would be taken from the text and then, if the
    // engine said no, lost. A tool's own letter still picks its tool below.
    const sinkText = fromSink && event.key.length === 1 && !event.altKey
    if (shortcut && !command && !sinkText && !(event.key.length === 1 && tools?.toolForKey(event.key, event.shiftKey))) {
      event.preventDefault()
      if (editor.enabledByEngine(shortcut.id)) void editor.runWhenEnabled(shortcut.id)
      return
    }
    // A tool's own letter (V for select, L for line).
    const letter = !command && !event.altKey && event.key.length === 1 && !fromSink ? tools?.toolForKey(event.key, event.shiftKey) : null
    if (letter && !ui.state(`tool:${letter}`).denied) {
      event.preventDefault()
      tools?.select(letter)
    }
  }

  return (
    <UiProvider value={inner}>
      <div
        ref={setRoot}
        className="kui-app"
        data-mode={frame?.mode}
        data-chosen-mode={frame?.chosen}
        data-density={frame?.touch ? 'touch' : undefined}
        data-view-only={frame?.viewOnly || undefined}
        onKeyDownCapture={frameKeyDown}
        onKeyDown={keyDown}
        tabIndex={-1}
      >
        {top}
        {fileChangedBar && session.conflict && session.doc ? (
          <div className="kui-file-changed" role="alert" data-testid={`${testId}-file-changed`}>
            <span>{t('fileChanged')}</span>
            <Button variant="ghost" size="sm" onClick={() => void session.keepMine().catch((error: unknown) => reportFailure(editor, t('saveFailed'), error))} data-testid={`${testId}-keep-mine`}>
              {t('keepMine')}
            </Button>
            <Button variant="primary" size="sm" onClick={() => session.reopen()} data-testid={`${testId}-reload`}>
              {t('reloadFile')}
            </Button>
          </div>
        ) : null}
        {children}
        {statusBar ? (
          <StatusBar onClick={onStatusClick ? (event) => !(event.target instanceof Element && event.target.closest('button, input, select, [role="menuitem"]')) && onStatusClick() : undefined}>
            {status}
            {dirty ? <span data-testid={`${testId}-unsaved`}>{t('unsaved')}</span> : null}
            {session.editedBy?.by === 'agent' ? (
              <span className="kui-agent-edited" data-testid={`${testId}-agent-edited`}>
                <Sparkles size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                {t('agentEdited')}
              </span>
            ) : session.editedBy?.by === 'system' ? (
              // The host's own change: the app, named by its feature on hover.
              <span className="kui-host-edited" data-testid={`${testId}-host-edited`} title={session.editedBy.originLabel}>
                {t('hostEdited')}
              </span>
            ) : null}
            <StatusSpacer />
            {statusEnd}
            {canvas && zoom != null ? (
              <ZoomControl zoom={zoom} onZoom={(value) => canvas.current?.zoomTo(value)} onFit={() => (onFit ? onFit() : canvas.current?.fit())} labels={{ out: t('zoomOut'), in: t('zoomIn'), fit: t('fit') }} />
            ) : null}
          </StatusBar>
        ) : null}
        {editor.dialog ? (
          <CommandDialog
            key={editor.dialog.command.id}
            {...commandDialog}
            command={editor.dialog.command}
            values={editor.dialog.values}
            title={editor.phrase(editor.dialog.command.title)}
            labels={{ run: t('run'), cancel: t('cancel'), required: t('required'), more: t('moreOptions'), add: t('addItem'), remove: t('removeItem') }}
            onClose={() => editor.setDialog(null)}
            onRun={(params) => {
              const id = editor.dialog!.command.id
              editor.setDialog(null)
              void editor.run(id, params)
            }}
          />
        ) : null}
        {customizing ? (
          <CustomizeDialog
            catalog={customizing}
            personal={ui.config.personal}
            labels={{ title: t('customizeTitle'), search: t('customizeSearch'), restore: t('customizeRestore'), cancel: t('cancel'), save: t('customizeSave') }}
            onSave={(hide) => {
              setCustomizing(null)
              void keep.current(hide)
            }}
            onClose={() => setCustomizing(null)}
          />
        ) : null}
        {hideAt ? (
          <HideMenu
            x={hideAt.x}
            y={hideAt.y}
            label={t('hideElement')}
            testId={`${testId}-hide-element`}
            onHide={() => {
              setHideAt(null)
              void keep.current([...ui.store.get().personal, hideAt.id])
            }}
            onClose={closeHide}
          />
        ) : null}
        <Toaster />
      </div>
    </UiProvider>
  )
}

type MenuNode = { label: string; commands: KitCommand[]; submenus: Map<string, KitCommand[]> }

/** The engine's commands as menus: the first menu segment, then submenus by the second, in `order`; only `visible` commands. */
export function commandMenuTree(commands: readonly KitCommand[], order: readonly string[], exclude: readonly string[], visible: (command: KitCommand) => boolean = () => true) {
  const menus = new Map<string, MenuNode>()
  for (const command of commands) {
    const [top, sub] = command.menu
    if (!top || exclude.includes(command.id) || !visible(command)) continue
    const node: MenuNode = menus.get(top) ?? { label: top, commands: [], submenus: new Map() }
    if (sub) node.submenus.set(sub, [...(node.submenus.get(sub) ?? []), command])
    else node.commands.push(command)
    menus.set(top, node)
  }
  const rank = (label: string) => (order.includes(label) ? order.indexOf(label) : order.length)
  return [...menus.values()].sort((a, b) => rank(a.label) - rank(b.label))
}

/**
 * A submenu row (`menu:<path>`): its rows, then the host's buttons at `menu:<path>`, fly out beside
 * it while the pointer is over it. A submenu may hold submenus of its own, to any depth. A submenu
 * that is not a menu bar's (a panel menu's Font Size) names its own `uiId` (and `testId`), which
 * also places the host's buttons.
 */
export function SubMenu({ label, path, children, uiId, testId }: { label: string; path: string; children: ReactNode; uiId?: string; testId?: string }) {
  const id = uiId ?? `menu:${path}`
  const { phrase } = useKitEditor()
  const row = useRef<HTMLDivElement>(null)
  const item = useRef<HTMLDivElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  /** Set when the keyboard opened the submenu: its first row takes the focus. */
  const focusFirst = useRef(false)
  const open = () => {
    const box = row.current?.getBoundingClientRect()
    if (box) setAt({ left: box.right - 2, top: box.top - 4, maxHeight: Math.max(0, window.innerHeight - 16) })
  }
  /** Closes it; the focus, if it was inside, goes back to the submenu's row. */
  const close = () => {
    if (popover.current?.contains(document.activeElement)) item.current?.focus()
    setAt(null)
  }
  /**
   * Places the open flyout from its measured size: beside its row, on the right, or on the left
   * when the right has no room (it would cover its own row and menu otherwise), else as far right
   * as it fits; and moved up until its bottom is 8 px inside the window; taller than the window
   * less 16 px, it scrolls. So a long submenu low in a menu keeps its last rows reachable.
   */
  const place = useCallback(() => {
    const box = row.current?.getBoundingClientRect()
    const flyout = popover.current
    if (!box || !flyout) return
    const maxHeight = Math.max(0, window.innerHeight - 16)
    const height = Math.min(flyout.scrollHeight, maxHeight)
    const width = flyout.offsetWidth
    const right = box.right - 2
    const beside = right + width <= window.innerWidth - 4 ? right : box.left + 2 - width >= 4 ? box.left + 2 - width : right
    const left = Math.max(4, Math.min(beside, window.innerWidth - width - 4))
    const top = Math.max(8, Math.min(box.top - 4, window.innerHeight - 8 - height))
    setAt((shown) => (!shown || (shown.left === left && shown.top === top && shown.maxHeight === maxHeight) ? shown : { left, top, maxHeight }))
  }, [])
  const isOpen = at != null
  useLayoutEffect(() => {
    if (!isOpen) return undefined
    place()
    // Rows that arrive later (host buttons, a refreshed list) move it again.
    const flyout = popover.current
    if (!flyout || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => place())
    observer.observe(flyout)
    for (const child of flyout.children) observer.observe(child)
    return () => observer.disconnect()
  }, [isOpen, place])
  useLayoutEffect(() => {
    if (!at || !focusFirst.current || !popover.current) return
    focusFirst.current = false
    popover.current.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus()
  }, [at])
  return (
    <div ref={row} className="kui-submenu" onPointerEnter={open} onPointerLeave={close}>
      <div
        ref={item}
        className="kui-menu-item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={at != null}
        tabIndex={-1}
        data-kit-ui-id={id}
        data-testid={testId}
        // Right, Enter, or Space opens the submenu and moves into it.
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !['ArrowRight', 'Enter', ' '].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          focusFirst.current = true
          open()
        }}
      >
        <span style={{ width: 15 }} />
        <span>{phrase(label)}</span>
        <ChevronRight size={13} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ marginLeft: 'auto', opacity: 0.6 }} />
      </div>
      {at ? (
        <div
          ref={popover}
          className="kui-popover kui-submenu-popover"
          role="menu"
          style={{ left: at.left, top: at.top, maxHeight: at.maxHeight }}
          // Left or Escape closes just this submenu and returns to its row; Up and Down move through its rows.
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              event.stopPropagation()
              close()
            } else menuKeyDown(event, close)
          }}
        >
          {children}
          <HostButtons place={id} as="menu" />
        </div>
      ) : null}
    </div>
  )
}

/** The active tool's options under the menus: what does not fit scrolls, as the ribbon's groups do. @internal */
export function ToolOptionsBar({ children }: { children: ReactNode }) {
  const { t } = useKitEditor()
  return (
    <OverflowStrip className="kui-options-strip" panelClassName="kui-options-bar" labels={{ start: t('optionsScrollStart'), end: t('optionsScrollEnd') }} testId="options-scroll">
      {children}
    </OverflowStrip>
  )
}

export type RailTool = { id: string; label: string; icon: IconComponent; shortcut?: string | null; group?: number; section?: number }

const FLYOUT_PRESS_MS = 400

/**
 * One slot of the rail: a tool group's shown tool, and its flyout of the others. The flyout opens
 * beside the whole rail (its `rail`'s right edge), not the slot's own: in two columns, a first-column
 * slot's flyout would otherwise land on top of the second column.
 */
function RailSlot({ tools, shown, active, onSelect, rail, pressMs }: { tools: readonly RailTool[]; shown: RailTool; active: string; onSelect: (id: string) => void; rail: RefObject<HTMLDivElement | null>; pressMs: number }) {
  const { testId, t } = useKitEditor()
  const ui = useUi()
  const [flyout, setFlyout] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLSpanElement>(null)
  const press = useRef<number | null>(null)
  // Whether the press now ending opened the flyout: its release is not a click on the slot. Any
  // other press, anywhere, or the pointer leaving the slot ends it.
  const held = useRef(false)
  useEffect(() => {
    const release = () => {
      held.current = false
    }
    window.addEventListener('pointerdown', release, true)
    return () => window.removeEventListener('pointerdown', release, true)
  }, [])
  const open = () => {
    const box = button.current?.getBoundingClientRect()
    const edge = rail.current?.getBoundingClientRect().right ?? box?.right
    if (box && edge != null && tools.length > 1) setFlyout({ left: edge + 4, top: Math.min(box.top, window.innerHeight - tools.length * 30 - 16) })
  }
  useEffect(() => {
    if (!flyout) return undefined
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !document.querySelector('.kui-tool-flyout')?.contains(event.target)) setFlyout(null)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [flyout])
  const label = shown.shortcut ? `${shown.label} (${shown.shortcut})` : shown.label
  return (
    <span
      ref={button}
      className="kui-tool-slot"
      data-grouped={tools.length > 1}
      onContextMenu={(event) => {
        event.preventDefault()
        // A slot of one tool has no flyout: right-click offers Hide straight away.
        if (tools.length > 1) open()
        else ui.offerHide?.(`tool:${shown.id}`, event.clientX, event.clientY)
      }}
      onPointerDown={(event) => {
        held.current = false
        // Only the primary button opens the flyout by holding (the secondary opens it on its own).
        if (event.button !== 0) return
        press.current = window.setTimeout(() => {
          held.current = tools.length > 1
          open()
        }, pressMs)
      }}
      onPointerUp={() => press.current != null && window.clearTimeout(press.current)}
      onPointerLeave={() => {
        held.current = false
        if (press.current != null) window.clearTimeout(press.current)
      }}
    >
      <IconButton
        icon={shown.icon}
        label={label}
        pressed={tools.some((tool) => tool.id === active)}
        disabled={ui.state(`tool:${shown.id}`).disabled}
        onClick={() => {
          if (held.current) held.current = false
          else onSelect(shown.id)
        }}
        data-testid={`${testId}-tool-${shown.id}`}
        data-kit-ui-id={`tool:${shown.id}`}
      />
      {flyout ? (
        <div className="kui-popover kui-tool-flyout" role="menu" style={{ left: flyout.left, top: flyout.top }}>
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="menuitemradio"
              aria-checked={tool.id === active}
              className="kui-menu-item"
              disabled={ui.state(`tool:${tool.id}`).disabled}
              onClick={() => {
                setFlyout(null)
                onSelect(tool.id)
              }}
              data-testid={`${testId}-tool-${tool.id}`}
              data-kit-ui-id={`tool:${tool.id}`}
            >
              <tool.icon size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>{tool.label}</span>
              {tool.shortcut ? <kbd>{tool.shortcut}</kbd> : null}
            </button>
          ))}
          {ui.hide ? (
            <button
              type="button"
              role="menuitem"
              className="kui-menu-item"
              data-kit-ui-id={`tool:${shown.id}`}
              data-testid={`${testId}-tool-hide`}
              onClick={() => {
                setFlyout(null)
                ui.hide?.(`tool:${shown.id}`)
              }}
            >
              <span style={{ width: 15 }} />
              <span>{t('hideElement')}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

/** A one-column rail's content height (slots and their gaps, plus a dividing hairline per extra section) against `height` (the space the rail is given): upstream's `toolbar_needs_double`, in CSS terms. */
const RAIL_SLOT_PITCH = 30
// A divider's own box (1px line, 4px margin above and below) plus the one extra flex gap inserting it
// costs: an approximation (~11px measured from `.kui-tool-rail-divider`'s rendered box), not an exact read.
const RAIL_SECTION_GAP = 11
const RAIL_PADDING = 16

function railNeedsDouble(slots: number, sections: number, height: number) {
  return RAIL_PADDING + slots * RAIL_SLOT_PITCH + Math.max(0, sections - 1) * RAIL_SECTION_GAP > height
}

/** `items` in rows of at most `size`, keeping their order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = []
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size))
  return rows
}

/**
 * A vertical rail of tools (a drawing app's toolbox). Tools that share a `group` share one slot,
 * as in Illustrator and Photoshop: it shows the active one, else the one last active there, else
 * its first tool the host allows (upstream's `slot_tool`), and its flyout of the others opens on a
 * right-click or a long press. A slot whose tools' `section` differs from the slot before it gets a
 * hairline divider ahead of it (today's behavior when no tool sets `section`: one section, no
 * dividers). With `columns={2}` slots flow in two columns, a section's
 * slots never sharing a row with another section's; with `'auto'` (upstream's own rule), the rail
 * doubles only once one column's slots no longer fit the height its container gives it (the rail's
 * own height would change with its content, so a kit using `'auto'` must put the rail in a row that
 * itself has a settled height, as the app shell's body row does). With `onColumns` (and `columns`
 * 1 or 2), a toggle heads the rail, as Photoshop's chevrons do: it asks for the other count, which
 * the kit keeps (in its kit store, say) and passes back as `columns`; the toggle is the Kit UI
 * element `columnsUiId` (which the kit declares), so a host hides or disables it. With
 * `slotMemory={false}` a slot shows its active tool, else its first allowed one, never the one
 * last active there (an editor whose upstream draws the group's first tool). `flyoutPressMs` is
 * how long a press opens the flyout; the release of that press selects nothing.
 */
export function ToolRail({ tools, active, onSelect, columns = 1, onColumns, columnsUiId, slotMemory = true, flyoutPressMs = FLYOUT_PRESS_MS }: { tools: readonly RailTool[]; active: string; onSelect: (id: string) => void; columns?: 1 | 2 | 'auto'; onColumns?: (next: 1 | 2) => void; columnsUiId?: string; slotMemory?: boolean; flyoutPressMs?: number }) {
  const { testId, t } = useKitEditor()
  // The tool last active in each slot, however the editor chose it (the rail, a key, a menu).
  const [remembered, setRemembered] = useState<ReadonlyMap<number, string>>(new Map())
  const activeGroup = tools.find((tool) => tool.id === active)?.group
  useEffect(() => {
    if (activeGroup != null) setRemembered((previous) => (previous.get(activeGroup) === active ? previous : new Map(previous).set(activeGroup, active)))
  }, [active, activeGroup])
  const [autoDoubled, setAutoDoubled] = useState(false)
  const rail = useRef<HTMLDivElement>(null)
  const ui = useUi()
  const shownTools = tools.filter((tool) => !ui.state(`tool:${tool.id}`).hidden)
  // An active tool the host denies (now or by a later `ui/configure`) gives way to the first allowed one; one the person hid stays active.
  const replacement = ui.state(`tool:${active}`).denied ? shownTools.find((tool) => !ui.state(`tool:${tool.id}`).denied)?.id : undefined
  const latestSelect = useRef(onSelect)
  latestSelect.current = onSelect
  useLayoutEffect(() => {
    if (replacement) latestSelect.current(replacement)
  }, [replacement])
  const groups: RailTool[][] = []
  for (const tool of shownTools) {
    const last = groups.at(-1)
    if (last && tool.group != null && last[0].group === tool.group) last.push(tool)
    else groups.push([tool])
  }
  // Consecutive slots sharing a `section` (undefined counts as one section, so a rail that never sets it keeps one section and no dividers).
  const sections: RailTool[][][] = []
  for (const group of groups) {
    const last = sections.at(-1)
    if (last && last[0][0].section === group[0].section) last.push(group)
    else sections.push([group])
  }
  useEffect(() => {
    if (columns !== 'auto' || typeof ResizeObserver === 'undefined') return undefined
    const node = rail.current
    const parent = node?.parentElement
    if (!node || !parent) return undefined
    // The rail's own height can change with its content (one vs. two columns); its container's
    // does not, so that is what decides whether a column still fits. Viewport rects, not
    // `clientHeight`/`offsetTop`: the shell's rows are `position: static`, so the rail's
    // `offsetParent` is not this `parent` and the two would mix coordinate frames.
    const check = () => setAutoDoubled(railNeedsDouble(groups.length, sections.length, parent.getBoundingClientRect().bottom - node.getBoundingClientRect().top))
    // No direct call here: a ResizeObserver reports once, with the current size, right after `observe`.
    const observer = new ResizeObserver(check)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [columns, groups.length, sections.length])
  const resolvedColumns = columns === 2 || (columns === 'auto' && autoDoubled) ? 2 : 1
  const toggleState = columnsUiId ? ui.state(columnsUiId) : { hidden: false, disabled: false }
  const select = (id: string) => {
    if (ui.state(`tool:${id}`).denied) return
    onSelect(id)
  }
  const slot = (group: RailTool[]) => {
    const allowed = (tool: RailTool) => !ui.state(`tool:${tool.id}`).denied
    const last = group[0].group == null || !slotMemory ? undefined : remembered.get(group[0].group)
    const shown = group.find((tool) => tool.id === active) ?? group.find((tool) => tool.id === last && allowed(tool)) ?? group.find(allowed) ?? group[0]
    return <RailSlot key={group[0].id} tools={group} shown={shown} active={active} onSelect={select} rail={rail} pressMs={flyoutPressMs} />
  }
  return (
    <div className="kui-tool-rail" role="toolbar" aria-orientation="vertical" data-testid={`${testId}-tool-rail`} data-columns={resolvedColumns} ref={rail}>
      {onColumns && columns !== 'auto' && !toggleState.hidden ? (
        <button
          type="button"
          className="kui-tool-rail-columns"
          aria-label={t(columns === 2 ? 'railOneColumn' : 'railTwoColumns')}
          title={t(columns === 2 ? 'railOneColumn' : 'railTwoColumns')}
          disabled={toggleState.disabled}
          onClick={() => onColumns(columns === 2 ? 1 : 2)}
          data-testid={`${testId}-tool-rail-columns`}
          data-kit-ui-id={columnsUiId}
        >
          {columns === 2 ? <ChevronsLeft size={12} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <ChevronsRight size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        </button>
      ) : null}
      {sections.map((section, index) => (
        <Fragment key={section[0][0].id}>
          {index > 0 ? <div className="kui-tool-rail-divider" aria-hidden="true" /> : null}
          {resolvedColumns === 2
            ? chunk(section, 2).map((row) => (
                <div className="kui-tool-rail-row" key={row[0][0].id}>
                  {row.map(slot)}
                </div>
              ))
            : section.map(slot)}
        </Fragment>
      ))}
    </div>
  )
}

/** The engine's own tools (engine-tools capability) on a rail, translated, minus `hidden`. */
export function EngineToolRail({ hidden = [] }: { hidden?: readonly string[] }) {
  const tools = useKitTools()
  const { phrase, host } = useKitEditor()
  // A read-only document runs no engine tool (the hand stays): there is nothing to choose.
  if (!tools || host.readOnly) return null
  const items = tools.tools.filter((tool) => !hidden.includes(tool.id)).map((tool) => ({ id: tool.id, label: phrase(tool.label), icon: toolIcon(tool.icon, tool.id), shortcut: tool.shortcut, group: tool.group }))
  return <ToolRail tools={items} active={tools.active} onSelect={tools.select} />
}

/** A titled, collapsible section of a side panel (Layers, Properties, Swatches). With an `id` (`panel:<name>`) it follows the UI configuration. */
export function PanelSection({ id, title, children, defaultOpen = true, actions, testId }: { id?: string; title: string; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; testId?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  const ui = useUi()
  if (id) warnUndeclared(id, ui.declared)
  const state = id ? ui.state(id) : null
  if (state?.hidden) return null
  return (
    <section className="kui-panel-section" data-open={open} data-testid={testId} data-kit-ui-id={id}>
      <div className="kui-panel-section-header">
        <button type="button" className="kui-panel-section-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <ChevronRight size={13} strokeWidth={ICON_STROKE} aria-hidden="true" className="kui-panel-section-chevron" />
          {title}
        </button>
        <fieldset className="kui-element" disabled={state?.disabled ?? false}>
          {actions}
        </fieldset>
      </div>
      {open ? (
        <div className="kui-panel-section-body">
          <fieldset className="kui-element" disabled={state?.disabled ?? false}>
            {children}
          </fieldset>
        </div>
      ) : null}
    </section>
  )
}

/** Bytes as base64, for commands that take a file's contents (`image.insert {data}`). */
export function base64(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let text = ''
  for (let index = 0; index < view.length; index += 0x8000) text += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return btoa(text)
}

export const PICTURE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']

/**
 * Choosing a workspace file through the host (`host/pick`, then `host/read`): `can` is whether
 * the host offers it; `pick` answers the file, or null when the person cancels.
 */
export function useHostPick() {
  const editor = useKitEditor()
  const { host, t } = editor
  const can = host.init.capabilities.includes('pick-file')
  const pick = useCallback(
    async (purpose: string, accept: string[]) => {
      try {
        const path = await host.pick(purpose, accept)
        if (!path) return null
        const { bytes } = await host.files.read(path)
        return { path, name: path.split('/').pop() ?? path, bytes }
      } catch (error) {
        reportFailure(editor, t('commandFailed'), error)
        return null
      }
    },
    [editor, host, t],
  )
  return { can, pick }
}

/**
 * A query's answer (a command that reads without editing), asked again after every change:
 * `format.state` for the ribbon's toggles, `view.state` for the view's.
 */
export function useEngineQuery<R>(id: string, params: Record<string, unknown> = {}, extra: unknown = null): R | null {
  const { query, session } = useKitEditor()
  const [answer, setAnswer] = useState<R | null>(null)
  const key = JSON.stringify(params)
  useEffect(() => {
    if (!session.doc) return undefined
    let stale = false
    void query<R>(id, JSON.parse(key) as Record<string, unknown>).then((next) => {
      if (!stale) setAnswer(next)
    })
    return () => {
      stale = true
    }
  }, [extra, id, key, query, session.change.revision, session.doc])
  return answer
}

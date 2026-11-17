import { useEffect, useState } from 'react'
import { BringToFrontIcon as BringToFront, CableIcon as Cable, CircleIcon as Circle, DiamondIcon as Diamond, GroupIcon as Group, SparklesIcon as Sparkles, MinusIcon as Minus, MoveRightIcon as MoveRight, PaintBucketIcon as PaintBucket, PenLineIcon as PenLine, RectangleHorizontalIcon as RectangleHorizontal, RotateCwIcon as RotateCw, SendToBackIcon as SendToBack, ShapesIcon as Shapes, SquareIcon as Square, StarIcon as Star, TrashIcon as Trash2, TriangleIcon as Triangle, TypeIcon as Type, UngroupIcon as Ungroup, WandSparklesIcon as WandSparkles, type IconComponent } from '@kition/tessera-icons/react'
import { ColorGrid, MenuItem, MenuSeparator, RibbonButton, RibbonGroup, RibbonStack } from '@kition/tessera-ui'
import { CommandGroupButtons, RibbonMenu, useKitEditor } from './editor'

/**
 * Ribbon controls for drawing objects, shared by every kit that implements the Kit Harness
 * Protocol's `KitDrawing 1.0` (`drawing.insert`, `drawing.format`, `drawing.transform`,
 * `drawing.delete`). They hold no model of their own: every control runs an engine command, so
 * the person's edit and an agent's are the same change.
 */

/** The shapes the menu offers, by DrawingML preset name. */
export const DRAWING_SHAPES: ReadonlyArray<{ preset: string; icon: IconComponent; label: string }> = [
  { preset: 'rect', icon: Square, label: 'drawingRect' },
  { preset: 'roundRect', icon: RectangleHorizontal, label: 'drawingRoundRect' },
  { preset: 'ellipse', icon: Circle, label: 'drawingEllipse' },
  { preset: 'triangle', icon: Triangle, label: 'drawingTriangle' },
  { preset: 'diamond', icon: Diamond, label: 'drawingDiamond' },
  { preset: 'rightArrow', icon: MoveRight, label: 'drawingArrow' },
  { preset: 'star5', icon: Star, label: 'drawingStar' },
  { preset: 'line', icon: Minus, label: 'drawingLine' },
]

/** The engine commands `DrawingInsertGroup` already draws (by their English titles). */
const MERGED_TITLES = ['Shape', 'Shapes', 'Text Box', 'Textbox']

/** Outline weights in points. */
export const DRAWING_WEIGHTS = [0.5, 0.75, 1, 1.5, 2.25, 3, 4.5, 6]

/**
 * Insert › Shapes and Text Box: a new object at the kit's default place, selected. `label` names
 * the group (default Illustrations), for a kit whose own Illustrations group sits beside it.
 * `merge` takes the engine's group at that path (`"Insert/Illustrations"`) into this one, less
 * the engine's own Shapes and Text Box; leave that group out of the kit's `CommandTab` (`omit`).
 * `primary` lists the merged engine commands Single line's row shows; Shapes and Text Box always
 * show there.
 */
export function DrawingInsertGroup({ testId = 'drawing', label, merge, exclude, primary }: { testId?: string; label?: string; merge?: string; exclude?: readonly string[]; primary?: readonly string[] }) {
  const editor = useKitEditor()
  const { t } = editor
  const disabled = !editor.enabled('drawing.insert')
  const insert = (params: Record<string, unknown>) => void editor.run('drawing.insert', params)
  // A kit that draws shapes with the pointer (`draw.shape`) arms the shape for the next drag; a
  // line drawn from one shape to another glues to both. Others insert it at their default place.
  const draws = editor.byId.has('draw.shape')
  const shape = (preset: string) => (draws ? void editor.run('draw.shape', { preset }) : insert({ geometry: { preset } }))
  return (
    <RibbonGroup label={label ?? t('drawingIllustrations')} icon={Shapes}>
      <RibbonMenu icon={Shapes} label={t('drawingShapes')} size="large" disabled={disabled} testId={`${testId}-shapes`} primary>
        {DRAWING_SHAPES.map((s) => (
          <MenuItem key={s.preset} icon={s.icon} label={t(s.label)} testId={`${testId}-shape-${s.preset}`} onSelect={() => shape(s.preset)} />
        ))}
      </RibbonMenu>
      <RibbonButton icon={Type} label={t('drawingTextBox')} size="large" disabled={disabled} onClick={() => insert({ kind: 'textBox', text: '' })} data-testid={`${testId}-text-box`} primary />
      {merge ? <CommandGroupButtons path={merge} titles={MERGED_TITLES} exclude={exclude} primary={primary?.length ? primary : undefined} /> : null}
    </RibbonGroup>
  )
}

/** A colour `#RRGGBB` mixed toward white by `amount` (0 to 1). */
function tint(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * amount)
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** Shape Format › Fill › Gradient: from the colour to its light tint, as Office's variations go. */
export const DRAWING_GRADIENTS: ReadonlyArray<{ id: string; label: string; angle: number; path?: string }> = [
  { id: 'down', label: 'drawingGradientDown', angle: 90 },
  { id: 'right', label: 'drawingGradientRight', angle: 0 },
  { id: 'diagonal', label: 'drawingGradientDiagonal', angle: 45 },
  { id: 'center', label: 'drawingGradientCenter', angle: 0, path: 'circle' },
]

/** A gradient fill of `kind` from `color` (`#RRGGBB`) to its light tint. */
export function gradientFill(color: string, kind: (typeof DRAWING_GRADIENTS)[number]) {
  const light = tint(color, 0.75)
  const [from, to] = kind.path ? [light, color] : [color, light]
  return { gradient: { stops: [{ pos: 0, color: from }, { pos: 1, color: to }], angle: kind.angle, ...(kind.path ? { path: kind.path } : {}) } }
}

/** The first of `ids`' solid fill colour as `#RRGGBB`, read again after every change. */
function useFillColor(ids: readonly string[]): string | null {
  const editor = useKitEditor()
  const revision = (editor.session as { change?: { revision?: number } }).change?.revision ?? editor.session.doc?.info?.revision
  const [color, setColor] = useState<string | null>(null)
  const key = ids.join(',')
  useEffect(() => {
    if (ids.length === 0) {
      setColor(null)
      return undefined
    }
    let stale = false
    void Promise.resolve(editor.query<{ objects?: Array<{ fill?: { color?: { rgb?: string } } }> }>('drawing.describe', { ids: [ids[0]] })).then((answer) => {
      if (!stale) setColor(answer?.objects?.[0]?.fill?.color?.rgb ?? null)
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, key, revision])
  return color
}

/** Whether any of `ids` is a group, read again after every change to the document. */
function useHasGroup(ids: readonly string[]): boolean {
  const editor = useKitEditor()
  const revision = (editor.session as { change?: { revision?: number } }).change?.revision ?? editor.session.doc?.info?.revision
  const [has, setHas] = useState(false)
  const key = ids.join(',')
  useEffect(() => {
    if (ids.length === 0 || !editor.enabled('drawing.ungroup')) {
      setHas(false)
      return undefined
    }
    let stale = false
    void Promise.resolve(editor.query<{ objects?: Array<{ kind?: string }> }>('drawing.describe', { ids: [...ids] })).then((answer) => {
      if (!stale) setHas(answer?.objects?.some((o) => o.kind === 'group') ?? false)
    })
    return () => {
      stale = true
    }
    // `key` stands for `ids`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, key, revision])
  return has
}

/** Shape Format › Effects: shadows and a glow, as Office's presets go. */
export const DRAWING_SHADOWS: ReadonlyArray<{ id: string; label: string; shadow: { blur: number; distance: number; angle: number } }> = [
  { id: 'bottomRight', label: 'drawingShadowBottomRight', shadow: { blur: 4, distance: 3, angle: 45 } },
  { id: 'bottom', label: 'drawingShadowBottom', shadow: { blur: 4, distance: 3, angle: 90 } },
  { id: 'around', label: 'drawingShadowAround', shadow: { blur: 8, distance: 0, angle: 0 } },
]

/** Shape Format › Transform: WordArt's preset text warps (`KitDrawing 1.3`, DR26). */
export const DRAWING_WARPS: ReadonlyArray<{ preset: string; label: string }> = [
  { preset: 'textArchUp', label: 'drawingWarpArchUp' },
  { preset: 'textArchDown', label: 'drawingWarpArchDown' },
  { preset: 'textCircle', label: 'drawingWarpCircle' },
  { preset: 'textWave1', label: 'drawingWarpWave1' },
  { preset: 'textWave2', label: 'drawingWarpWave2' },
  { preset: 'textInflate', label: 'drawingWarpInflate' },
  { preset: 'textDeflate', label: 'drawingWarpDeflate' },
  { preset: 'textSlantUp', label: 'drawingWarpSlantUp' },
  { preset: 'textSlantDown', label: 'drawingWarpSlantDown' },
  { preset: 'textTriangle', label: 'drawingWarpTriangle' },
  { preset: 'textChevron', label: 'drawingWarpChevron' },
  { preset: 'textCurveUp', label: 'drawingWarpCurveUp' },
  { preset: 'textCurveDown', label: 'drawingWarpCurveDown' },
  { preset: 'textCanUp', label: 'drawingWarpCanUp' },
]

/**
 * Shape Format › Transform's menu: `onPick` gets a preset of [`DRAWING_WARPS`], or `null` for
 * no transform. `DrawingFormatGroup` runs `drawing.text`; a kit with its own command for the
 * selection runs that.
 */
export function DrawingWarpMenu({ disabled, testId = 'drawing', onPick }: { disabled?: boolean; testId?: string; onPick: (preset: string | null) => void }) {
  const { t } = useKitEditor()
  return (
    <RibbonMenu icon={WandSparkles} label={t('drawingTransform')} disabled={disabled} testId={`${testId}-transform`}>
      {DRAWING_WARPS.map((w) => (
        <MenuItem key={w.preset} label={t(w.label)} testId={`${testId}-warp-${w.preset}`} onSelect={() => onPick(w.preset)} />
      ))}
      <MenuSeparator />
      <MenuItem label={t('drawingNoTransform')} testId={`${testId}-no-warp`} onSelect={() => onPick(null)} />
    </RibbonMenu>
  )
}

/**
 * Shape Format for the selected objects `ids`: fill, outline colour and weight, effects, a text
 * warp (each object's own `drawing.text`), the shape's outline, where they sit in the stack (`drawing.arrange`), grouping, a quarter turn, and
 * deleting. Shown by the kit while it has drawing objects selected.
 */
export function DrawingFormatGroup({ ids, testId = 'drawing', effects = true }: { ids: readonly string[]; testId?: string; effects?: boolean }) {
  const editor = useKitEditor()
  const { t } = editor
  const disabled = ids.length === 0 || !editor.enabled('drawing.format')
  const format = (params: Record<string, unknown>) => void editor.run('drawing.format', { ids, ...params })
  const arrangeOff = ids.length === 0 || !editor.enabled('drawing.arrange')
  const arrange = (order: 'front' | 'back' | 'forward' | 'backward') => void editor.run('drawing.arrange', { ids, order })
  const hasGroup = useHasGroup(ids)
  const textOff = ids.length === 0 || !editor.enabled('drawing.text')
  const warp = (preset: string | null) => {
    for (const id of ids) void editor.run('drawing.text', { id, warp: preset })
  }
  // Gradients take the shape's own colour, else the project's purple.
  const base = useFillColor(ids) ?? '#5645D4'
  return (
    <>
      <RibbonGroup label={t('drawingShapeStyles')} icon={PaintBucket}>
        <RibbonStack>
          <RibbonMenu icon={PaintBucket} label={t('drawingFill')} disabled={disabled} testId={`${testId}-fill`} primary>
            <ColorGrid onPick={(color) => format({ fill: { color } })} testId={`${testId}-fill-colors`} />
            <MenuSeparator />
            {DRAWING_GRADIENTS.map((kind) => (
              <MenuItem key={kind.id} label={t(kind.label)} testId={`${testId}-gradient-${kind.id}`} onSelect={() => format({ fill: gradientFill(base, kind) })} />
            ))}
            <MenuSeparator />
            <MenuItem label={t('drawingNoFill')} testId={`${testId}-no-fill`} onSelect={() => format({ fill: { none: true } })} />
          </RibbonMenu>
          {effects ? (
            <RibbonMenu icon={Sparkles} label={t('drawingEffects')} disabled={disabled} testId={`${testId}-effects`}>
              {DRAWING_SHADOWS.map((p) => (
                <MenuItem key={p.id} label={t(p.label)} testId={`${testId}-shadow-${p.id}`} onSelect={() => format({ effects: { shadow: { color: { rgb: '#000000', alpha: 0.4 }, ...p.shadow } } })} />
              ))}
              <MenuItem label={t('drawingNoShadow')} testId={`${testId}-no-shadow`} onSelect={() => format({ effects: { shadow: null } })} />
              <MenuSeparator />
              <MenuItem label={t('drawingGlow')} testId={`${testId}-glow`} onSelect={() => format({ effects: { glow: { color: { rgb: base, alpha: 0.6 }, size: 5 } } })} />
              <MenuItem label={t('drawingNoGlow')} testId={`${testId}-no-glow`} onSelect={() => format({ effects: { glow: null } })} />
            </RibbonMenu>
          ) : null}
          <DrawingWarpMenu disabled={textOff} testId={testId} onPick={warp} />
          <RibbonMenu icon={PenLine} label={t('drawingOutline')} disabled={disabled} testId={`${testId}-outline`} primary>
            <ColorGrid onPick={(color) => format({ stroke: { color } })} testId={`${testId}-outline-colors`} />
            <MenuSeparator />
            {DRAWING_WEIGHTS.map((width) => (
              <MenuItem key={width} label={t('drawingWeight', { value: width })} testId={`${testId}-weight-${width}`} onSelect={() => format({ stroke: { width } })} />
            ))}
            <MenuSeparator />
            <MenuItem label={t('drawingNoOutline')} testId={`${testId}-no-outline`} onSelect={() => format({ stroke: { none: true } })} />
          </RibbonMenu>
        </RibbonStack>
      </RibbonGroup>
      <RibbonGroup label={t('drawingArrange')} icon={BringToFront}>
        <RibbonStack>
          <RibbonMenu icon={Shapes} label={t('drawingChangeShape')} disabled={disabled} testId={`${testId}-change-shape`}>
            {DRAWING_SHAPES.map((shape) => (
              <MenuItem key={shape.preset} icon={shape.icon} label={t(shape.label)} onSelect={() => format({ geometry: { preset: shape.preset } })} />
            ))}
          </RibbonMenu>
        </RibbonStack>
        <RibbonStack>
          <RibbonMenu icon={BringToFront} label={t('drawingBringForward')} disabled={arrangeOff} testId={`${testId}-bring`} primary>
            <MenuItem label={t('drawingBringForward')} testId={`${testId}-bring-forward`} onSelect={() => arrange('forward')} />
            <MenuItem label={t('drawingBringToFront')} testId={`${testId}-bring-front`} onSelect={() => arrange('front')} />
          </RibbonMenu>
          <RibbonMenu icon={SendToBack} label={t('drawingSendBackward')} disabled={arrangeOff} testId={`${testId}-send`} primary>
            <MenuItem label={t('drawingSendBackward')} testId={`${testId}-send-backward`} onSelect={() => arrange('backward')} />
            <MenuItem label={t('drawingSendToBack')} testId={`${testId}-send-back`} onSelect={() => arrange('back')} />
          </RibbonMenu>
        </RibbonStack>
        <RibbonStack>
          <RibbonButton
            icon={Group}
            label={t('drawingGroup')}
            disabled={ids.length < 2 || !editor.enabled('drawing.group')}
            onClick={() => void editor.run('drawing.group', { ids })}
            data-testid={`${testId}-group`}
            primary
          />
          <RibbonButton
            icon={Cable}
            label={t('drawingConnect')}
            disabled={ids.length !== 2 || !editor.enabled('drawing.connect')}
            onClick={() => void editor.run('drawing.connect', { from: ids[0], to: ids[1] })}
            data-testid={`${testId}-connect`}
          />
          <RibbonButton
            icon={Ungroup}
            label={t('drawingUngroup')}
            disabled={!hasGroup}
            onClick={() => void editor.run('drawing.ungroup', { ids })}
            data-testid={`${testId}-ungroup`}
          />
          <RibbonButton
            icon={RotateCw}
            label={t('drawingRotateRight')}
            disabled={ids.length === 0 || !editor.enabled('drawing.transform')}
            onClick={() => void editor.run('drawing.transform', { ids, rotateBy: 90 })}
            data-testid={`${testId}-rotate`}
          />
          <RibbonButton
            icon={Trash2}
            label={t('drawingDelete')}
            disabled={ids.length === 0 || !editor.enabled('drawing.delete')}
            onClick={() => void editor.run('drawing.delete', { ids })}
            data-testid={`${testId}-delete`}
          />
        </RibbonStack>
      </RibbonGroup>
    </>
  )
}

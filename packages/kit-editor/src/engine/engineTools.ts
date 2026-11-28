import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KitToolMethod } from './kitEngine'
import { HAND_TOOL, type KitPointer, type KitTool, type KitToolContext } from './kitTools'
import type { RasterDecoration } from './rasterViewport'
import { drawnOnce } from './decorations'
import { drawEngineOverlays, overlaysAnimate, overlayStyle as resolveOverlayStyle, type EngineOverlay, type OverlayDrawer, type OverlayStylePatch } from './engineOverlays'
import { orderCommands, type KitChange } from './useKitDocument'

/**
 * The engine-tools capability (kit editors U8b): kits whose engine
 * owns its tools' state machines (pen, direct selection, type) expose them,
 * and this one bridge runs them. The host sends pointer, key, and text events
 * in document pixels; the engine answers with requests, overlays, and a
 * cursor, and the host draws the overlays: in Kition's style, or in the kit's own
 * (`overlayStyle`, `drawOverlay`; see `engineOverlays.ts`).
 */

/** One engine tool; tools sharing a `group` share a slot on the rail. */
export type EngineToolInfo = { id: string; label: string; shortcut: string | null; icon: string; group: number }

/** A drawing primitive over the canvas, in document pixels. */
type EngineToolOverlay = EngineOverlay

/** Something only the host can do. */
type EngineToolRequest =
  | { kind: 'dialog'; name: string; params: unknown }
  | { kind: 'switchTool'; id: string }
  | { kind: 'status'; text: string }

export type EngineToolResponse = {
  requests: EngineToolRequest[]
  overlays: EngineToolOverlay[]
  cursor: string
  busy: boolean
  wantsText: boolean
  /** The tool takes the editing keys now though neither busy nor taking text (Escape stays the editor's). */
  takesKeys?: boolean
  /** The text caret while the tool takes text, in document pixels: the hidden text field goes there. */
  caret?: EngineToolCaret
  /** The tool is locked: it stays for one object after another until Escape or another tool. */
  toolLocked?: boolean
}

/** A text caret in document pixels: its top at (`x`, `y`), `height` tall, turned `angle` degrees clockwise about its top. */
export type EngineToolCaret = { x: number; y: number; height: number; angle?: number }

/** How a tool is chosen: `locked` keeps it for one object after another (Lock Drawing Mode), when the engine keeps locks. */
export type EngineToolChoice = { locked?: boolean }

type ToolCall = <R>(name: KitToolMethod, args?: unknown[], settled?: boolean) => Promise<R | null>

type EngineToolsOptions = {
  /** Tools the host runs itself (view tools), by engine id. */
  hostTools?: Record<string, KitTool>
  /** Engine tools left off the rail. */
  hidden?: ReadonlySet<string>
  /** The tool selected when the document opens. */
  initial: string
  /**
   * Whether Escape has something for the tool to cancel now (a selection, a gesture, a shape
   * chosen to draw); read when Escape is pressed, and false gives that Escape to the frame at
   * once. Without it, the tool takes Escape whenever its last answer says it takes text or is
   * busy, and an Escape pressed while a press, a click or a tool choice is on its way is decided
   * on that answer (given back to the frame when the tool does not take it). Only a kit whose
   * tool takes text while Escape should still leave Focus (a text tool that always takes text)
   * needs it: such a tool would otherwise take every Escape (KitPointer 4.4).
   */
  escapable?: () => boolean
  /** A dialog the engine asks for; the editor opens it, or says it cannot. */
  onDialog?: (name: string, params: unknown) => void
  /**
   * A key pressed while the engine was still answering an earlier event, which turned out not
   * to be typed text: the editor handles it as it would have (a tool shortcut).
   */
  onDeferredKey?: (key: string, shift: boolean) => void
  /**
   * The kit's look for the engine's overlays: changes to Kition's style per overlay kind
   * (colours, sizes, shapes, dashes, fonts). Keep it stable (a module constant or memoized):
   * a new object redraws them.
   */
  overlayStyle?: OverlayStylePatch | null
  /**
   * Draws an overlay the kit's own way, on the overlay canvas with the current view transform;
   * returns `true` when it drew it, and kit-editor draws the others in `overlayStyle`. Keep it
   * stable, as `overlayStyle`.
   */
  drawOverlay?: OverlayDrawer | null
  /**
   * Whether every drag sample of a tool reaches the engine (a pencil's stroke keeps each point);
   * otherwise a sample waiting while the engine answers gives way to the next one. Read for each
   * sample, by engine tool id; unset, every tool's samples give way.
   */
  keepsDragSamples?: (tool: string) => boolean
  /**
   * A right-click on the canvas (on a Mac also Ctrl and a click), for a kit that opens its context
   * menu there: the engine's tool first gets it as a press and a release with `button:
   * "secondary"` (selecting what is under the pointer, as the kit decides), in the order of the
   * input; then this is called with the pointer (document pixels and client pixels) and the
   * tool's answer to the release. Without it the right button reaches no tool and does nothing.
   */
  onContextMenu?: (at: KitPointer, answer: EngineToolResponse | null) => void
}

/** Whether the host's UI configuration refuses a tool, by engine id. */
type ToolDenied = (id: string) => boolean
const NONE_DENIED: ToolDenied = () => false

/** `command` is Command or Control (either one), `control` Control itself (KitPointer 2.2). */
function mods(pointer: { shift: boolean; alt: boolean; meta: boolean; ctrl?: boolean }) {
  return { shift: pointer.shift, alt: pointer.alt, command: pointer.meta, control: pointer.ctrl === true, space: false }
}

/** The keys that are not text but wait for the engine's answer as text does (`keyDown`). */
const HELD_KEYS = new Set(['Delete', 'Backspace'])
const EDITING_KEYS = new Set(['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Home', 'End'])

/**
 * Runs a kit's engine tools in a kit editor: the rail's tools from the engine,
 * the active tool as a canvas tool, its overlays as a canvas decoration, its
 * cursor, and its keys and typed text. `tool` is the document's tool call.
 *
 * A tool the host's UI configuration denies (`tool:<id>` hidden or disabled) is never active:
 * `KitEditorProvider` gives the check (`setDenied`), and choosing the tool, the engine's
 * `switchTool` request, and `options.initial` all refuse it. When the configuration comes to
 * deny the active tool, the first allowed engine tool (outside `options.hidden`) takes its
 * place, or the hand tool when there is none.
 */
export function useEngineTools(tool: ToolCall, ready: boolean, change: KitChange, options: EngineToolsOptions) {
  const [tools, setTools] = useState<EngineToolInfo[]>([])
  const [chosen, setChosen] = useState(options.initial)
  const [denied, setDeniedState] = useState<ToolDenied>(() => NONE_DENIED)
  const [response, setResponse] = useState<EngineToolResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const latest = useRef(options)
  latest.current = options
  const latestDenied = useRef(denied)
  latestDenied.current = denied
  const nextSelection = useRef(0)
  const pendingSelection = useRef<number | null>(null)
  const [selection, setSelection] = useState(0)
  const activeChoice = useRef(options.initial)
  /** The lock asked with the last choice, sent with its `selectTool` (once). */
  const choiceLock = useRef<boolean | undefined>(undefined)
  const engineSelection = useRef<{ id: string; serial: number } | null>(null)

  // The hand tool: the kit's own host tool for it, or the shared one.
  const handId = Object.keys(options.hostTools ?? {}).find((id) => options.hostTools?.[id] === HAND_TOOL) ?? HAND_TOOL.id
  // A denied tool gives way before it is ever drawn or sent to the engine. Until the engine's
  // tools are known the hand stands in; once they are, the first allowed one is kept as chosen.
  let active = chosen
  if (denied(chosen)) {
    active = tools.find((item) => !options.hidden?.has(item.id) && !denied(item.id))?.id ?? handId
    if (tools.length && active !== chosen) setChosen(active)
  }
  // Host tools stay with the host; the shared hand stands in when the kit has none of its own.
  const hostTool = options.hostTools?.[active] ?? (active === HAND_TOOL.id && !tools.some((item) => item.id === active) ? HAND_TOOL : undefined)
  activeChoice.current = active
  const hostIds = useRef(new Set<string>())
  hostIds.current = new Set(Object.keys(options.hostTools ?? {}))
  if (!tools.some((item) => item.id === HAND_TOOL.id)) hostIds.current.add(HAND_TOOL.id)
  /** Chooses a tool, unless the host denies it. */
  const setActive = useCallback((id: string, choice?: EngineToolChoice) => {
    if (latestDenied.current(id)) return
    choiceLock.current = choice?.locked
    const serial = ++nextSelection.current
    pendingSelection.current = serial
    activeChoice.current = id
    setSelection(serial)
    setChosen(id)
  }, [])
  /** The UI configuration's check, given by `KitEditorProvider`. */
  const setDenied = useCallback((check: ToolDenied) => setDeniedState(() => check), [])
  const zoom = useRef(1)
  const last = useRef<{ x: number; y: number } | null>(null)

  // Events go to the engine one at a time and in order; while one is out, only the newest
  // drag or hover waits (the others are stale), so a slow engine never falls behind the pointer.
  // Printable keys pressed meanwhile wait in the same queue, so a fast typist's first letters
  // after the click that starts a text frame go to the text, decided when the click is answered.
  // The document's commands (a shortcut, a menu) wait there too while events do, so Cmd+B right
  // after fast Shift+Arrow keys formats the whole selection (`orderCommands`).
  const busy = useRef(false)
  // `coalesce`: a hover, a drag's move or a state query, which decides nothing (see `deciding`);
  // `keep`: one of them that the next does not replace (a pencil's drag sample).
  type Queued = { name: KitToolMethod; args: unknown[]; settled: boolean; coalesce: boolean; keep?: boolean; selection?: number } | HeldKey | { work: () => Promise<void> }
  const queue = useRef<Queued[]>([])
  /** The event whose answer is on its way now. */
  const sending = useRef<Queued | null>(null)
  const latestResponse = useRef<EngineToolResponse | null>(null)
  // Whether the editor is still mounted: an engine answer that arrives after it closed (a queued
  // event's reply) sets no state, which React would read `window.event` for after the page, or a
  // test's DOM, is gone.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const answer = useCallback((next: EngineToolResponse | null, selection?: number) => {
    if (!next || !mounted.current) return
    latestResponse.current = next
    setResponse(next)
    let switchTo: string | null = null
    for (const request of next.requests) {
      if (request.kind === 'switchTool') {
        // A late command/hover reply must not replace a newer toolbar choice. The selected
        // tool's own answer can switch tools; later engine events can again do so normally.
        if ((pendingSelection.current === null || selection === pendingSelection.current) && !latestDenied.current(request.id)) switchTo = request.id
      }
      else if (request.kind === 'status') setStatus(request.text)
      else latest.current.onDialog?.(request.name, request.params)
    }
    if (switchTo !== null && switchTo !== activeChoice.current) {
      activeChoice.current = switchTo
      engineSelection.current = { id: switchTo, serial: nextSelection.current }
      // A switch belongs to the event that requested it. Acknowledging it from a React
      // effect would put it behind newer commands and could cancel the next command.
      if (!hostIds.current.has(switchTo)) {
        queue.current.unshift({ name: 'selectTool', args: [switchTo, zoom.current], settled: true, coalesce: false, selection })
      }
      setChosen(switchTo)
    }
  }, [])

  // A key held back while the engine answered an earlier event, which was not typed text: it goes
  // to the page again so the editor's shortcuts get it, as they would have at once.
  // What the replayed key sends (the tool's key, a shortcut's command) takes the key's place at the
  // head of the queue, before the keys typed after it: appended, a held Backspace would reach the
  // engine after the text typed behind it ("Ship", four Backspaces, "Launch" saved "ShipLa").
  const replaying = useRef(false)
  const replayAt = useRef<number | null>(null)
  const replayKey = useCallback((held: HeldKey) => {
    replaying.current = true
    replayAt.current = 0
    try {
      givenBackTo(held).dispatchEvent(new KeyboardEvent('keydown', { key: held.key, code: keyCode(held.key), shiftKey: held.shift, bubbles: true, cancelable: true }))
    } finally {
      replaying.current = false
      replayAt.current = null
    }
  }, [])
  /** Queues `item`: in the replayed key's place while one is given back, else last. */
  const enqueue = useCallback((item: Queued) => {
    if (replayAt.current === null) queue.current.push(item)
    else queue.current.splice(replayAt.current++, 0, item)
  }, [])

  const pump = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        sending.current = next
        if ('work' in next) {
          await next.work()
          continue
        }
        if ('key' in next) {
          // A held Delete or Backspace goes to the page again: its shortcut, or the tool's text, take it there.
          if (next.key.length > 1) replayKey(next)
          else if (latestResponse.current?.wantsText) answer(await tool<EngineToolResponse>('toolText', [next.key, zoom.current], true).catch(() => null))
          else if (latest.current.onDeferredKey) latest.current.onDeferredKey(next.key, next.shift)
          else replayKey(next)
          continue
        }
        answer(await tool<EngineToolResponse>(next.name, next.args, next.settled).catch(() => null), next.selection)
        if (next.selection === pendingSelection.current) pendingSelection.current = null
      }
    } finally {
      sending.current = null
      busy.current = false
    }
  }, [answer, replayKey, tool])

  /**
   * Whether an answer on its way can change which keys the tool takes: a press, a release, a
   * click, a tool choice, a key or text sent to the tool, or a key held before (which keeps its
   * place). A hover, a drag's move and a state query (a resize, a zoom, a change) cannot, nor can
   * a command, whose change the tool is asked about afterwards.
   */
  const deciding = useCallback(() => {
    const decides = (item: Queued | null) => item != null && ('key' in item || ('name' in item && !item.coalesce))
    return decides(sending.current) || queue.current.some(decides)
  }, [])

  const send = useCallback((name: KitToolMethod, args: unknown[], settled: boolean, coalesce = false, selection?: number, keep = false) => {
    const tail = queue.current[queue.current.length - 1]
    if (coalesce && !keep && replayAt.current === null && tail && 'name' in tail && tail.coalesce && !tail.keep && tail.name === name) queue.current[queue.current.length - 1] = { name, args, settled, coalesce, selection }
    else enqueue({ name, args, settled, coalesce, selection, ...(keep ? { keep } : {}) })
    void pump()
  }, [enqueue, pump])

  /**
   * Runs a command after the events still waiting; at once when none are. A `hold` (a decision
   * that needs engine answers, `inOrder`) always takes the queue, so what comes after it waits.
   */
  const ordered = useCallback(<T,>(work: () => Promise<T>, hold = false): Promise<T> => {
    if (!hold && !busy.current && !queue.current.length) return work()
    return new Promise<T>((resolve, reject) => {
      enqueue({ work: () => work().then(resolve, reject) })
      void pump()
    })
  }, [enqueue, pump])
  useEffect(() => orderCommands(tool, ordered), [ordered, tool])

  useEffect(() => {
    if (!ready) return
    void tool<EngineToolInfo[]>('tools').then((list) => {
      if (mounted.current) setTools(list ?? [])
    })
  }, [ready, tool])

  // The chosen tool goes to the engine.
  const hostActive = Boolean(hostTool)
  useEffect(() => {
    if (!ready) {
      engineSelection.current = null
      return
    }
    if (hostActive) return
    const acknowledged = engineSelection.current
    engineSelection.current = null
    if (acknowledged?.id === active && acknowledged.serial === selection) return
    const locked = choiceLock.current
    choiceLock.current = undefined
    send('selectTool', locked === undefined ? [active, zoom.current] : [active, zoom.current, locked], true, false, selection)
  }, [active, hostActive, ready, selection, send])

  // After any change (an undo, a menu command) the overlays follow the selection. Not after each
  // step of a drag (`change.gesture`): its own answers carry them, and the release asks once.
  useEffect(() => {
    if (!ready || hostActive || change.gesture) return
    const at = last.current ?? { x: 0, y: 0 }
    send('toolState', [at.x, at.y, '{}', zoom.current], false, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change
  }, [change.revision, ready])

  const pointer = useCallback((action: string, at: KitPointer, viewZoom: number, settled: boolean, coalesce = false, keep = false) => {
    zoom.current = viewZoom
    last.current = { x: at.x, y: at.y }
    // A press carries its click count (`clicks`, KitPointer PT14); the canvas gives it.
    const clicks = action === 'down' && at.clicks ? { clicks: at.clicks } : {}
    send('pointer', [JSON.stringify({ action, x: at.x, y: at.y, mods: mods(at), pressure: at.pressure, zoom: viewZoom, ...clicks })], settled, coalesce, undefined, keep)
  }, [send])

  const contextMenus = options.onContextMenu != null
  const canvasTool = useMemo<KitTool>(() => hostTool ?? {
    id: active,
    cursor: response?.cursor || 'default',
    begin: (start, { viewport }) => {
      pointer('down', start, viewport.view.zoom, false)
      return {
        move: (at, context) => pointer('drag', at, context.viewport.view.zoom, false, true, latest.current.keepsDragSamples?.(active) === true),
        end: (at, context) => pointer('up', at, context.viewport.view.zoom, true),
        // An interrupted pointer must not commit the press as a click. Keep cancellation
        // in the same queue as its pending press/moves and the person's next gesture.
        cancel: (context) => send('toolKey', ['Escape', '{}', context.viewport.view.zoom], true),
      }
    },
    hover: (at, { viewport }) => pointer('move', at, viewport.view.zoom, false, true),
    // The pointer left the canvas with no gesture held: hover feedback (a measurement shown while
    // Alt is held) goes. A kit without `pointerLeft` answers nothing.
    leave: ({ viewport }) => send('pointerLeft', [viewport.view.zoom], false, true),
    doubleClick: (at, { viewport }) => pointer('doubleClick', at, viewport.view.zoom, true),
    ...(contextMenus
      ? {
          // A right-click: a press and a release of the secondary button, then the kit's menu once
          // the release is answered, all in the order of the input.
          contextMenu: (at: KitPointer, { viewport }: KitToolContext) => {
            const viewZoom = viewport.view.zoom
            zoom.current = viewZoom
            last.current = { x: at.x, y: at.y }
            const event = (action: 'down' | 'up') => JSON.stringify({ action, x: at.x, y: at.y, mods: mods(at), pressure: 1, zoom: viewZoom, button: 'secondary', ...(action === 'down' ? { clicks: 1 } : {}) })
            enqueue({ name: 'pointer', args: [event('down')], settled: false, coalesce: false })
            enqueue({ name: 'pointer', args: [event('up')], settled: true, coalesce: false })
            enqueue({ work: async () => latest.current.onContextMenu?.(at, latestResponse.current) })
            void pump()
          },
        }
      : {}),
  }, [active, contextMenus, enqueue, hostTool, pointer, pump, response?.cursor, send])

  const overlays = response?.overlays
  const { overlayStyle, drawOverlay } = options
  // The accent is the kit's brand (`--kit-primary`, set by `applyTheme`) unless the kit sets its own.
  const accent = useThemeAccent()
  const style = useMemo(() => {
    const resolved = resolveOverlayStyle(overlayStyle)
    return accent && !overlayStyle?.accent ? { ...resolved, accent } : resolved
  }, [accent, overlayStyle])
  // Drawn once per frame: a kit's decoration that still draws them over `KitDocumentCanvas`'s own does not draw them again.
  const decorate = useMemo(
    () => (overlays?.length && !hostTool ? drawnOnce(drawEngineOverlays(overlays, style, drawOverlay)) : null),
    [drawOverlay, hostTool, overlays, style],
  )
  // Marching ants move: the canvas redraws the overlays on a timer while they are shown, only then.
  const animated = !hostTool && overlaysAnimate(overlays)

  /**
   * Gives a key to the tool when it is mid-gesture or taking text; returns whether it did.
   * Otherwise the editor's own shortcuts get it.
   */
  const keyDown = useCallback((event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; target?: EventTarget | null }) => {
    if (hostTool) return false
    // Escape the kit says has nothing to cancel is left to the editor (Focus leaves on it).
    const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
    if (plain && event.key === 'Escape' && latest.current.escapable && !latest.current.escapable()) return false
    const command = event.metaKey || event.ctrlKey
    // Delete and Backspace wait too: a shortcut checked now would see the selection before the
    // event the engine is answering (Delete right after a marquee would find nothing to delete).
    const held = event.key.length === 1 || HELD_KEYS.has(event.key)
    if (!command && !event.altKey && held && !replaying.current && (busy.current || queue.current.length)) {
      queue.current.push({ key: event.key, shift: event.shiftKey, target: event.target ?? null })
      void pump()
      return true
    }
    // The latest answer, not the one this render saw: a held key given back as soon as the
    // release is answered comes before React renders that answer (Delete after a marquee would
    // otherwise go to the tool as the finished gesture's key, and delete nothing).
    const response = latestResponse.current
    if (response?.wantsText && !command) {
      if (event.key.length === 1) {
        send('toolText', [event.key, zoom.current], true)
        return true
      }
      if (EDITING_KEYS.has(event.key)) {
        send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: false })), zoom.current], true)
        return true
      }
    } else if ((response?.busy || (response?.takesKeys && event.key !== 'Escape')) && EDITING_KEYS.has(event.key)) {
      // Cmd and Ctrl apart: `command` is either, `control` Ctrl itself (a Mac's Ctrl+Arrow is not its Cmd+Arrow).
      send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: command, ctrl: event.ctrlKey })), zoom.current], true)
      return true
    }
    // An editing key the last answer does not take, pressed while an event that can change that
    // is on its way (the click that starts a text frame, the tool's first answer right after the
    // document opened), is decided once they are answered: decided now, Enter right after that
    // click would go nowhere. If the tool does not take it then, it is given back to the frame
    // (`replayKey`): Escape leaves Focus, the kit's handler and the shortcuts have it, once. Behind
    // a hover or a state query only (Focus resizing the canvas) it is the frame's at once. Tab
    // keeps moving focus; a control's own keys stay its own.
    if (!command && !event.altKey && !replaying.current && deciding() && EDITING_KEYS.has(event.key) && event.key !== 'Tab' && onSurface(event.target)) {
      queue.current.push({ key: event.key, shift: event.shiftKey, target: event.target ?? null })
      void pump()
      return true
    }
    return false
  }, [deciding, hostTool, pump, send])

  /** The tool a single-key shortcut picks: the next one of that shortcut when one is active. */
  const toolForKey = useCallback((key: string, shift: boolean) => {
    const wanted = (shift ? `Shift+${key}` : key).toLowerCase()
    const visible = tools.filter((item) => !latest.current.hidden?.has(item.id))
    const matches = visible.filter((item) => item.shortcut?.toLowerCase() === wanted)
    if (!matches.length) return null
    const index = matches.findIndex((item) => item.id === active)
    return matches[(index + 1) % matches.length].id
  }, [active, tools])

  /** Asks the active tool for its state again, after something outside it ran (a command line entry). */
  const refresh = useCallback(() => {
    if (hostActive) return
    const at = last.current ?? { x: 0, y: 0 }
    send('toolState', [at.x, at.y, '{}', zoom.current], false, true)
  }, [hostActive, send])

  /**
   * The view's zoom, from the canvas: when it changed, the active tool's state is asked again at
   * it, so overlays the engine sizes in screen pixels (handles kept clear of a corner, labels set
   * off from a point) follow a zoom that no pointer event carried.
   */
  const viewZoom = useCallback((next: number) => {
    if (!Number.isFinite(next) || next <= 0 || Math.abs(next - zoom.current) < 1e-9) return
    zoom.current = next
    if (!ready || hostActive || !latestResponse.current) return
    const at = last.current ?? { x: 0, y: 0 }
    send('toolState', [at.x, at.y, '{}', next], false, true)
  }, [hostActive, ready, send])

  /** Typed text for the active tool (from a focused field, so input methods compose). */
  const typeText = useCallback((text: string) => {
    if (text) send('toolText', [text, zoom.current], true)
  }, [send])

  /**
   * What an input method is composing for the active tool, and its cursor in it (characters): the
   * engine shows it at the caret (`toolPreedit`; a kit without it answers nothing); the empty text
   * ends it. A newer composition waiting replaces an older one.
   */
  const compose = useCallback((text: string, cursor: number) => {
    if (!hostTool) send('toolPreedit', [text, cursor, zoom.current], false, true)
  }, [hostTool, send])

  // The same object until one of its parts changes, so an editor that hands it on (a context's
  // value) does not render everything again for each answer that changed none of them.
  const wantsText = Boolean(response?.wantsText) && !hostTool
  /** Whether the active tool is locked (the engine's last answer). */
  const locked = Boolean(response?.toolLocked) && !hostTool
  const caret = (wantsText && validCaret(response?.caret)) || null
  return useMemo(
    () => ({ tools, active, select: setActive, setDenied, refresh, viewZoom, typeText, compose, canvasTool, decorate, animated, status, wantsText, caret, locked, keyDown, toolForKey }),
    [tools, active, setActive, setDenied, refresh, viewZoom, typeText, compose, canvasTool, decorate, animated, status, wantsText, caret, locked, keyDown, toolForKey],
  )
}

/** A caret an answer gave, when it is one (finite, with a height). */
function validCaret(caret: EngineToolCaret | undefined): EngineToolCaret | null {
  if (!caret || typeof caret !== 'object') return null
  const { x, y, height, angle = 0 } = caret
  return [x, y, height, angle].every((value) => typeof value === 'number' && Number.isFinite(value)) && height > 0 ? caret : null
}

/** A key held back until the answers on their way came, and where it was pressed. */
type HeldKey = { key: string; shift: boolean; target?: EventTarget | null }

/**
 * Where a held key is given back: where the focus is now (the text sink a click's answer focused),
 * else where it was pressed, else that place's frame (the focus fell to the page because the
 * pressed control went away), so it reaches the frame's handling as it would have at once.
 */
function givenBackTo(held: HeldKey): EventTarget {
  const focused = document.activeElement
  if (focused && focused !== document.body) return focused
  const pressed = held.target instanceof Element ? held.target : null
  if (pressed?.isConnected) return pressed
  const frame = pressed?.closest('.kui-app') ?? document.querySelector('.kui-app')
  return frame ?? focused ?? document.body
}

/**
 * Whether a key pressed on `target` is the document's: on the canvas, the text sink or the frame
 * itself rather than a control (a button, a menu) whose keys are its own. Unknown: the document's.
 */
function onSurface(target: EventTarget | null | undefined) {
  if (!(target instanceof Element)) return true
  if (target.classList.contains('kui-text-sink') || target.classList.contains('kui-app') || target === target.ownerDocument.body) return true
  return target.closest('.kui-canvas') != null
}

/** The `KeyboardEvent.code` a printable key comes from on a US layout, for replayed keys. */
export function keyCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  const named: Record<string, string> = { '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote', '\\': 'Backslash', ' ': 'Space' }
  if (EDITING_KEYS.has(key)) return key
  return named[key] ?? ''
}

/** The page's `--kit-primary` (the kit's brand, or the host's), following theme changes; `null` unset. */
export function useThemeAccent(): string | null {
  const read = () =>
    typeof document === 'undefined' ? null : getComputedStyle(document.documentElement).getPropertyValue('--kit-primary').trim() || null
  const [accent, setAccent] = useState(read)
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => setAccent(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-color-scheme', 'data-brand', 'class'] })
    setAccent(read())
    return () => observer.disconnect()
  }, [])
  return accent
}

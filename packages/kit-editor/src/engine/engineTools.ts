import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KitToolMethod } from './kitEngine'
import { HAND_TOOL, type KitPointer, type KitTool } from './kitTools'
import type { RasterDecoration } from './rasterViewport'
import { drawnOnce } from './decorations'
import { drawEngineOverlays, overlayStyle as resolveOverlayStyle, type EngineOverlay, type OverlayDrawer, type OverlayStylePatch } from './engineOverlays'
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
}

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
   * chosen to draw); read when Escape is pressed. A tool taking text otherwise takes every
   * Escape, so in Focus none would be left to leave it (KitPointer 4.4). Without it, the tool
   * takes Escape whenever it takes text or is busy.
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
}

/** Whether the host's UI configuration refuses a tool, by engine id. */
type ToolDenied = (id: string) => boolean
const NONE_DENIED: ToolDenied = () => false

function mods(pointer: { shift: boolean; alt: boolean; meta: boolean }) {
  return { shift: pointer.shift, alt: pointer.alt, command: pointer.meta, control: false, space: false }
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
  const setActive = useCallback((id: string) => {
    if (latestDenied.current(id)) return
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
  type Queued = { name: KitToolMethod; args: unknown[]; settled: boolean; coalesce: boolean; selection?: number } | { key: string; shift: boolean } | { work: () => Promise<void> }
  const queue = useRef<Queued[]>([])
  const latestResponse = useRef<EngineToolResponse | null>(null)

  const answer = useCallback((next: EngineToolResponse | null, selection?: number) => {
    if (!next) return
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
  const replayKey = useCallback((key: string, shift: boolean) => {
    const target = document.activeElement ?? document.body
    replaying.current = true
    replayAt.current = 0
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, code: keyCode(key), shiftKey: shift, bubbles: true, cancelable: true }))
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
        if ('work' in next) {
          await next.work()
          continue
        }
        if ('key' in next) {
          // A held Delete or Backspace goes to the page again: its shortcut, or the tool's text, take it there.
          if (next.key.length > 1) replayKey(next.key, next.shift)
          else if (latestResponse.current?.wantsText) answer(await tool<EngineToolResponse>('toolText', [next.key, zoom.current], true).catch(() => null))
          else if (latest.current.onDeferredKey) latest.current.onDeferredKey(next.key, next.shift)
          else replayKey(next.key, next.shift)
          continue
        }
        answer(await tool<EngineToolResponse>(next.name, next.args, next.settled).catch(() => null), next.selection)
        if (next.selection === pendingSelection.current) pendingSelection.current = null
      }
    } finally {
      busy.current = false
    }
  }, [answer, replayKey, tool])

  const send = useCallback((name: KitToolMethod, args: unknown[], settled: boolean, coalesce = false, selection?: number) => {
    const tail = queue.current[queue.current.length - 1]
    if (coalesce && replayAt.current === null && tail && 'name' in tail && tail.coalesce && tail.name === name) queue.current[queue.current.length - 1] = { name, args, settled, coalesce, selection }
    else enqueue({ name, args, settled, coalesce, selection })
    void pump()
  }, [enqueue, pump])

  /** Runs a command after the events still waiting; at once when none are. */
  const ordered = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    if (!busy.current && !queue.current.length) return work()
    return new Promise<T>((resolve, reject) => {
      enqueue({ work: () => work().then(resolve, reject) })
      void pump()
    })
  }, [enqueue, pump])
  useEffect(() => orderCommands(tool, ordered), [ordered, tool])

  useEffect(() => {
    if (!ready) return
    void tool<EngineToolInfo[]>('tools').then((list) => setTools(list ?? []))
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
    send('selectTool', [active, zoom.current], true, false, selection)
  }, [active, hostActive, ready, selection, send])

  // After any change (an undo, a menu command) the overlays follow the selection.
  useEffect(() => {
    if (!ready || hostActive) return
    const at = last.current ?? { x: 0, y: 0 }
    send('toolState', [at.x, at.y, '{}', zoom.current], false, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per change
  }, [change.revision, ready])

  const pointer = useCallback((action: string, at: KitPointer, viewZoom: number, settled: boolean, coalesce = false) => {
    zoom.current = viewZoom
    last.current = { x: at.x, y: at.y }
    send('pointer', [JSON.stringify({ action, x: at.x, y: at.y, mods: mods(at), pressure: at.pressure, zoom: viewZoom })], settled, coalesce)
  }, [send])

  const canvasTool = useMemo<KitTool>(() => hostTool ?? {
    id: active,
    cursor: response?.cursor || 'default',
    begin: (start, { viewport }) => {
      pointer('down', start, viewport.view.zoom, false)
      return {
        move: (at, context) => pointer('drag', at, context.viewport.view.zoom, false, true),
        end: (at, context) => pointer('up', at, context.viewport.view.zoom, true),
        // An interrupted pointer must not commit the press as a click. Keep cancellation
        // in the same queue as its pending press/moves and the person's next gesture.
        cancel: (context) => send('toolKey', ['Escape', '{}', context.viewport.view.zoom], true),
      }
    },
    hover: (at, { viewport }) => pointer('move', at, viewport.view.zoom, false, true),
    doubleClick: (at, { viewport }) => pointer('doubleClick', at, viewport.view.zoom, true),
  }, [active, hostTool, pointer, response?.cursor, send])

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

  /**
   * Gives a key to the tool when it is mid-gesture or taking text; returns whether it did.
   * Otherwise the editor's own shortcuts get it.
   */
  const keyDown = useCallback((event: { key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (hostTool) return false
    // Escape the kit says has nothing to cancel is left to the editor (Focus leaves on it).
    const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
    if (plain && event.key === 'Escape' && latest.current.escapable && !latest.current.escapable()) return false
    const command = event.metaKey || event.ctrlKey
    // Delete and Backspace wait too: a shortcut checked now would see the selection before the
    // event the engine is answering (Delete right after a marquee would find nothing to delete).
    const held = event.key.length === 1 || HELD_KEYS.has(event.key)
    if (!command && !event.altKey && held && !replaying.current && (busy.current || queue.current.length)) {
      queue.current.push({ key: event.key, shift: event.shiftKey })
      void pump()
      return true
    }
    // The latest answer, not the one this render saw: a held key given back as soon as the
    // release is answered comes before React renders that answer (Delete after a marquee would
    // otherwise go to the tool as the finished gesture's key, and delete nothing).
    const response = latestResponse.current
    if (!response) return false
    if (response.wantsText && !command) {
      if (event.key.length === 1) send('toolText', [event.key, zoom.current], true)
      else if (EDITING_KEYS.has(event.key)) send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: false })), zoom.current], true)
      else return false
      return true
    }
    if (response.busy && EDITING_KEYS.has(event.key)) {
      send('toolKey', [event.key, JSON.stringify(mods({ shift: event.shiftKey, alt: event.altKey, meta: command })), zoom.current], true)
      return true
    }
    return false
  }, [hostTool, pump, send])

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

  return {
    tools,
    active,
    select: setActive,
    setDenied,
    refresh,
    viewZoom,
    typeText,
    canvasTool,
    decorate,
    status,
    wantsText: Boolean(response?.wantsText) && !hostTool,
    keyDown,
    toolForKey,
  }
}

/** The `KeyboardEvent.code` a printable key comes from on a US layout, for replayed keys. */
export function keyCode(key: string) {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  const named: Record<string, string> = { '.': 'Period', ',': 'Comma', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote', '\\': 'Backslash', ' ': 'Space' }
  if (key === 'Delete' || key === 'Backspace') return key
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

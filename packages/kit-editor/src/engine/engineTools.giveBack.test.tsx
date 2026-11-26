// @vitest-environment jsdom
/**
 * A key the tool's last answer does not take, pressed while the tool's events are on their way,
 * goes where it would have gone (UI U10c): waited for only behind an event that can change what
 * the tool takes (a press, a release, a click, a tool choice), and then given back to the frame
 * once, in order; at once behind a hover or a state query (a resize, a zoom). Escape in Focus
 * leaves Focus, an arrow reaches the kit's own key handler.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useEngineTools, type EngineToolResponse } from './engineTools'
import { EditorFrame } from '../frame/EditorFrame'
import { KitEditorProvider, type KitEditor } from '../editor'
import { EMPTY_UI_CONFIG } from '../uiConfig'
import { createUiStore } from '../uiStore'
import type { KitPointer, KitToolContext } from './kitTools'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const idle: EngineToolResponse = { requests: [], overlays: [], cursor: 'default', busy: false, wantsText: false }
const text: EngineToolResponse = { ...idle, cursor: 'text', wantsText: true }
const at: KitPointer = { x: 10, y: 20, clientX: 10, clientY: 20, canvasX: 10, canvasY: 20, pressure: 1, shift: false, alt: false, meta: false }
const context = { viewport: { view: { zoom: 1 } } } as unknown as KitToolContext
const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

function fakeEditor() {
  const ui = createUiStore({ ...EMPTY_UI_CONFIG }, null, () => undefined)
  return {
    session: { doc: { info: { canUndo: false, canRedo: false, dirty: false, revision: 1 } }, dirty: false, saving: false, editedBy: null },
    host: { ui, kit: { id: 'kit.test', version: '1' }, display: 'line', readOnly: false, init: { locale: 'en-US', capabilities: [], document: { path: 'a' } }, declaration: null, peer: { handle() {} }, openAgent: vi.fn() },
    commands: [],
    canUndo: false,
    canRedo: false,
    byId: new Map(),
    enabled: () => true,
    enabledByEngine: () => true,
    runWhenEnabled: vi.fn(async () => null),
    run: vi.fn(async () => null),
    ask: vi.fn(),
    query: vi.fn(),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: (key: string) => key,
    phrase: (english: string) => english,
    testId: 'k',
  } as unknown as KitEditor
}

/** The frame around engine tools whose next answer waits for `release` once `hold` is called. */
async function mount(answer: EngineToolResponse = idle) {
  let held: (() => void) | null = null
  let hold = false
  const sent: string[] = []
  const tool = (async (name: string, args: unknown[] = []) => {
    if (name === 'tools') return [{ id: 'select', label: 'Select', group: 0, shortcut: null, icon: 'x' }]
    sent.push(name === 'pointer' ? `pointer ${JSON.parse(String(args[0])).action}` : `${name} ${String(args[0] ?? '')}`.trim())
    if (hold) {
      hold = false
      return new Promise<EngineToolResponse>((resolve) => {
        held = () => resolve(answer)
      })
    }
    return answer
  }) as Parameters<typeof useEngineTools>[0]
  const own: string[] = []
  const editor = fakeEditor()
  let tools!: ReturnType<typeof useEngineTools>
  function App() {
    tools = useEngineTools(tool, true, { revision: 0, damage: null }, { initial: 'select' })
    return (
      <KitEditorProvider editor={editor} tools={tools}>
        <EditorFrame
          tabs={[]}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return false
            own.push(event.key)
            return true
          }}
        >
          <div className="kui-canvas" />
        </EditorFrame>
      </KitEditorProvider>
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanups.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  await act(async () => root.render(<App />))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  const app = document.querySelector('.kui-app') as HTMLElement
  app.focus()
  sent.length = 0
  const key = (init: KeyboardEventInit) => act(() => void (document.activeElement ?? app).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
  return {
    app,
    sent,
    own,
    key,
    get tools() {
      return tools
    },
    /** The next event's answer waits. */
    hold: () => {
      hold = true
    },
    release: async () => {
      await act(async () => held?.())
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    },
    enterFocus: () => {
      key({ key: '\\', code: 'Backslash', metaKey: true, ctrlKey: true })
      expect(app.dataset.mode).toBe('focus')
    },
  }
}

it('leaves Focus on Escape at once while a hover is on its way, and gives an arrow to the kit at once, once', async () => {
  const kit = await mount()
  kit.enterFocus()
  kit.hold()
  act(() => kit.tools.canvasTool.hover?.(at, context))
  kit.key({ key: 'Escape' })
  expect(kit.app.dataset.mode).toBe('menus')
  kit.key({ key: 'ArrowDown' })
  expect(kit.own).toEqual(['ArrowDown'])
  await kit.release()
  expect(kit.own).toEqual(['ArrowDown'])
  expect(kit.sent).toEqual(['pointer move'])
})

it('leaves Focus on Escape at once while a state query (a resize, a zoom) is on its way', async () => {
  const kit = await mount()
  kit.enterFocus()
  kit.hold()
  act(() => kit.tools.refresh())
  kit.key({ key: 'Escape' })
  expect(kit.app.dataset.mode).toBe('menus')
  await kit.release()
  expect(kit.app.dataset.mode).toBe('menus')
})

it('gives back an Escape and an arrow pressed right after a press once its answer takes neither: Focus is left, the kit has the arrow once', async () => {
  const kit = await mount()
  kit.enterFocus()
  kit.hold()
  act(() => void kit.tools.canvasTool.begin(at, context))
  kit.key({ key: 'ArrowDown' })
  kit.key({ key: 'Escape' })
  // Decided on the press's answer: until it comes, neither has acted.
  expect(kit.own).toEqual([])
  expect(kit.app.dataset.mode).toBe('focus')
  await kit.release()
  expect(kit.own).toEqual(['ArrowDown'])
  expect(kit.app.dataset.mode).toBe('menus')
  // Given back to the frame, not to the tool.
  expect(kit.sent).toEqual(['pointer down'])
})

it('gives a held key back to the frame when the focus fell to the page before the answer came', async () => {
  const kit = await mount()
  kit.enterFocus()
  kit.hold()
  act(() => void kit.tools.canvasTool.begin(at, context))
  kit.key({ key: 'Escape' })
  // The button that had the focus went away (the Focus bar's), say.
  kit.app.blur()
  expect(document.activeElement).toBe(document.body)
  await kit.release()
  expect(kit.app.dataset.mode).toBe('menus')
})

it('gives Escape to a tool taking text while its events are on their way, and Focus stays', async () => {
  const kit = await mount(text)
  // The tool's first answer says it takes text.
  act(() => kit.tools.refresh())
  await kit.release()
  kit.enterFocus()
  kit.hold()
  act(() => kit.tools.canvasTool.hover?.(at, context))
  kit.key({ key: 'Escape' })
  await kit.release()
  expect(kit.app.dataset.mode).toBe('focus')
  expect(kit.sent.filter((item) => item.startsWith('toolKey'))).toEqual(['toolKey Escape'])
})

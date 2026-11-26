/**
 * The typing kit's editor for kit-editor's browser tests: the shared frame, session, engine tools
 * and text sink around `public/engine/typing_engine.js`, as a kit draws its editor. Its own key
 * handler takes F7 (`mark.note`) and leaves every other key to the frame, F8 (`mark.put`, the
 * engine's shortcut) among them; its Arm button runs `mark.arm`, which lets F8 run, as a click on
 * Kition Sheet's function list changes what the keys typed next do. Its Select and Text buttons
 * choose the engine's tools (Select takes no key); its key handler also takes ArrowDown, which it
 * counts in `window.__kitArrowDown`, so a test can tell an arrow the tool left to the kit from one
 * lost or handled twice.
 */
import { useMemo, useRef, type KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import {
  EditorFrame,
  KitDocumentCanvas,
  KitEditorProvider,
  connectHost,
  createKitStrings,
  defineKitUi,
  useEngineTools,
  useKitEditorState,
  useKitSession,
  type FrameTab,
  type HostConnection,
  type KitCanvasHandle,
  type KitEngineInfo,
  type KitModuleManifest,
} from '../src/index.ts'
import '../src/styles.css'

// The host page's `?hostCost=` and `?toolCost=`: milliseconds each host member and each tool event takes in the worker.
const costs = new URLSearchParams(window.parent.location.search)
const manifest: KitModuleManifest = {
  kitId: 'kit.typing',
  base: new URL('./engine/', document.baseURI).href,
  module: 'typing_engine',
  documentClass: 'TypingDocument',
  runtime: 'ts-worker',
  setup: [{ method: 'setCosts', args: [Number(costs.get('hostCost') ?? 0), Number(costs.get('toolCost') ?? 0)] }],
}

const describe = (info: KitEngineInfo) => info.inspected
const TABS: FrameTab[] = []

function App({ host }: { host: HostConnection }) {
  const t = useMemo(() => createKitStrings({}, host.init.locale), [host])
  const session = useKitSession(host, manifest, describe)
  const editor = useKitEditorState(session, host, t, 'typing')
  const tools = useEngineTools(session.tool, session.doc != null, session.change, { initial: 'text' })
  const canvas = useRef<KitCanvasHandle>(null)
  const keyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
    if (event.key === 'ArrowDown') {
      const counted = window as { __kitArrowDown?: number }
      counted.__kitArrowDown = (counted.__kitArrowDown ?? 0) + 1
      return true
    }
    if (event.key !== 'F7') return false
    void editor.run('mark.note', {})
    return true
  }
  return (
    <KitEditorProvider editor={editor} tools={tools}>
      <EditorFrame tabs={TABS} canvas={canvas} title={<span>{host.init.document.name}</span>} onKeyDown={keyDown}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }} data-tool={tools.active}>
          <KitDocumentCanvas canvas={canvas} testId="typing-canvas" />
          <button type="button" style={{ position: 'absolute', left: 8, top: 8 }} onClick={() => void editor.run('mark.arm', {})} data-testid="typing-arm">
            Arm
          </button>
          <button type="button" style={{ position: 'absolute', left: 64, top: 8 }} onClick={() => tools.select('select')} data-testid="typing-select">
            Select
          </button>
          <button type="button" style={{ position: 'absolute', left: 132, top: 8 }} onClick={() => tools.select('text')} data-testid="typing-text">
            Text
          </button>
        </div>
      </EditorFrame>
    </KitEditorProvider>
  )
}

const root = createRoot(document.getElementById('root')!)
void connectHost({ id: 'kit.typing', version: '0.1.0', capabilities: ['ai', 'replica'], ui: defineKitUi({ menus: [], tools: [], panels: [], tabs: [], groups: [], controls: [] }) }).then((host) => {
  root.render(<App host={host} />)
})

/**
 * The typing kit's editor for kit-editor's browser tests: the shared frame, session, engine tools
 * and text sink around `public/engine/typing_engine.js`, as a kit draws its editor.
 */
import { useMemo, useRef } from 'react'
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
  return (
    <KitEditorProvider editor={editor} tools={tools}>
      <EditorFrame tabs={TABS} canvas={canvas} title={<span>{host.init.document.name}</span>}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          <KitDocumentCanvas canvas={canvas} testId="typing-canvas" />
        </div>
      </EditorFrame>
    </KitEditorProvider>
  )
}

const root = createRoot(document.getElementById('root')!)
void connectHost({ id: 'kit.typing', version: '0.1.0', capabilities: ['ai'], ui: defineKitUi({ menus: [], tools: [], panels: [], tabs: [], groups: [], controls: [] }) }).then((host) => {
  root.render(<App host={host} />)
})

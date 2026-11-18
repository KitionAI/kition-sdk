// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KitDocumentCanvas, KitEditorProvider, KIT_UI_CATALOGS, type KitEditor } from './editor'
import { createUiStore } from './uiStore'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createStrings } from './strings'
import type { KitCanvasHandle } from './engine/KitCanvas'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const clearPreview = vi.fn()
beforeEach(() => {
  clearPreview.mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return this.classList.contains('kui-canvas-overlay') ? { clearRect: clearPreview } as unknown as CanvasRenderingContext2D : null
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(20)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(10)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function editorWith(doc: object) {
  const repaint = { tick: 0, damage: null }
  return {
    session: { doc, change: { revision: 0, damage: null }, failure: null, dirty: true, reopen: vi.fn(), repaints: { subscribe: () => () => undefined, get: () => repaint } },
    host: { ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined), init: { locale: 'en-US', document: { path: 'synthetic.pdf' } }, declaration: {}, peer: { handle() {} } },
    byId: new Map(),
    t: createStrings(KIT_UI_CATALOGS, 'en-US'),
    testId: 'test',
  } as unknown as KitEditor
}

const docWith = (render: () => Promise<Uint8Array>) => ({ width: 20, height: 10, info: { dirty: true, revision: 4 }, render, renderArea: render, onFonts: () => () => undefined })

it('keeps a failed live canvas and unsaved document mounted, then retries and clears the alert', async () => {
  const render = vi.fn(async () => new Uint8Array(20 * 10 * 4)).mockRejectedValueOnce(new Error('page 2: render failed'))
  const doc = docWith(render)
  const editor = editorWith(doc)
  const canvas = createRef<KitCanvasHandle>()
  await act(async () => root.render(<KitEditorProvider editor={editor}><KitDocumentCanvas canvas={canvas} /></KitEditorProvider>))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('page 2: render failed')
  const surface = host.querySelector('canvas')
  expect(surface).not.toBeNull()
  expect(clearPreview).not.toHaveBeenCalled()
  await act(async () => (host.querySelector('[role="alert"] button') as HTMLButtonElement).click())
  expect(render).toHaveBeenCalledTimes(2)
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(host.querySelector('canvas')).toBe(surface)
  expect(editor.session.doc).toBe(doc)
  expect(editor.session.dirty).toBe(true)
  expect(editor.session.reopen).not.toHaveBeenCalled()
  expect(clearPreview).toHaveBeenCalledTimes(1)
})

it('ignores a pending old document failure after its replacement renders', async () => {
  let reject!: (error: Error) => void
  const old = editorWith(docWith(() => new Promise((_resolve, no) => { reject = no })))
  const current = editorWith(docWith(async () => new Uint8Array(20 * 10 * 4)))
  const canvas = createRef<KitCanvasHandle>()
  const draw = (editor: KitEditor) => root.render(<KitEditorProvider editor={editor}><KitDocumentCanvas canvas={canvas} /></KitEditorProvider>)
  await act(async () => draw(old))
  await act(async () => draw(current))
  await act(async () => reject(new Error('obsolete document error')))
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(current.session.dirty).toBe(true)
})

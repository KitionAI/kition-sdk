// @vitest-environment jsdom
/**
 * A read-only document (`document.readOnly`) in the shared editor: editing commands are not
 * enabled and draw no dialog, a refusal says the document is view only, the top bar offers no
 * Undo, Redo, or Save, and the engine's tools give way to the hand.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KitEditorProvider, useKitEditorState, useReadOnly, type KitEditor, type KitSession, type KitTools } from './editor'
import { EditorFrame } from './frame/EditorFrame'
import { commandMenuTabs, type FrameTab } from './frame/menus'
import { Toaster } from '@kition/tessera-ui'
import { EMPTY_UI_CONFIG } from './uiConfig'
import { createUiStore } from './uiStore'
import type { HostConnection } from './host'
import type { KitCommand } from './engine/kitModule'
import { useEngineTools, type EngineToolInfo } from './engine/engineTools'
import type { KitChange } from './engine/useKitDocument'
import { readOnlyRefusal } from './useKitSession'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = (id: string, mutates: boolean, schema?: Record<string, unknown>): KitCommand => ({ id, title: id, description: null, group: id.split('.')[0], mutates, enabled: true, menu: ['Edit'], shortcut: null, schema })
const COMMANDS = [command('slide.new', true, { at: { type: 'integer', required: true } }), command('slide.go', false), command('view.zoomIn', true), command('edit.undo', false), command('comment.add', true), command('edit.redo', false)]

let container: HTMLDivElement
let roots: Root[] = []
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  roots = []
  container?.remove()
})

function render(node: ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(node))
  return root
}

const t = (key: string) => key

/** The engine's Edit menu as a tab; a read-only document shows only viewing tabs, so it is marked as one. */
const EDIT_TABS = commandMenuTabs(COMMANDS, { order: ['Edit'], view: ['Edit'] })

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function host(readOnly: boolean) {
  return {
    ui: createUiStore(EMPTY_UI_CONFIG, null, () => undefined),
    readOnly,
    kit: { id: 'kit.test', version: '1' },
    display: null,
    init: { locale: 'en-US', capabilities: [], document: { path: 'a.pptx' } },
    declaration: null,
    peer: { handle() {} },
  } as unknown as HostConnection
}

function session(run = vi.fn(async () => null), comments?: ReadonlySet<string>, history = { canUndo: true, canRedo: true }) {
  return {
    comments,
    doc: { info: { ...history, dirty: true, revision: 1 }, commands: async () => COMMANDS, disabledCommands: async () => [], execute: vi.fn(async () => '{"ok":true}') },
    change: { revision: 0, damage: null },
    dirty: true,
    saving: false,
    editedBy: null,
    run,
    save: vi.fn(async () => undefined),
  } as unknown as KitSession<unknown>
}

async function editorFor(readOnly: boolean, run?: ReturnType<typeof vi.fn>, children: ReactNode = null, comments?: ReadonlySet<string>, history?: { canUndo: boolean; canRedo: boolean }, tabs: readonly FrameTab[] = []) {
  let editor!: KitEditor
  let viewOnly: boolean | null = null
  const opened = session(run as never, comments, history)
  const connection = host(readOnly)
  function ReadsIt() {
    viewOnly = useReadOnly()
    return null
  }
  function Probe() {
    editor = useKitEditorState(opened, connection, t, 'k')
    return (
      <KitEditorProvider editor={editor}>
        <EditorFrame tabs={tabs}>
          <ReadsIt />
          {children}
        </EditorFrame>
        <Toaster />
      </KitEditorProvider>
    )
  }
  render(<Probe />)
  await act(async () => undefined)
  return { editor: () => editor, viewOnly: () => viewOnly }
}

describe('a read-only editor', () => {
  it('enables viewing commands only', async () => {
    const { editor, viewOnly } = await editorFor(true)
    expect(viewOnly()).toBe(true)
    expect(['slide.new', 'slide.go', 'view.zoomIn', 'edit.undo', 'comment.add'].map((id) => editor().enabled(id))).toEqual([false, true, true, false, false])
  })

  it("shows a viewer's edits disabled in its menus", async () => {
    await editorFor(true, undefined, null, undefined, undefined, EDIT_TABS)
    act(() => byTestId('k-menu-Edit')?.click())
    const row = document.querySelector('[data-kit-ui-id="command:slide.new"]')
    expect(row).not.toBeNull()
    expect((row as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens no dialog for an editing command and says the document is view only when it is refused', async () => {
    const run = vi.fn(async (id: string) => {
      throw readOnlyRefusal(id)
    })
    const { editor } = await editorFor(true, run)
    await act(async () => void (await editor().run('slide.new')))
    expect(editor().dialog).toBeNull()
    expect(container.textContent).toContain('viewOnlyRefused')
    expect(container.textContent).not.toContain('commandFailed')
  })

  it('answers no query that edits, without running it', async () => {
    const { editor } = await editorFor(true)
    const execute = (editor().session.doc as unknown as { execute: ReturnType<typeof vi.fn> }).execute
    expect(await editor().query('slide.new')).toBeNull()
    expect(execute).not.toHaveBeenCalled()
    expect(await editor().query('slide.go')).toEqual({ ok: true })
  })

  it('draws View only instead of Undo, Redo, and Save, and Cmd+S does not save', async () => {
    const { editor } = await editorFor(true)
    expect(byTestId('k-view-only')?.textContent).toBe('viewOnly')
    expect(byTestId('k-undo')).toBeNull()
    expect(byTestId('k-redo')).toBeNull()
    expect(byTestId('k-save')).toBeNull()
    act(() => {
      document.querySelector('.kui-app')?.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, ctrlKey: true, bubbles: true }))
    })
    expect(editor().session.save).not.toHaveBeenCalled()
  })

  it('an editable one draws Undo, Redo, and Save and no View only mark', async () => {
    const { editor, viewOnly } = await editorFor(false)
    expect(viewOnly()).toBe(false)
    expect(byTestId('k-view-only')).toBeNull()
    expect(byTestId('k-undo')).not.toBeNull()
    expect(byTestId('k-save')).not.toBeNull()
    expect(editor().enabled('slide.new')).toBe(true)
  })

  it("gives the engine's tools way to the hand", async () => {
    const info = (id: string): EngineToolInfo => ({ id, label: id, shortcut: null, icon: id, group: 0 })
    const selected: string[] = []
    const tool = vi.fn(async (name: string, args: unknown[] = []) => {
      if (name === 'tools') return [info('select'), info('text')]
      if (name === 'selectTool') selected.push(args[0] as string)
      return { requests: [], overlays: [], cursor: '', busy: false, wantsText: false }
    })
    const change: KitChange = { revision: 0, damage: null }
    let tools!: KitTools
    const opened = session()
    const connection = host(true)
    function Kit({ ready }: { ready: boolean }) {
      tools = useEngineTools(tool as never, ready, change, { initial: 'text' })
      const editor = useKitEditorState(opened, connection, t, 'k')
      return <KitEditorProvider editor={editor} tools={tools}>{null}</KitEditorProvider>
    }
    const root = render(<Kit ready={false} />)
    await act(async () => root.render(<Kit ready />))
    expect(tools.active).toBe('Hand')
    expect(tools.canvasTool.id).toBe('Hand')
    act(() => tools.select('select'))
    expect(tools.active).toBe('Hand')
    expect(selected).toEqual([])
  })
})

describe("a commenter's read-only editor", () => {
  const COMMENTS: ReadonlySet<string> = new Set(['comment.add'])

  it('enables the comment commands and the history of their comments, and no other edit', async () => {
    const { editor } = await editorFor(true, undefined, null, COMMENTS, { canUndo: true, canRedo: false })
    expect(['slide.new', 'slide.go', 'view.zoomIn', 'comment.add', 'edit.undo', 'edit.redo'].map((id) => editor().enabled(id))).toEqual([false, true, true, true, true, false])
  })

  it('hides the edits it cannot run from its menus instead of greying them, and keeps the comment commands', async () => {
    await editorFor(true, undefined, null, COMMENTS, undefined, EDIT_TABS)
    act(() => byTestId('k-menu-Edit')?.click())
    const row = (id: string) => document.querySelector(`[data-kit-ui-id="command:${id}"]`)
    expect(row('slide.new')).toBeNull()
    expect(row('comment.add')).not.toBeNull()
    expect(row('slide.go')).not.toBeNull()
    expect(row('edit.undo')).not.toBeNull()
  })

  it('draws Can comment with Undo and Redo, and no Save', async () => {
    const run = vi.fn(async () => null)
    await editorFor(true, run, null, COMMENTS, { canUndo: true, canRedo: false })
    expect(byTestId('k-view-only')?.textContent).toBe('commentOnly')
    expect(byTestId('k-view-only')?.dataset.commentOnly).toBe('true')
    expect((byTestId('k-undo') as HTMLButtonElement | null)?.disabled).toBe(false)
    expect((byTestId('k-redo') as HTMLButtonElement | null)?.disabled).toBe(true)
    expect(byTestId('k-save')).toBeNull()
    await act(async () => byTestId('k-undo')?.click())
    expect(run).toHaveBeenCalledWith('edit.undo', {})
  })

  it('says the person may only comment when an edit is refused', async () => {
    const run = vi.fn(async (id: string) => {
      throw readOnlyRefusal(id)
    })
    const { editor } = await editorFor(true, run, null, COMMENTS)
    await act(async () => void (await editor().run('edit.undo')))
    expect(container.textContent).toContain('commentOnlyRefused')
  })
})

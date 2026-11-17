// @vitest-environment jsdom
/**
 * An agent's step on the live document runs in the agent's own editor state (C3b): in one turn of
 * the worker the person's selection, part and time are put aside, the agent's are put in place and
 * the step's call context is set (KitDocument `editor_state`, `restore_editor_state`,
 * `set_context`), the command runs, the agent's state is kept for its next step, and the
 * person's is put back, so the person never sees the agent's state and the agent never yanks
 * theirs.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'
import { KitEngineRefusal } from './refusal'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

/** An engine whose editor state is a selection and a current slide, recording every call. */
function fakeDocument(hooks: 'all' | 'none' | 'null') {
  const calls: string[] = []
  const state = { selection: ['p'], slide: 1 }
  const doc = {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string) => {
      calls.push(`execute ${command} on ${state.slide} [${state.selection}]`)
      if (command === 'shape.broken') throw new Error('no such shape')
      // The command selects what it made, as editors do.
      state.selection = ['made']
      doc.revision += 1n
      return '{}'
    },
    inspect: () => JSON.stringify({ selection: state.selection, slide: state.slide }),
    commands: () => JSON.stringify([{ id: 'shape.add', title: 'Add', menu: [], shortcut: null, enabled: true, mutates: true }]),
    save: () => new Uint8Array(),
    markSaved: () => undefined,
    free: () => undefined,
    ...(hooks === 'none'
      ? {}
      : {
          editorState: () => {
            calls.push('editorState')
            return hooks === 'null' ? 'null' : JSON.stringify(state)
          },
          restoreEditorState: (saved: string) => {
            calls.push(`restore ${saved}`)
            Object.assign(state, JSON.parse(saved))
          },
          setContext: (context: string) => {
            calls.push(`setContext ${context}`)
            const set = JSON.parse(context) as { on?: string[]; part?: { slide: number } }
            if (set.part && set.part.slide > 2) throw new Error('there is no slide 3')
            if (set.part) state.slide = set.part.slide
            if (set.on) state.selection = set.on
          },
        }),
  }
  fake.doc = doc
  return { calls, state, doc }
}

const open = async () => (await handle({ method: 'open', manifest: { kitId: 'kit.test' } as KitModuleManifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null })).value as { context?: boolean }

describe('an agent step in its own editor state (C3b)', () => {
  it('passes complete private content basis to the kit after another agent changes a member', async () => {
    for (const changed of [0, 39]) {
      const { state, doc } = fakeDocument('all')
      const before = Array.from({ length: 40 }, (_, index) => ({ name: `Marker ${index}`, comment: 'Observed' }))
      const current = structuredClone(before)
      Object.assign(doc, {
        execute: () => { current[changed].comment = 'Theirs'; return '{}' },
        premiseRead: (method: string, params: string) => {
          expect(method).toBe('content')
          const ask = JSON.parse(params)
          expect(ask.before).toEqual(before)
          expect(ask.before[39].comment).toBe('Observed')
          return JSON.stringify({ changed: ask.before[ask.region].comment !== current[ask.region].comment })
        },
      })
      await open()
      await handle({ method: 'execute', command: 'marker.set', params: {}, agent: { state: null, set: null } })
      const result = await handle({ method: 'premiseRead', name: 'content', params: { id: 'A', field: '~markers', region: 0, before } })
      expect(result.value).toEqual({ changed: changed === 0 })
      expect(state).toEqual({ selection: ['p'], slide: 1 })
    }
  })

  it('finishes a closing command without reading or restoring the closed engine', async () => {
    const { doc } = fakeDocument('all')
    let closed = false
    const check = () => { if (closed) throw new Error('document already closed') }
    doc.execute = () => { closed = true; return JSON.stringify({closed:true}) }
    doc.inspect = () => { check(); return '{}' }
    Object.assign(doc, {
      editorState: () => { check(); return '{}' },
      restoreEditorState: () => check(),
    })
    await open()
    const answer = await handle({method:'execute',command:'file.close',params:{force:true},agent:{state:null,set:null}})
    expect(answer.value).toMatchObject({result:JSON.stringify({closed:true}),info:null,closed:true})
    await expect(handle({method:'execute',command:'shape.add',params:{}})).rejects.toThrow('no document is open')
  })

  it('inspects a requested part and restores the person after a successful or failed read', async () => {
    const { state, doc } = fakeDocument('all')
    doc.commands = () => JSON.stringify([{ id: 'slide.inspect', title: 'Inspect', enabled: true, mutates: false }])
    Object.assign(doc, { execute: (_command: string, params: string) => JSON.stringify({ index: JSON.parse(params).index, shapes: state.selection }) })
    await open()
    expect((await handle({ method: 'inspectAt', context: { part: { slide: 2 } }, part: 2 })).value).toEqual({
      details: { slide: 2, selection: ['p'] }, part: { index: 1, shapes: ['p'] },
    })
    expect(state).toEqual({ selection: ['p'], slide: 1 })
    Object.assign(doc, { execute: () => { throw new Error('inspection failed') } })
    await expect(handle({ method: 'inspectAt', context: { part: { slide: 2 } }, part: 2 })).rejects.toThrow('inspection failed')
    expect(state).toEqual({ selection: ['p'], slide: 1 })
    expect(doc.revision).toBe(0n)
  })

  it('evaluates kit premises at the explicit context and restores the person after success and failure', async () => {
    const { state, doc } = fakeDocument('all')
    Object.assign(doc, {
      premiseRead: (method: string, params: string) => {
        expect(method).toBe('under')
        expect(JSON.parse(params)).toMatchObject({ command: 'shape.text' })
        expect(state).toEqual({ selection: ['agent'], slide: 2 })
        return JSON.stringify({ objects: ['agent'], premises: [{ id: 'agent', fields: ['text'] }] })
      },
    })
    expect((await open()) as object).toHaveProperty('premises', true)
    const params = { command: 'shape.text', params: {}, on: ['agent'], part: { slide: 2 } }
    expect((await handle({ method: 'premiseRead', name: 'under', params })).value).toEqual({ objects: ['agent'], premises: [{ id: 'agent', fields: ['text'] }] })
    expect(state).toEqual({ selection: ['p'], slide: 1 })
    expect(doc.revision).toBe(0n)
    Object.assign(doc, { premiseRead: () => { throw new Error('cannot determine coverage') } })
    await expect(handle({ method: 'premiseRead', name: 'covered', params })).rejects.toThrow('cannot determine coverage')
    expect(state).toEqual({ selection: ['p'], slide: 1 })
    expect(doc.revision).toBe(0n)
  })

  it('refuses unavailable premise callbacks and contexts without executing a command', async () => {
    const { calls, doc } = fakeDocument('none')
    await open()
    await expect(handle({ method: 'premiseRead', name: 'under', params: {} })).rejects.toThrow('cannot answer premise reads')
    Object.assign(doc, { premiseRead: () => '{"objects":[]}' })
    await expect(handle({ method: 'premiseRead', name: 'under', params: { on: ['agent'] } })).rejects.toThrow('cannot isolate')
    expect(calls).toEqual([])
  })

  it('tells the page the engine can hold one only when it keeps editor state and takes a call context', async () => {
    fakeDocument('all')
    expect((await open()).context).toBe(true)
    fakeDocument('none')
    expect((await open()).context).toBeUndefined()
    fakeDocument('null')
    expect((await open()).context).toBeUndefined()
  })

  it("puts the person's state aside, runs the step in the agent's with its context, keeps the agent's and puts the person's back", async () => {
    const { calls, state } = fakeDocument('all')
    await open()
    calls.length = 0
    const first = (await handle({ method: 'execute', command: 'shape.add', params: {}, agent: { state: null, set: { part: { slide: 2 } } } })).value as { state: string | null }
    // The person's slide and selection, untouched.
    expect(state).toEqual({ selection: ['p'], slide: 1 })
    expect(first.state).toBe(JSON.stringify({ selection: ['made'], slide: 2 }))
    expect(calls).toEqual([
      'editorState',
      'setContext {"part":{"slide":2}}',
      'execute shape.add on 2 [p]',
      'editorState',
      `restore ${JSON.stringify({ selection: ['p'], slide: 1 })}`,
    ])
    // The next step starts where the agent's last left off, not where the person is.
    calls.length = 0
    const second = (await handle({ method: 'execute', command: 'shape.add', params: {}, agent: { state: first.state, set: { on: ['s2'] } } })).value as { state: string | null }
    expect(calls).toEqual([
      'editorState',
      `restore ${first.state}`,
      'setContext {"on":["s2"]}',
      'execute shape.add on 2 [s2]',
      'editorState',
      `restore ${JSON.stringify({ selection: ['p'], slide: 1 })}`,
    ])
    expect(JSON.parse(second.state!)).toEqual({ selection: ['made'], slide: 2 })
    expect(state).toEqual({ selection: ['p'], slide: 1 })
  })

  it("refuses a context the kit cannot set as unsupported, runs nothing, and leaves the person's state", async () => {
    const { calls, state } = fakeDocument('all')
    await open()
    calls.length = 0
    const failure = await handle({ method: 'execute', command: 'shape.add', params: {}, agent: { state: null, set: { part: { slide: 3 } } } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitEngineRefusal)
    expect((failure as KitEngineRefusal).reason).toBe('unsupported')
    expect((failure as Error).message).toBe('the kit could not set `part`: there is no slide 3')
    expect(calls.some((call) => call.startsWith('execute'))).toBe(false)
    expect(state).toEqual({ selection: ['p'], slide: 1 })
  })

  it("puts the person's state back when the command fails", async () => {
    const { state } = fakeDocument('all')
    await open()
    const failure = await handle({ method: 'execute', command: 'shape.broken', params: {}, agent: { state: null, set: { part: { slide: 2 } } } }).catch((error: unknown) => error)
    expect((failure as Error).message).toBe('no such shape')
    expect(state).toEqual({ selection: ['p'], slide: 1 })
  })

  it('refuses an agent state on an engine that holds none, running nothing', async () => {
    const { calls } = fakeDocument('none')
    await open()
    const failure = await handle({ method: 'execute', command: 'shape.add', params: {}, agent: { state: null, set: null } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitEngineRefusal)
    expect((failure as Error).message).toContain('keeps no editor state')
    expect(calls).toEqual([])
  })
})

// @vitest-environment jsdom
/**
 * The engine worker runs a command as the origin the editor gives (an `ai/run` step runs as the
 * agent, KitModel M12a) when the engine runs commands as an origin, and as the host's person
 * otherwise.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KitModuleManifest } from './kitModule'
import { KitEngineRefusal, KitParamsError } from './refusal'

const fake = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('./kitModule', async (actual) => ({
  ...(await actual<typeof import('./kitModule')>()),
  loadKitModule: async () => ({}),
  openKitModuleDocument: () => fake.doc,
}))

const { handle } = await import('./kitEngine.worker')

function fakeDocument(withExecuteAs: boolean) {
  const calls: Array<[string, string, string | null]> = []
  fake.doc = {
    width: 1,
    height: 1,
    revision: 0n,
    dirty: false,
    render: () => new Uint8Array(),
    renderArea: () => new Uint8Array(),
    execute: (command: string, params: string) => {
      calls.push([command, params, null])
      return '{}'
    },
    ...(withExecuteAs
      ? {
          executeAs: (command: string, params: string, origin: string) => {
            calls.push([command, params, origin])
            return '{}'
          },
        }
      : {}),
    inspect: () => '{}',
    commands: () => JSON.stringify([{ id: 'edit.thing', title: 'Thing', menu: [], shortcut: null, enabled: true, mutates: true }]),
    save: () => new Uint8Array(),
    markSaved: () => undefined,
    free: () => undefined,
  }
  return calls
}

const open = () => handle({ method: 'open', manifest: { kitId: 'kit.test' } as KitModuleManifest, name: 'a.kit', bytes: new ArrayBuffer(1), lent: null })
const agent = { kind: 'agent', principal: 'user:test', label: 'ai/run' } as const
const system = { kind: 'system', principal: 'kdm', label: 'emailsync' } as const

describe('the engine worker running a command as an origin', () => {
  it('runs it as the origin given, in the engine’s form, and as the person when none is given', async () => {
    const calls = fakeDocument(true)
    await open()
    await handle({ method: 'execute', command: 'edit.thing', params: { a: 1 }, origin: agent })
    await handle({ method: 'execute', command: 'edit.thing', params: {} })
    expect(calls).toEqual([
      ['edit.thing', '{"a":1}', '["agent","user:test","ai/run"]'],
      ['edit.thing', '{}', null],
    ])
  })

  it('runs it as the host’s person on an engine that cannot take an origin', async () => {
    const calls = fakeDocument(false)
    await open()
    await handle({ method: 'execute', command: 'edit.thing', params: {}, origin: agent })
    expect(calls).toEqual([['edit.thing', '{}', null]])
  })

  it('runs a host’s change as the system origin with its label, and refuses it on an engine that cannot keep it out of the undo history', async () => {
    const calls = fakeDocument(true)
    await open()
    await handle({ method: 'execute', command: 'edit.thing', params: { a: 1 }, origin: system })
    expect(calls).toEqual([['edit.thing', '{"a":1}', '["system","kdm","emailsync"]']])

    const plain = fakeDocument(false)
    await open()
    const failure = await handle({ method: 'execute', command: 'edit.thing', params: {}, origin: system }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitEngineRefusal)
    expect(failure).toMatchObject({ reason: 'unsupported' })
    expect(plain).toEqual([])
  })

  it('answers an engine’s refusal of the parameters (kition_kit::schema::refusal) as its text and its errors', async () => {
    const errors = [{ path: '/values/Nmae', message: '`values` names no field `Nmae`', expected: 'a field of the table' }]
    fakeDocument(true)
    ;(fake.doc as { executeAs: unknown }).executeAs = () => {
      throw new Error(`${errors[0].message}\u001e${JSON.stringify(errors)}`)
    }
    await open()
    const failure = await handle({ method: 'execute', command: 'edit.thing', params: {}, origin: agent }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(KitParamsError)
    expect((failure as KitParamsError).message).toBe('`values` names no field `Nmae`')
    expect((failure as KitParamsError).errors).toEqual(errors)
    // Any other failure keeps its message.
    ;(fake.doc as { executeAs: unknown }).executeAs = () => {
      throw new Error('no such layer')
    }
    const other = await handle({ method: 'execute', command: 'edit.thing', params: {}, origin: agent }).catch((error: unknown) => error)
    expect(other).not.toBeInstanceOf(KitParamsError)
    expect((other as Error).message).toBe('no such layer')
  })

  it('tells the page whether the agent has an undo scope of its own (C3b): only an engine that runs commands as an origin', async () => {
    fakeDocument(true)
    expect(((await open()).value as { origins?: boolean }).origins).toBe(true)
    fakeDocument(false)
    expect(((await open()).value as { origins?: boolean }).origins).toBeUndefined()
  })
})

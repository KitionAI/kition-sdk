import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, person, randomActor, Replica, system, Version } from '@kition/kdm'
import { WorkerRelay, type EngineReplica } from './workerRelay'

const schema = parseSchema({ kdm: 1, kit: 'kit.relay-test', schemaVersion: 1, root: 'Note', types: { Note: { fields: { body: { kind: 'text' } } } } })
const NOTE = 'note'
const me = person('user:local')

/** A replica as an engine creates one: the `Note` object at its fixed id, holding `text`. */
function engineReplica(text: string) {
  return Replica.createWith(schema, newDocId(), randomActor(), system('import'), (tx) => {
    tx.create('Note', {}, { id: NOTE })
    tx.textInsert(NOTE, 'body', 0, text)
  }).replica
}

const body = (replica: Replica) => replica.text(NOTE, 'body')

/** Appends `text` to the body in one person transaction. */
function append(replica: Replica, text: string) {
  replica.transact(me, (tx) => tx.textInsert(NOTE, 'body', tx.text(NOTE, 'body').length, text))
}

/** The engine's replica behind the worker interface; `exportChanges` waits for `release()` when held. */
function heldEngine(engine: Replica) {
  let hold: Promise<void> | null = null
  let release = () => {}
  const port: EngineReplica = {
    exportChanges: async (since) => {
      if (hold) await hold
      const changes = engine.exportChanges(Version.decode(new Uint8Array(since)))
      return { changes: changes.slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0) }
    },
    importChanges: async (changes) => engine.importChanges(new Uint8Array(changes)),
  }
  return {
    port,
    holdNextExport: () => {
      hold = new Promise((resolve) => {
        release = () => {
          hold = null
          resolve()
        }
      })
    },
    release: () => release(),
  }
}

const fail = (error: unknown) => {
  throw error
}

describe('WorkerRelay', () => {
  it('sends the page’s edits to the engine and brings the engine’s to the page', async () => {
    const engine = engineReplica('# Plan\n')
    const page = Replica.load(schema, engine.snapshot(), randomActor())
    let pulls = 0
    const relay = new WorkerRelay(page, heldEngine(engine).port, { report: fail, pulled: () => (pulls += 1) })

    append(page, 'Typed.\n')
    relay.push()
    await relay.settled()
    expect(body(engine)).toBe('# Plan\nTyped.\n')

    append(engine, 'From the engine.\n')
    relay.pull()
    await relay.settled()
    expect(body(page)).toBe('# Plan\nTyped.\nFrom the engine.\n')
    expect(pulls).toBe(1)

    // Nothing new: no call.
    relay.pull()
    await relay.settled()
    expect(pulls).toBe(1)
  })

  // Kition 8442002e: the relay read the page's version before awaiting the worker, so an edit
  // typed while a pull waited was taken as the worker's and never sent (lost in WebKit every time).
  it('sends the engine an edit made while a pull is waiting for the engine', async () => {
    const engine = engineReplica('# Plan\n\nGoals.\n')
    const page = Replica.load(schema, engine.snapshot(), randomActor())
    const held = heldEngine(engine)
    const relay = new WorkerRelay(page, held.port, { report: fail })

    // The engine changes elsewhere (a co-editor, an engine command), so the page pulls; the pull waits on the engine.
    append(engine, '\nNotes.\n')
    held.holdNextExport()
    relay.pull()
    await Promise.resolve()

    // Meanwhile the person types: the edit is pushed after the pull, as an editor does.
    append(page, 'More.\n')
    relay.push()
    held.release()
    await relay.settled()

    expect(body(engine)).toBe(body(page))
    expect(body(engine)).toContain('More.')
    expect(body(engine)).toContain('Notes.')
  })

  it('applies pulls through a page store, and drops a pull whose replica the store replaced meanwhile', async () => {
    const engine = engineReplica('One\n')
    let current = Replica.load(schema, engine.snapshot(), randomActor())
    const imported: number[] = []
    const store = {
      replica: () => current,
      importChanges: (changes: Uint8Array) => {
        imported.push(changes.byteLength)
        current.importChanges(changes)
      },
    }
    const held = heldEngine(engine)
    const relay = new WorkerRelay(store, held.port, { report: fail })

    append(engine, 'Two\n')
    relay.pull()
    await relay.settled()
    expect(imported).toHaveLength(1)
    expect(body(current)).toBe('One\nTwo\n')

    append(engine, 'Three\n')
    held.holdNextExport()
    relay.pull()
    await Promise.resolve()
    const replaced = Replica.load(schema, engine.snapshot(), randomActor())
    current = replaced
    held.release()
    await relay.settled()
    expect(imported).toHaveLength(1)
  })

  it('reports a failed exchange and goes on with the next one; after close it exchanges nothing', async () => {
    const engine = engineReplica('One\n')
    const page = Replica.load(schema, engine.snapshot(), randomActor())
    const errors: unknown[] = []
    let failNext = true
    const port: EngineReplica = {
      exportChanges: async (since) => ({ changes: engine.exportChanges(Version.decode(new Uint8Array(since))).slice().buffer as ArrayBuffer, blobs: new ArrayBuffer(0) }),
      importChanges: async (changes) => {
        if (failNext) {
          failNext = false
          throw new Error('the worker is busy')
        }
        return engine.importChanges(new Uint8Array(changes))
      },
    }
    const relay = new WorkerRelay(page, port, { report: (error) => errors.push(error) })
    append(page, 'Two\n')
    relay.push()
    relay.push()
    await relay.settled()
    expect(errors).toHaveLength(1)
    expect(body(engine)).toBe('One\nTwo\n')

    relay.close()
    append(page, 'Three\n')
    relay.push()
    await relay.settled()
    expect(body(engine)).toBe('One\nTwo\n')
  })
})

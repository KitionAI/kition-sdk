/** The document's minimum schema version (rule M20); the twin of the crate's `tests/schema_version.rs`. */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { decodeCommit, decodeOrigin, encodeCommit, KdmError, newDocId, parseSchema, Replica, system, Version, type Schema } from '../src/index'
import { crateFixture, me, pageWithShape, reasonOf } from './helpers'

/** The test schema at `version`. */
function schemaAt(version: number): Schema {
  const json = JSON.parse(crateFixture('test-schema.json'))
  json.schemaVersion = version
  return parseSchema(json)
}

const migration = system('migrate')

/** Raises `replica` to `version` in a `system` transaction; answers whether it rose. */
const raise = (replica: Replica, version: number): boolean => replica.transact(migration, (tx) => tx.raiseSchemaVersion(version))

/** A replica of a fresh version 1 document, opened under schema `version`. */
function migratable(version: number, actor: bigint): { old: Replica; replica: Replica } {
  const old = Replica.create(schemaAt(1), newDocId(), 1n)
  return { old, replica: Replica.load(schemaAt(version), old.snapshot(), actor) }
}

/** The `meta.schemaVersion` register as builds before rule M20 read it: straight from the engine. */
function storedRegister(snapshot: Uint8Array): unknown {
  const doc = new LoroDoc()
  doc.import(snapshot.slice(20))
  return doc.getMap('meta').get('schemaVersion')
}

const errorOf = (run: () => unknown): KdmError => {
  try {
    run()
  } catch (error) {
    if (error instanceof KdmError) return error
    throw error
  }
  expect.fail('expected a KdmError')
}

describe('the minimum schema version', () => {
  it('is the version a replica was created at', () => {
    const replica = Replica.create(schemaAt(2), newDocId(), 1n)
    expect(replica.minSchemaVersion()).toBe(2)
    expect((replica.stateJson() as { meta: Record<string, unknown> }).meta.schemaVersion).toBe(2)
  })

  it('is recorded by a raise as replicated data', () => {
    const { replica } = migratable(2, 2n)
    expect(replica.minSchemaVersion()).toBe(1)
    expect(raise(replica, 2)).toBe(true)
    expect(replica.minSchemaVersion()).toBe(2)
    const snapshot = replica.snapshot()
    expect(storedRegister(snapshot)).toBe(2)
    const loaded = Replica.load(schemaAt(2), snapshot, 3n)
    expect(loaded.minSchemaVersion()).toBe(2)
    expect(loaded.stateText()).toBe(replica.stateText())
  })

  it('does not change for a raise to the current or a lower version', () => {
    const replica = Replica.create(schemaAt(3), newDocId(), 1n)
    const version = replica.version()
    const state = replica.stateText()
    expect(raise(replica, 3)).toBe(false)
    expect(raise(replica, 2)).toBe(false)
    expect(replica.version().equals(version)).toBe(true)
    expect(replica.stateText()).toBe(state)
    const { replica: migrated } = migratable(3, 3n)
    const raised = migrated.transact(migration, (tx) => {
      const first = tx.raiseSchemaVersion(3)
      const again = tx.raiseSchemaVersion(2)
      expect(tx.minSchemaVersion()).toBe(3)
      return [first, again]
    })
    expect(raised).toEqual([true, false])
    const after = migrated.version()
    expect(raise(migrated, 2)).toBe(false)
    expect(migrated.version().equals(after)).toBe(true)
    expect(migrated.minSchemaVersion()).toBe(3)
  })

  it('keeps the largest of concurrent raises', () => {
    for (const [highActor, lowActor] of [
      [2n, 3n],
      [3n, 2n],
    ]) {
      const old = Replica.create(schemaAt(1), newDocId(), 1n)
      const high = Replica.load(schemaAt(3), old.snapshot(), highActor)
      const low = Replica.load(schemaAt(3), old.snapshot(), lowActor)
      const base = high.version()
      expect(raise(high, 3)).toBe(true)
      expect(raise(low, 2)).toBe(true)
      const fromHigh = high.exportChanges(base)
      const fromLow = low.exportChanges(base)
      high.importChanges(fromLow)
      low.importChanges(fromHigh)
      expect(high.minSchemaVersion()).toBe(3)
      expect(low.minSchemaVersion()).toBe(3)
      expect(high.stateText()).toBe(low.stateText())
      expect(raise(low, 3)).toBe(false)
    }
  })

  it('is raised only by a system transaction, and never above its schema', () => {
    const { replica } = migratable(2, 2n)
    const version = replica.version()
    expect(reasonOf(() => replica.transact(me, (tx) => tx.raiseSchemaVersion(2)))).toBe('invalid-value')
    expect(reasonOf(() => replica.transact(migration, (tx) => tx.raiseSchemaVersion(3)))).toBe('invalid-value')
    expect(reasonOf(() => replica.transact(migration, (tx) => tx.raiseSchemaVersion(1.5)))).toBe('invalid-value')
    expect(replica.version().equals(version)).toBe(true)
    expect(replica.minSchemaVersion()).toBe(1)
  })

  it('is not an undo step', () => {
    const { replica } = migratable(2, 2n)
    const { shape } = pageWithShape(replica)
    expect(raise(replica, 2)).toBe(true)
    replica.transact(me, (tx) => tx.set(shape, 'x', 5))
    expect(replica.undo()).toBe(true)
    expect(replica.undo()).toBe(true)
    expect(replica.canUndo()).toBe(false)
    expect(replica.minSchemaVersion()).toBe(2)
  })
})

describe('an older reader', () => {
  it('refuses to load a migrated document', () => {
    const { replica } = migratable(2, 2n)
    // A replica written under schema 2 but not migrated still opens in a version 1 reader.
    pageWithShape(replica)
    expect(() => Replica.load(schemaAt(1), replica.snapshot(), 3n)).not.toThrow()
    raise(replica, 2)
    const error = errorOf(() => Replica.load(schemaAt(1), replica.snapshot(), 3n))
    expect(error.reason).toBe('newer-schema')
    expect(error.message).toBe('the document needs schema version 2; this kit reads schema versions up to 1')
    expect(() => Replica.load(schemaAt(2), replica.snapshot(), 3n)).not.toThrow()
  })

  it('refuses an import that migrates the document, and stays unchanged', () => {
    const old = Replica.create(schemaAt(1), newDocId(), 1n)
    const { page } = pageWithShape(old)
    const migrated = Replica.load(schemaAt(2), old.snapshot(), 2n)
    const base = migrated.version()
    // The migration: the rewrite and the raise in one system transaction.
    migrated.transact(migration, (tx) => {
      tx.set(page, 'title', 'Migrated')
      tx.raiseSchemaVersion(2)
    })
    old.transact(me, (tx) => tx.create('Page', { title: 'Local' }))
    old.takeChanged()
    const version = old.version()
    const state = old.stateText()
    const exported = old.exportChanges(Version.empty())
    expect(reasonOf(() => old.importChanges(migrated.exportChanges(base)))).toBe('newer-schema')
    expect(old.version().equals(version)).toBe(true)
    expect(old.stateText()).toBe(state)
    expect(old.minSchemaVersion()).toBe(1)
    expect(old.takeChanged().size).toBe(0)
    expect(old.hasPendingChanges()).toBe(false)
    // The exports still hold exactly the old changes.
    const copy = Replica.load(schemaAt(1), old.snapshot(), 4n)
    copy.importChanges(exported)
    expect(copy.stateText()).toBe(state)
    // The replica keeps working, and a reader of the new schema takes its changes.
    const since = old.version()
    old.transact(me, (tx) => tx.set(page, 'title', 'Later'))
    expect(old.get(page, 'title')).toBe('Later')
    migrated.importChanges(old.exportChanges(base))
    expect(migrated.minSchemaVersion()).toBe(2)
    expect(migrated.version().includes(since)).toBe(true)
  })

  it('keeps the changes still pending through a refused import', () => {
    const old = Replica.create(schemaAt(1), newDocId(), 1n)
    pageWithShape(old)
    const other = Replica.load(schemaAt(1), old.snapshot(), 2n)
    const migrated = Replica.load(schemaAt(2), old.snapshot(), 3n)
    const base = other.version()
    other.transact(me, (tx) => tx.create('Page', { title: 'first' }))
    const middle = other.version()
    other.transact(me, (tx) => tx.create('Page', { title: 'second' }))
    old.importChanges(other.exportChanges(middle))
    expect(old.hasPendingChanges()).toBe(true)
    raise(migrated, 2)
    expect(reasonOf(() => old.importChanges(migrated.exportChanges(base)))).toBe('newer-schema')
    expect(old.hasPendingChanges()).toBe(true)
    // The pending change is missing again; a sync from the version fetches it.
    old.importChanges(other.exportChanges(old.version()))
    expect(old.hasPendingChanges()).toBe(false)
    expect(old.stateText()).toBe(other.stateText())
  })
})

describe('the canonical state', () => {
  it('shows the minimum as meta.schemaVersion, as the Rust crate writes it', () => {
    const docId = '01920000-0000-7000-8000-0000000000bb'
    const old = Replica.create(schemaAt(1), docId, 1n)
    const a = Replica.load(schemaAt(3), old.snapshot(), 2n)
    const b = Replica.load(schemaAt(3), old.snapshot(), 3n)
    const base = a.version()
    raise(a, 3)
    raise(b, 2)
    a.importChanges(b.exportChanges(base))
    expect(a.stateText()).toBe(
      '{"meta":{"docId":"01920000-0000-7000-8000-0000000000bb","kdm":1,"kit":"kit.test","schemaVersion":3},"objects":{}}',
    )
  })
})

describe("each change's author schema version (rule M5a)", () => {
  it('is recorded in every commit, and read back as the newest', () => {
    const old = Replica.create(schemaAt(1), newDocId(), 1n)
    expect(old.authorSchemaVersion()).toBe(1)
    const { page } = pageWithShape(old)
    const newer = Replica.load(schemaAt(3), old.snapshot(), 2n)
    // Loading changes nothing: only a newer replica's own commits record its version.
    expect(newer.authorSchemaVersion()).toBe(1)
    const base = old.version()
    newer.transact(me, (tx) => tx.set(page, 'title', 'Edited with a newer kit'))
    expect(newer.authorSchemaVersion()).toBe(3)
    // The older reader takes the change (nothing migrated), and can tell it was written under schema 3.
    old.importChanges(newer.exportChanges(base))
    expect(old.get(page, 'title')).toBe('Edited with a newer kit')
    expect(old.authorSchemaVersion()).toBe(3)
    expect(old.minSchemaVersion()).toBe(1)
    // And a snapshot keeps it.
    expect(Replica.load(schemaAt(1), old.snapshot(), 4n).authorSchemaVersion()).toBe(3)
  })

  it('is the commit message [kind, principal, label, schemaVersion], which older readers still decode', () => {
    const replica = Replica.create(schemaAt(2), newDocId(), 1n)
    pageWithShape(replica)
    const doc = new LoroDoc()
    doc.import(replica.snapshot().slice(20))
    const messages = [...doc.getAllChanges().values()].flat().map((change) => change.message)
    expect(messages).toContain('["person","user:test",null,2]')
    for (const message of messages) expect(decodeOrigin(message!)).not.toBeNull()
    expect(decodeCommit('["person","user:test",null,2]')).toEqual({ origin: { kind: 'person', principal: 'user:test', label: undefined }, schemaVersion: 2 })
    // A message from before rule M5a names no version.
    expect(decodeCommit('["person","user:test",null]')?.schemaVersion).toBeNull()
    expect(decodeCommit('["person","user:test",null,"2"]')?.schemaVersion).toBeNull()
    expect(decodeCommit('not json')).toBeNull()
    expect(encodeCommit(system('migrate'), 4)).toBe('["system","kdm","migrate",4]')
  })

  it('is null when no change records one', () => {
    const replica = Replica.create(schemaAt(1), newDocId(), 1n)
    const doc = new LoroDoc()
    doc.import(replica.snapshot().slice(20))
    doc.getMap('meta').set('note', 'written before rule M5a')
    doc.commit({ message: '["person","user:old",null]' })
    // Rewrap the engine bytes in the KDM envelope the replica exported.
    const envelope = replica.snapshot().slice(0, 20)
    const bytes = doc.export({ mode: 'snapshot' })
    const wrapped = new Uint8Array(envelope.length + bytes.length)
    wrapped.set(envelope)
    wrapped.set(bytes, envelope.length)
    const loaded = Replica.load(schemaAt(1), wrapped, 5n)
    // The create commit records version 1; the other one none.
    expect(loaded.authorSchemaVersion()).toBe(1)
  })
})

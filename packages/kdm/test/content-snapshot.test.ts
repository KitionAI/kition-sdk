// What a content snapshot holds (data model, "A file holds no history"): `contentSnapshot` seals the
// replica and answers its state with, of the history, only the seal. The Rust crate's
// tests/content_snapshot.rs tests the same.
//
// The content needles below are written once each and share no run of four characters with
// anything else in the document, so the engine's compression keeps each one literal in the bytes
// that hold it: every test checks the full snapshot holds them (the control) before it checks a
// content snapshot does not. Commit messages are stored in a form a byte search does not always
// find (the control fails for some), so the origins are checked through the engine: the content
// snapshot's history holds one change, the seal. Their bytes are searched as well.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { agent, decodeCommit, newDocId, person, Replica, type ObjectId } from '../src/index'
import { me, pageWithShape, reasonOf, testSchema } from './helpers'

const DELETED_OBJECT = 'Qv7Zp9Wm2Rk5'
const DELETED_TEXT = 'Jx4Hb8Ty3Nc6'
const OVERWRITTEN = 'Ug5Le1Fo0Dw4'
// Principals are searched for by their own part: `user:` itself occurs elsewhere.
const DELETER = 'Wk3Rf8Yb1Qz'
const TYPIST = 'Hs6Pn2Dc9Lx'
const TYPIST_LABEL = 'Ty5Ga1Ve7Oj'
const AGENT = 'Mz8Cu4Ki0Ef'
const AGENT_LABEL = 'Rb2Wn6Xs3Ip'
const LAST = 'Vy9Jt4Sa7Gm'
const LAST_LABEL = 'Ze3Ko8Ux2Bh'
const CONTENT = [DELETED_OBJECT, DELETED_TEXT, OVERWRITTEN]
const ORIGINS = [DELETER, TYPIST, TYPIST_LABEL, AGENT, AGENT_LABEL]

const contains = (bytes: Uint8Array, needle: string, encoding: 'utf8' | 'utf16le' = 'utf8'): boolean =>
  Buffer.from(bytes).includes(Buffer.from(needle, encoding))

/**
 * A document whose history holds a deleted object, typed-then-deleted text and an overwritten
 * value, by two replicas: `a` (actor 1) has imported `b`'s (actor 2) changes, so with `lastEdit` its
 * version has one head (its own person's edit after the import), and without, two concurrent ones.
 */
function history(lastEdit: boolean): { a: Replica; b: Replica; shape: ObjectId; page: ObjectId } {
  const a = Replica.create(testSchema(), newDocId(), 1n)
  const { page, shape } = pageWithShape(a)
  const gone = a.transact(person(`user:${DELETER}`), (tx) => tx.create('Shape', { kind: 'rect', x: 1, y: 2, fill: DELETED_OBJECT }))
  a.transact(person(`user:${DELETER}`), (tx) => tx.delete(gone))
  const b = Replica.load(testSchema(), a.snapshot(), 2n)
  a.transact(person(`user:${TYPIST}`, TYPIST_LABEL), (tx) => tx.textInsert(shape, 'label', 0, DELETED_TEXT))
  a.transact(person(`user:${TYPIST}`, TYPIST_LABEL), (tx) => tx.textDelete(shape, 'label', 0, DELETED_TEXT.length))
  b.transact(agent(`agent:${AGENT}`, AGENT_LABEL), (tx) => tx.set(shape, 'fill', OVERWRITTEN))
  b.transact(agent(`agent:${AGENT}`, AGENT_LABEL), (tx) => tx.set(shape, 'fill', 'plain'))
  a.importChanges(b.exportChanges(a.version()))
  if (lastEdit) a.transact(person(`user:${LAST}`, LAST_LABEL), (tx) => tx.set(shape, 'x', 99))
  return { a, b, shape, page }
}

/** The changes a KDM export holds, read through the engine: each one's commit message. */
function messages(bytes: Uint8Array): string[] {
  const doc = new LoroDoc()
  try {
    doc.import(bytes.subarray(20))
    return [...doc.getAllChanges().values()].flat().map((change) => change.message ?? '')
  } finally {
    doc.free()
  }
}

/** The peer in a container id (`cid:<counter>@<peer>:<type>`). */
const peerOf = (cid: string): string => cid.slice(cid.indexOf('@') + 1, cid.lastIndexOf(':'))

describe('contentSnapshot', () => {
  for (const lastEdit of [true, false]) {
    const heads = lastEdit ? 'one head' : 'two concurrent heads'
    it(`holds no deleted content, overwritten value or person's origin (${heads})`, () => {
      const { a } = history(lastEdit)
      expect(a.isSealed()).toBe(false)
      const full = a.snapshot()
      for (const needle of CONTENT) expect(contains(full, needle), `the control: the full snapshot holds ${needle}`).toBe(true)
      const needles = [...CONTENT, ...ORIGINS, ...(lastEdit ? [LAST, LAST_LABEL] : [])]
      const origins = messages(full).join('\n')
      for (const needle of needles.slice(CONTENT.length)) expect(origins, `the control: the full history names ${needle}`).toContain(needle)
      const content = a.contentSnapshot()
      for (const needle of needles) {
        expect(contains(content, needle), needle).toBe(false)
        expect(contains(content, needle, 'utf16le'), needle).toBe(false)
      }
      // Of the history, the engine reads one change: the seal.
      const held = messages(content)
      expect(held).toHaveLength(1)
      expect(decodeCommit(held[0])?.origin).toEqual({ kind: 'system', principal: 'kdm', label: 'content-seal' })
      // The full snapshot taken after holds the seal on top of every earlier change.
      expect(messages(a.snapshot()).length).toBeGreaterThan(5)
    })
  }

  it('loads as the same document, edits, and merges with a replica that has the whole history', () => {
    const { a, shape, page } = history(false)
    const content = a.contentSnapshot()
    const file = Replica.load(testSchema(), content, 3n)
    expect(file.docId).toBe(a.docId)
    expect(file.isShallow()).toBe(true)
    expect(file.version().equals(a.version())).toBe(true)
    expect(file.stateText()).toBe(a.stateText())
    expect(file.objectsOfType('Shape')).toEqual(a.objectsOfType('Shape'))
    expect(file.list(page, 'shapes')).toEqual([shape])
    // What survives of who wrote what: the actor (peer) ids inside element ids.
    const doc = new LoroDoc()
    doc.import(content.subarray(20))
    const objects = doc.getMap('objects')
    expect(peerOf((objects.get(shape) as { id: string }).id)).toBe('1')
    doc.free()
    // New edits on the file's replica, and changes made after the seal by the full one, cross.
    const since = a.version()
    file.transact(me, (tx) => tx.set(shape, 'y', 7))
    a.transact(me, (tx) => tx.textInsert(shape, 'label', 0, 'after'))
    a.importChanges(file.exportChanges(since))
    file.importChanges(a.exportChanges(file.version()))
    expect(file.stateText()).toBe(a.stateText())
    expect(file.get(shape, 'y')).toBe(7)
    expect(file.text(shape, 'label')).toBe('after')
  })

  it('refuses changes that depend on history before the seal as history-missing', () => {
    const { a, b, shape } = history(false)
    const before = b.version()
    const file = Replica.load(testSchema(), a.contentSnapshot(), 3n)
    // b did not see the seal: its next change is concurrent with it.
    b.transact(me, (tx) => tx.set(shape, 'y', 1))
    expect(reasonOf(() => file.importChanges(b.exportChanges(before)))).toBe('history-missing')
    expect(file.stateText()).toBe(Replica.load(testSchema(), a.contentSnapshot(), 4n).stateText())
  })

  it('commits nothing and answers the same bytes when nothing changed since', () => {
    const { a } = history(false)
    const first = a.contentSnapshot()
    const version = a.version()
    expect(a.isSealed()).toBe(true)
    expect(a.seal()).toBe(false)
    expect(a.contentSnapshot()).toEqual(first)
    expect(a.version().equals(version)).toBe(true)
    // A replica loaded from it is sealed too, and answers the same bytes.
    const file = Replica.load(testSchema(), first, 3n)
    expect(file.isSealed()).toBe(true)
    expect(file.contentSnapshot()).toEqual(first)
    expect(file.version().equals(version)).toBe(true)
  })

  it('seals again after an edit, an import, or nothing but another replica’s seal', () => {
    const { a, b, shape } = history(false)
    a.contentSnapshot()
    const sealed = a.version()
    a.transact(me, (tx) => tx.set(shape, 'x', 5))
    expect(a.isSealed()).toBe(false)
    expect(a.seal()).toBe(true)
    // Another replica's seal, imported alone, is the head: nothing to seal.
    b.importChanges(a.exportChanges(b.version()))
    expect(b.isSealed()).toBe(true)
    expect(b.seal()).toBe(false)
    expect(a.version().includes(sealed)).toBe(true)
  })

  it('refuses sealedContentSnapshot on a replica that is not sealed', () => {
    const { a } = history(true)
    expect(reasonOf(() => a.sealedContentSnapshot())).toBe('invalid-value')
    a.seal()
    expect(a.sealedContentSnapshot()).toEqual(a.contentSnapshot())
  })

  it('is no undo step: an undo after a save takes back the last edit', () => {
    const { a, shape } = history(false)
    const file = Replica.load(testSchema(), a.contentSnapshot(), 3n)
    file.transact(me, (tx) => tx.set(shape, 'x', 5))
    file.contentSnapshot()
    expect(file.undo()).toBe(true)
    expect(file.get(shape, 'x')).toBe(10)
    expect(file.canUndo()).toBe(false)
    expect(file.redo()).toBe(true)
    expect(file.get(shape, 'x')).toBe(5)
  })

  it('is deterministic for one replica, not across replicas with different histories', () => {
    const docId = newDocId()
    const one = Replica.create(testSchema(), docId, 5n)
    const { shape } = pageWithShape(one)
    const two = Replica.load(testSchema(), one.snapshot(), 6n)
    one.transact(me, (tx) => tx.set(shape, 'x', 3))
    two.transact(me, (tx) => tx.set(shape, 'x', 4))
    two.transact(me, (tx) => tx.set(shape, 'x', 3))
    expect(one.stateText()).toBe(two.stateText())
    const bytes = one.contentSnapshot()
    expect(one.contentSnapshot()).toEqual(bytes)
    // The seal and the element ids name each replica's own changes.
    expect(two.contentSnapshot()).not.toEqual(bytes)
  })
})

describe('rebirth', () => {
  it('lets a document known only from its content snapshot start a room (sync protocol S20)', () => {
    const { a, shape } = history(false)
    const content = a.contentSnapshot()
    expect(Replica.snapshotCarriesWholeHistory(content)).toBe(false)
    const file = Replica.load(testSchema(), content, 3n)
    expect(file.carriesWholeHistory()).toBe(false)
    file.transact(me, (tx) => tx.set(shape, 'x', 5))
    expect(file.canUndo()).toBe(true)
    expect(file.rebirth()).toBe(true)
    expect(file.docId).toBe(a.docId)
    expect(file.objectsOfType('Shape')).toEqual(a.objectsOfType('Shape'))
    expect(file.get(shape, 'x')).toBe(5)
    expect(file.canUndo()).toBe(false)
    expect(file.carriesWholeHistory()).toBe(true)
    expect(Replica.snapshotCarriesWholeHistory(file.snapshot())).toBe(true)
    // The rebirth is a seal: the content snapshot commits nothing and carries the whole history.
    const version = file.version()
    const reborn = file.contentSnapshot()
    expect(file.version().equals(version)).toBe(true)
    expect(Replica.snapshotCarriesWholeHistory(reborn)).toBe(true)
    expect(file.rebirth()).toBe(false)
    // A replica of the room edits and syncs like any other.
    const member = Replica.load(testSchema(), reborn, 4n)
    member.transact(me, (tx) => tx.set(shape, 'y', 9))
    file.importChanges(member.exportChanges(file.version()))
    expect(file.get(shape, 'y')).toBe(9)
    // Edits after it make later content snapshots that no longer do.
    expect(Replica.snapshotCarriesWholeHistory(file.contentSnapshot())).toBe(false)
  })

  it('leaves a replica that carries the whole history as it is', () => {
    const { a } = history(false)
    const version = a.version()
    expect(a.rebirth()).toBe(false)
    expect(a.version().equals(version)).toBe(true)
    const copy = a.copyAsNewDocument(newDocId(), 7n)
    expect(copy.rebirth()).toBe(false)
    // A fresh copy is sealed by the change that made it: its content snapshot carries its birth.
    expect(copy.isSealed()).toBe(true)
    expect(Replica.snapshotCarriesWholeHistory(copy.contentSnapshot())).toBe(true)
  })

  it('makes a replica that keeps history before it unable to send concurrent changes', () => {
    const { a, b, shape } = history(false)
    const before = b.version()
    const file = Replica.load(testSchema(), a.contentSnapshot(), 3n)
    file.rebirth()
    b.transact(me, (tx) => tx.set(shape, 'y', 1))
    expect(reasonOf(() => file.importChanges(b.exportChanges(before)))).toBe('history-missing')
  })
})

describe('a replica opened from a content snapshot', () => {
  it('forks and tells what changed at every version since the file, and refuses earlier ones', () => {
    const { a, shape } = history(false)
    const before = a.version()
    const file = Replica.load(testSchema(), a.contentSnapshot(), 3n)
    const opened = file.version()
    expect(file.reaches(opened)).toBe(true)
    expect(file.reaches(before)).toBe(false)
    file.transact(me, (tx) => tx.set(shape, 'x', 5))
    const middle = file.version()
    file.transact(me, (tx) => tx.set(shape, 'y', 6))
    // A batch's receipt: what changed since a version after the file.
    const since = file.changesSince(middle)
    expect(JSON.stringify(since)).toContain('"y"')
    expect(JSON.stringify(since)).not.toContain('"x"')
    expect(JSON.stringify(file.changesSince(opened))).toContain('"x"')
    const draft = file.forkAt(middle, 4n)
    expect(draft.isShallow()).toBe(true)
    expect(draft.version().equals(middle)).toBe(true)
    expect(draft.get(shape, 'x')).toBe(5)
    expect(draft.get(shape, 'y')).toBe(20)
    // The draft edits and merges back like any.
    draft.transact(me, (tx) => tx.set(shape, 'fill', '#222222'))
    file.mergeChanges(draft.exportChanges(middle), me)
    expect(file.get(shape, 'fill')).toBe('#222222')
    expect(file.get(shape, 'y')).toBe(6)
    // Versions before the file are not in it.
    expect(reasonOf(() => file.forkAt(before, 5n))).toBe('history-missing')
    expect(reasonOf(() => file.changesSince(before))).toBe('history-missing')
  })

  it('lists the origins its bytes hold: one, the seal', () => {
    const { a } = history(true)
    const full = Replica.snapshotOrigins(a.snapshot())
    expect(full.length).toBeGreaterThan(5)
    expect(full).toContainEqual(person(`user:${LAST}`, LAST_LABEL))
    expect(Replica.snapshotOrigins(a.contentSnapshot())).toEqual([{ kind: 'system', principal: 'kdm', label: 'content-seal' }])
    expect(reasonOf(() => Replica.snapshotOrigins(new Uint8Array([1, 2, 3])))).toBe('encoding')
  })
})

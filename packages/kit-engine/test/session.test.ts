import { describe, expect, it } from 'vitest'
import { newDocId, parseSchema, Replica, system, Version, type ObjectId } from '@kition/kdm'
import { historyScope, kitEngineClass, KitSession, type KitModel } from '../src/index'

/** A list of notes: the smallest kit there is. */
const SCHEMA = {
  kdm: 1,
  kit: 'kit.notes',
  schemaVersion: 1,
  root: 'Notes',
  types: {
    Notes: { fields: { items: { kind: 'list', of: 'Note' } } },
    Note: { fields: { title: { kind: 'string' }, done: { kind: 'boolean', optional: true } } },
  },
}
const schema = parseSchema(SCHEMA)

type View = { titles: string[]; loads: number; applies: number }

const root = (replica: Replica) => replica.objectsOfType('Notes')[0]
const titles = (replica: Replica) => replica.list(root(replica), 'items').map((id) => String(replica.get(id, 'title')))

const notes: KitModel<View> = {
  schema,
  load: (replica) => ({ titles: titles(replica), loads: 1, applies: 0 }),
  apply(view, replica) {
    view.titles = titles(replica)
    view.applies += 1
    return { kind: 'full' }
  },
  command(_view, replica, id, params, origin) {
    if (id === 'note.add') {
      return replica.transact(origin, (tx) => {
        const note = tx.create('Note', { title: String(params.title) })
        tx.listInsert(root(replica), 'items', replica.list(root(replica), 'items').length, note)
        return { id: note }
      })
    }
    if (id === 'note.rename') {
      replica.transact(origin, (tx) => tx.set(String(params.id) as ObjectId, 'title', String(params.title)))
      return null
    }
    throw new Error(`no command ${id}`)
  },
  commands: () => [
    { id: 'note.add', title: 'Add note', menu: ['Note'], shortcut: null, mutates: true, enabled: true },
    { id: 'note.rename', title: 'Rename note', menu: null, shortcut: null, mutates: true, enabled: false },
  ],
  import(_name, bytes, actor) {
    const text = new TextDecoder().decode(bytes)
    return Replica.createWith(schema, newDocId(), actor, system('import'), (tx) => {
      const list = tx.create('Notes', {})
      text
        .split('\n')
        .filter(Boolean)
        .forEach((title, index) => tx.listInsert(list, 'items', index, tx.create('Note', { title })))
    }).replica
  },
  export: (view) => new TextEncoder().encode(view.titles.map((title) => `${title}\n`).join('')),
  create: (_name, _size, actor) => Replica.createWith(schema, newDocId(), actor, system('create'), (tx) => tx.create('Notes', {})).replica,
  inspect: (view) => ({ notes: view.titles.length }),
}

const NotesDocument = kitEngineClass(notes)
const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array) => new TextDecoder().decode(data)

it('rereads file differences without replacing agent undo history or later outside values', () => {
  const replica = notes.import('a.notes', bytes('First\nSecond'), 1n)
  const session = new KitSession(notes, replica)
  const [held, other] = replica.list(root(replica), 'items')
  session.execute('note.rename', { id: held, title: 'Mine' }, { kind: 'agent', principal: 'agent' })
  session.reread((_view, tx) => tx.set(other, 'title', 'Outside'))
  expect(session.dirty).toBe(false)
  expect(session.undoIn('agent').done).toBe(true)
  expect(titles(replica)).toEqual(['First', 'Outside'])
  expect(session.redoIn('agent').done).toBe(true)
  session.reread((_view, tx) => tx.set(held, 'title', 'Outside wins'))
  expect(session.undoIn('agent').done).toBe(true)
  expect(titles(replica)).toEqual(['Outside wins', 'Outside'])
})

describe('kitEngineClass', () => {
  it('forks premise documents with stable identities and isolated content', () => {
    const doc = NotesDocument.open('List.notes', bytes('First\nSecond'))
    const original = Replica.load(schema, doc.snapshot(), 1n).stateJson()
    const fork = doc.forkForPremises!()
    expect(Replica.load(schema, fork.snapshot!(), 2n).stateJson()).toEqual(original)
    fork.execute('note.add', JSON.stringify({ title: 'Planned' }))
    expect(text(fork.save('List.notes'))).toBe('First\nSecond\nPlanned\n')
    expect(text(doc.save('List.notes'))).toBe('First\nSecond\n')
    expect(Replica.load(schema, doc.snapshot(), 3n).stateJson()).toEqual(original)
    fork.free()
  })
  it('forwards computed objects without adding them to the replica', () => {
    const Document=kitEngineClass({...notes,projectedObjects:(_view:View,replica:Replica)=>[
      {id:'computed',type:'Line',fields:{text:titles(replica).join('\n')}},
    ]})
    const document=Document.open('test.notes',bytes('First'))
    const before=document.exportChanges(new Uint8Array())
    expect(JSON.parse(document.premiseRead!('projected','{}'))).toEqual([{id:'computed',type:'Line',fields:{text:'First'}}])
    expect(document.exportChanges(new Uint8Array())).toEqual(before)
  })
  it('forwards editor state hooks so premise contexts can be isolated without changing the replica', () => {
    const state = { selection: ['person'] }
    const editor = {
      ...notes,
      editorState: () => structuredClone(state),
      restoreEditorState: (_view: View, _replica: Replica, saved: unknown) => Object.assign(state, saved),
      setContext: (_view: View, _replica: Replica, context: { on?: Array<string | number> }) => {
        if (context.on) state.selection = context.on.map(String)
      },
      premise: () => ({ objects: [...state.selection] }),
    }
    const Document = kitEngineClass(editor)
    const doc = Document.open('List.notes', bytes('Milk\n'))
    const version = doc.version()
    const saved = doc.editorState!()
    doc.setContext!('{"on":["agent"]}')
    expect(JSON.parse(doc.premiseRead!('under', '{}'))).toEqual({ objects: ['agent'] })
    doc.restoreEditorState!(saved)
    expect(state.selection).toEqual(['person'])
    expect(doc.version()).toEqual(version)
    expect(doc.dirty).toBe(false)
    const unsupported = NotesDocument.open('List.notes', bytes('Milk\n'))
    expect(unsupported.editorState!()).toBe('null')
    expect(() => unsupported.setContext!('{"on":["agent"]}')).toThrow('context')
  })

  it('dispatches read-only premise callbacks and distinguishes absent declarations from unsupported comparisons', () => {
    const ordinary = NotesDocument.open('List.notes', bytes('Milk\n'))
    expect(JSON.parse(ordinary.premiseRead!('under', '{}'))).toBeNull()
    expect(JSON.parse(ordinary.premiseRead!('identity', '{}'))).toEqual({ unproven: [] })
    expect(() => ordinary.premiseRead!('content', '{}')).toThrow('unsupported premise request')
    const Document = kitEngineClass({ ...notes, premise: (view, _replica, method, params) => ({ method, before: params.before, titles: view.titles }) })
    const doc = Document.open('List.notes', bytes('Milk\n'))
    const version = doc.version()
    expect(JSON.parse(doc.premiseRead!('content', '{"before":"basis"}'))).toEqual({ method: 'content', before: 'basis', titles: ['Milk'] })
    expect(doc.version()).toEqual(version)
    expect(doc.dirty).toBe(false)
  })

  it('opens, runs commands, and saves through the model', () => {
    const doc = NotesDocument.open('List.notes', bytes('Milk\nBread\n'))
    expect(NotesDocument.contractVersion()).toBe(1)
    expect(doc.dirty).toBe(false)
    const added = JSON.parse(doc.execute('note.add', JSON.stringify({ title: 'Eggs' }))) as { id: string }
    expect(added.id).toMatch(/\S/)
    expect(doc.dirty).toBe(true)
    expect(doc.revision).toBe(1n)
    expect(JSON.parse(doc.inspect())).toEqual({ notes: 3, canUndo: true, canRedo: false })
    const saved = doc.save('List.notes')
    expect(text(saved)).toBe('Milk\nBread\nEggs\n')
    expect(doc.dirty).toBe(true)
    doc.markSaved()
    expect(doc.dirty).toBe(false)
  })

  it('lists its commands after Undo and Redo, and the disabled ones', () => {
    const doc = NotesDocument.create('New.notes', 0, 0)
    const ids = (JSON.parse(doc.commands()) as Array<{ id: string }>).map((command) => command.id)
    expect(ids).toEqual(['edit.undo', 'edit.redo', 'note.add', 'note.rename'])
    expect(JSON.parse(doc.disabledCommands())).toEqual(['edit.undo', 'edit.redo', 'note.rename'])
  })

  it('checks the document through the model, errors first, and a model without checks finds none', () => {
    const checking = kitEngineClass<View>({
      ...notes,
      check: (view) => [
        ...view.titles.filter((title) => title.length < 5).map(() => ({ code: 'notes.short-title', severity: 'info' as const, target: {}, message: 'A note has a short title.' })),
        ...(view.titles.length > 2 ? [{ code: 'notes.too-many', severity: 'error' as const, target: {}, message: 'More than two notes.' }] : []),
      ],
    })
    const doc = checking.open('List.notes', bytes('Milk\nBread\nEggs\n'))
    const revision = doc.revision
    expect(JSON.parse(doc.check!()).diagnostics.map((found: { code: string }) => found.code)).toEqual(['notes.too-many', 'notes.short-title', 'notes.short-title'])
    expect(doc.revision).toBe(revision)
    expect(JSON.parse(NotesDocument.open('List.notes', bytes('Milk\n')).check!())).toEqual({ diagnostics: [] })
  })

  it('undoes and redoes its own edits through the replica and patches the view', () => {
    const doc = NotesDocument.open('List.notes', bytes('Milk\n'))
    doc.execute('note.add', JSON.stringify({ title: 'Eggs' }))
    expect(JSON.parse(doc.undo())).toEqual({ done: true, damage: { kind: 'full' } })
    expect(text(doc.save())).toBe('Milk\n')
    expect(JSON.parse(doc.execute('edit.redo', '{}'))).toEqual({ done: true, damage: { kind: 'full' } })
    expect(text(doc.save())).toBe('Milk\nEggs\n')
    expect(JSON.parse(doc.redo())).toEqual({ done: false, damage: { kind: 'none' } })
  })

  it('exchanges changes between replicas of one document, which converge', () => {
    const first = NotesDocument.open('List.notes', bytes('Milk\n'))
    const second = NotesDocument.create('Other.notes', 0, 0)
    expect(() => second.importChanges(first.exportChanges(new Uint8Array(0)))).toThrow()
    const copy = NotesDocument.open('List.notes', bytes(''))
    // A copy of the same document: made from the first one's changes.
    const replica = Replica.load(schema, first.snapshot(), 7n)
    expect(replica.docId).toBe(first.docId)
    const joined = new NotesDocument(new KitSession(notes, replica))
    joined.execute('note.add', JSON.stringify({ title: 'Tea' }))
    first.execute('note.add', JSON.stringify({ title: 'Eggs' }))
    const damage = JSON.parse(first.importChanges(joined.exportChanges(first.version()))) as { kind: string }
    expect(damage.kind).toBe('full')
    joined.importChanges(first.exportChanges(joined.version()))
    expect(text(first.save())).toBe(text(joined.save()))
    expect(text(first.save()).split('\n').filter(Boolean).sort()).toEqual(['Eggs', 'Milk', 'Tea'])
    expect(first.dirty).toBe(true)
    // An import is not the person's own: Undo takes back only their edit.
    expect(JSON.parse(first.undo()).done).toBe(true)
    expect(text(first.save()).split('\n').filter(Boolean).sort()).toEqual(['Milk', 'Tea'])
    expect(copy.docId).not.toBe(first.docId)
  })

  it('opens a file with its stored replica: a format that holds its replica ignores it, one that does not merges the file', () => {
    const first = NotesDocument.open('List.notes', bytes('Milk\n'))
    first.execute('note.add', JSON.stringify({ title: 'Eggs' }))
    // The notes format holds no replica, but this model has no `openReplica`: the file alone.
    const alone = NotesDocument.openWithReplica('List.notes', bytes('Milk\n'), first.snapshot(), new Uint8Array(0))
    expect(alone.docId).not.toBe(first.docId)
    expect(text(alone.save())).toBe('Milk\n')

    // With `openReplica`: the stored replica, and what the file adds as an import change.
    const merging: KitModel<View> = {
      ...notes,
      openReplica(_name, file, snapshot, _blobs, actor) {
        const replica = Replica.load(schema, snapshot, actor)
        const have = new Set(titles(replica))
        const added = new TextDecoder().decode(file).split('\n').filter((title) => title && !have.has(title))
        if (added.length) {
          replica.transact(system('import'), (tx) => {
            for (const title of added) tx.listInsert(root(replica), 'items', tx.listItems(root(replica), 'items').length, tx.create('Note', { title }))
          })
        }
        return replica
      },
    }
    const MergingDocument = kitEngineClass(merging)
    const reopened = MergingDocument.openWithReplica('List.notes', bytes('Milk\nTea\n'), first.snapshot(), new Uint8Array(0))
    expect(reopened.docId).toBe(first.docId)
    expect(text(reopened.save())).toBe('Milk\nEggs\nTea\n')
    // What the file said is saved already, and the import is no step of the person's.
    expect(reopened.dirty).toBe(false)
    expect(reopened.canUndo()).toBe(false)
  })

  it('answers the schema it reads and the newest one its changes were written under (M5a)', () => {
    const first = NotesDocument.open('List.notes', bytes('Milk\n'))
    expect(first.schemaVersion?.()).toBe(1)
    expect(first.authorSchemaVersion?.()).toBe(1)
    // A newer kit's replica of the same document (schema version 2, nothing migrated) edits it.
    const newer = Replica.load(parseSchema({ ...SCHEMA, schemaVersion: 2 }), first.snapshot(), 9n)
    newer.transact(system('rename'), (tx) => tx.set(newer.list(root(newer), 'items')[0], 'title', 'Oat milk'))
    first.importChanges(newer.exportChanges(Version.decode(first.version())))
    expect(first.schemaVersion?.()).toBe(1)
    expect(first.authorSchemaVersion?.()).toBe(2)
  })

  it('runs commands as the origin a host gives', () => {
    const doc = NotesDocument.open('List.notes', bytes('Milk\n'))
    doc.executeAs('note.add', JSON.stringify({ title: 'Eggs' }), JSON.stringify(['agent', 'agent:test', 'add']))
    expect(text(doc.save())).toBe('Milk\nEggs\n')
    expect(() => doc.executeAs('note.add', '{}', '"person"')).toThrow(/origin/)
  })

  it('undoes the agent’s steps and the person’s apart (KitModel M12a)', () => {
    const doc = NotesDocument.open('List.notes', bytes('Milk\n'))
    const agent = JSON.stringify(['agent', 'user:test', 'ai/run'])
    doc.executeAs('note.add', JSON.stringify({ title: 'Eggs' }), agent)
    doc.execute('note.add', JSON.stringify({ title: 'Bread' }))
    // The person's Undo takes back only their own note; the agent's undo, only the agent's.
    expect(JSON.parse(doc.execute('edit.undo', '{}')).done).toBe(true)
    expect(text(doc.save())).toBe('Milk\nEggs\n')
    expect(doc.canUndo?.()).toBe(false)
    expect(JSON.parse(doc.executeAs('edit.undo', '{}', agent)).done).toBe(true)
    expect(text(doc.save())).toBe('Milk\n')
    // The person can take back the agent's step by naming its scope.
    expect(JSON.parse(doc.execute('edit.redo', JSON.stringify({ scope: 'agent' }))).done).toBe(true)
    expect(text(doc.save())).toBe('Milk\nEggs\n')
    expect(JSON.parse(doc.execute('edit.undo', JSON.stringify({ scope: 'agent' }))).done).toBe(true)
    expect(text(doc.save())).toBe('Milk\n')
    expect(() => doc.execute('edit.undo', JSON.stringify({ scope: 'robot' }))).toThrow(/scope/)
    expect(historyScope({}, { kind: 'extension', principal: 'user:test' })).toBe('person')
  })

  it('has an empty blob bundle when the kit has no media, and refuses one', () => {
    const doc = NotesDocument.create('New.notes', 0, 0)
    expect(doc.blobs()).toEqual(new Uint8Array(0))
    doc.addBlobs(new Uint8Array(0))
    expect(() => doc.addBlobs(new Uint8Array([1]))).toThrow(/no media/)
  })

  it('answers transparent pixels: the kit draws its own editor', () => {
    const doc = NotesDocument.create('New.notes', 0, 0)
    expect(doc.render(0, 0, 1, 2, 3)).toEqual(new Uint8Array(24))
    expect(doc.width).toBe(0)
  })
})

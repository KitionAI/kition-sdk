/**
 * A `ts-worker` engine module for the loader's tests: `@kition/kit-engine`'s class for a one-field
 * document, and a default export that records what it was given.
 */
import { newDocId, parseSchema, Replica, system } from '@kition/kdm'
import { kitEngineClass } from '@kition/kit-engine'

const schema = parseSchema({
  kdm: 1,
  kit: 'kit.notes',
  schemaVersion: 1,
  root: 'Notes',
  types: { Notes: { fields: { title: { kind: 'string' } } } },
})

export const prepared = []

export default async function prepare(init) {
  prepared.push(init)
}

export const NotesDocument = kitEngineClass({
  schema,
  load: (replica) => ({ title: String(replica.get(replica.objectsOfType('Notes')[0], 'title')) }),
  apply: () => ({ kind: 'full' }),
  command: () => null,
  commands: () => [],
  import: (_name, bytes, actor) =>
    Replica.createWith(schema, newDocId(), actor, system('import'), (tx) => tx.create('Notes', { title: new TextDecoder().decode(bytes) })).replica,
  export: (view) => new TextEncoder().encode(view.title),
})

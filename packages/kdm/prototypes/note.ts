/**
 * Note on the KDM: the phase 1 prototype of binding CodeMirror to a KDM text field.
 * Local transactions publish their exact changes (never a whole-string replacement); remote
 * changes arrive as CodeMirror change specs in the editor's UTF-16 positions.
 */
import type { ChangeSet, ChangeSpec, Transaction } from '@codemirror/state'
import { parseSchema, type ObjectId, type Origin, type Replica, type TextDelta, type Tx } from '../src/index'

export const noteSchema = parseSchema({
  kdm: 1,
  kit: 'kit.note',
  schemaVersion: 1,
  root: 'Note',
  types: { Note: { fields: { body: { kind: 'text' } } } },
})

/** Applies a CodeMirror change set to a KDM text field inside one transaction. */
export function applyChangeSet(tx: Tx, id: ObjectId, field: string, changes: ChangeSet): void {
  let shift = 0
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const at = fromA + shift
    if (toA > fromA) tx.textDelete(id, field, at, toA - fromA)
    const text = inserted.toString()
    if (text) tx.textInsert(id, field, at, text)
    shift += text.length - (toA - fromA)
  })
}

/** A KDM text delta as CodeMirror change specs, all relative to the document before it. */
export function deltaToChanges(delta: TextDelta[]): ChangeSpec[] {
  const changes: ChangeSpec[] = []
  let position = 0
  for (const op of delta) {
    if ('retain' in op) position += op.retain
    else if ('delete' in op) {
      changes.push({ from: position, to: position + op.delete })
      position += op.delete
    } else changes.push({ from: position, insert: op.insert })
  }
  return changes
}

/**
 * Binds one editor to one text field of one replica. Every change to the field reaches the
 * editor (remote changes, undo, an agent working on the same replica) except the ones this
 * editor just published, which it already shows.
 */
export class TextBinding {
  private readonly unsubscribe: () => void
  private publishing = false

  constructor(
    private readonly replica: Replica,
    private readonly id: ObjectId,
    private readonly field: string,
    private readonly origin: Origin,
    onRemote: (changes: ChangeSpec[]) => void,
  ) {
    this.unsubscribe = replica.subscribeText(id, field, (delta) => {
      if (!this.publishing) onRemote(deltaToChanges(delta))
    })
  }

  /** Publishes a local editor transaction; call it for every transaction the person makes. */
  pushLocal(transaction: Transaction): void {
    if (!transaction.docChanged) return
    this.publishing = true
    try {
      this.replica.transact(this.origin, (tx) => applyChangeSet(tx, this.id, this.field, transaction.changes))
    } finally {
      this.publishing = false
    }
  }

  dispose(): void {
    this.unsubscribe()
  }
}

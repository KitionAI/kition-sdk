/**
 * A `ts-worker` engine module for the loader's tests: a document class for a one-field document
 * written in plain JavaScript (the engine contract's members it is asked for), and a default
 * export that records what it was given.
 */

export const prepared = []

export default async function prepare(init) {
  prepared.push(init)
}

const COMMANDS = [
  { id: 'edit.undo', title: 'Undo', menu: ['Edit'], shortcut: 'Cmd+Z', mutates: true, enabled: false },
  { id: 'edit.redo', title: 'Redo', menu: ['Edit'], shortcut: 'Cmd+Shift+Z', mutates: true, enabled: false },
]

export class NotesDocument {
  constructor(title) {
    this.title = title
    this.revision = 0n
    this.dirty = false
    this.width = 1
    this.height = 1
  }

  static open(_name, bytes) {
    return new NotesDocument(new TextDecoder().decode(bytes))
  }

  render() {
    return new Uint8Array(4)
  }

  renderArea() {
    return new Uint8Array(4)
  }

  execute() {
    return 'null'
  }

  inspect() {
    return JSON.stringify({ title: this.title, canUndo: false, canRedo: false })
  }

  commands() {
    return JSON.stringify(COMMANDS)
  }

  save() {
    return new TextEncoder().encode(this.title)
  }

  markSaved() {
    this.dirty = false
  }

  version() {
    return new Uint8Array(0)
  }

  exportChanges() {
    return new TextEncoder().encode(JSON.stringify({ title: this.title }))
  }

  free() {}
}

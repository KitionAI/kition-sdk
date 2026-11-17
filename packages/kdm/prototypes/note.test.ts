import { EditorState, type ChangeSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { Network, person, type Replica } from '../src/index'
import { noteSchema, TextBinding } from './note'

/** An editor whose state follows remote changes, like a CodeMirror view with the binding. */
class Editor {
  state: EditorState
  readonly binding: TextBinding

  constructor(replica: Replica, id: string, name: string) {
    this.state = EditorState.create({ doc: replica.text(id, 'body') })
    this.binding = new TextBinding(replica, id, 'body', person(`user:${name}`), (changes: ChangeSpec[]) => {
      this.state = this.state.update({ changes }).state
    })
  }

  /** A person's edit: one CodeMirror transaction, possibly with several changes (IME, multi-cursor). */
  edit(changes: ChangeSpec): void {
    const transaction = this.state.update({ changes })
    this.state = transaction.state
    this.binding.pushLocal(transaction)
  }

  get text(): string {
    return this.state.doc.toString()
  }
}

function setup(seed = 1) {
  const net = new Network(noteSchema, 2, seed)
  const id = net.replicas[0].transact(person('user:a'), (tx) => tx.create('Note', {}))
  net.syncAll()
  return { net, id, a: new Editor(net.replicas[0], id, 'a'), b: new Editor(net.replicas[1], id, 'b') }
}

describe('CodeMirror on a KDM text field', () => {
  it('shows one person’s typing in the other editor', () => {
    const { net, id, a, b } = setup()
    a.edit({ from: 0, insert: '# Plan\n' })
    net.syncAll()
    expect(b.text).toBe('# Plan\n')
    expect(net.replicas[1].text(id, 'body')).toBe(b.text)
  })

  it('converges concurrent multi-change transactions with CJK and emoji', () => {
    const { net, id, a, b } = setup(2)
    a.edit({ from: 0, insert: 'Hello world' })
    net.syncAll()
    a.edit({ from: 5, insert: ' 季度😀' })
    b.edit([
      { from: 0, to: 1, insert: 'J' },
      { from: 11, insert: '!' },
    ])
    net.syncAll()
    net.converged()
    expect(a.text).toBe(b.text)
    expect(a.text).toBe(net.replicas[0].text(id, 'body'))
    expect(a.text).toBe('Jello 季度😀 world!')
  })

  it('applies remote changes without publishing them again', () => {
    const { net, a, b } = setup(3)
    a.edit({ from: 0, insert: 'abc' })
    net.syncAll()
    const before = net.replicas[1].version()
    expect(b.text).toBe('abc')
    expect(net.replicas[1].version()).toEqual(before)
  })

  it('undoes a person’s own typing only, and both editors show it', () => {
    const { net, id, a, b } = setup(4)
    a.edit({ from: 0, insert: 'mine ' })
    net.syncAll()
    b.edit({ from: 5, insert: 'theirs' })
    net.syncAll()
    expect(net.replicas[0].undo()).toBe(true)
    net.syncAll()
    expect(net.replicas[1].text(id, 'body')).toBe('theirs')
    expect(a.text).toBe('theirs')
    expect(b.text).toBe('theirs')
  })
})

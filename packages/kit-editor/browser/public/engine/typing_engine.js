/**
 * A `ts-worker` engine for kit-editor's browser tests: a one-text document typed through the
 * engine tools (one text tool that always takes text), with the members a host reaches while the
 * person types (`modelReply`, `changesSince`, `version`, `modelDescribe`, `modelBatch`,
 * `mergeChanges`, `compareChanges`, `restoreState`) and an editor state of its own (`editorState`,
 * `restoreEditorState`, `setContext`), so the editor offers `model`, `draft`, `changes` and
 * `context` as a real kit's does.
 *
 * Its replica is the text and the number of changes made to it (`version`): `snapshot` holds both,
 * `openWithReplica` opens a stored one (`text.read` answers `opened: "replica"`), `exportChanges`
 * is the text after a version, `mergeChanges` takes a draft's text when the document has not
 * changed since the draft's version (a draft edits with `text.append`), and `restoreState` writes
 * a stored snapshot's text over the document: what the release's packed-editor smoke checks
 * (`session.mjs`).
 *
 * Every key and text the tool takes is logged in order (`keys.read`), so a test can tell a key
 * lost or applied out of order from one applied. Three commands are logged there too, for keys
 * that reach the engine as commands rather than tool keys: `mark.arm` (`Arm`, a button of the
 * editor runs it), `mark.put` (`Mark`, shortcut F8, which the editor's own key handler leaves to
 * the frame) and `mark.note` (`Note`, F7, which the editor's key handler runs itself). `mark.put`
 * can run only while armed: `mark.arm` or a typed `(` arms it and running it disarms it, so the
 * list of what can run the editor read after the last change still says F8 cannot run when it is
 * pressed right after what armed it. `setCosts(host, tool)` (the manifest's `setup`)
 * makes each host member and each tool event take that many milliseconds of the worker's one
 * thread, as a large document's would.
 */

export default async function prepare() {}

const COMMANDS = [
  { id: 'text.read', title: 'Read text', menu: [], shortcut: null, mutates: false, enabled: true },
  { id: 'keys.read', title: 'Read keys', menu: [], shortcut: null, mutates: false, enabled: true },
  { id: 'text.append', title: 'Append text', menu: [], shortcut: null, mutates: true, enabled: true },
  { id: 'mark.arm', title: 'Arm', menu: [], shortcut: null, mutates: false, enabled: true },
  { id: 'mark.put', title: 'Mark', menu: [], shortcut: 'F8', mutates: false, enabled: false },
  { id: 'mark.note', title: 'Note', menu: [], shortcut: null, mutates: false, enabled: true },
  { id: 'edit.undo', title: 'Undo', menu: ['Edit'], shortcut: 'Cmd+Z', mutates: true, enabled: false },
  { id: 'edit.redo', title: 'Redo', menu: ['Edit'], shortcut: 'Cmd+Shift+Z', mutates: true, enabled: false },
]

const TOOLS = [{ id: 'text', label: 'Text', shortcut: null, icon: 'type', group: 0 }]

/** Holds the worker's thread for `ms` milliseconds, as a costly engine call does. */
function spend(ms) {
  if (!(ms > 0)) return
  const end = performance.now() + ms
  while (performance.now() < end) {
    // busy
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class TypingDocument {
  constructor(text) {
    this.text = text
    this.anchor = [...text].length
    this.focus = this.anchor
    /** Every key and text the tool took, in order. */
    this.keys = []
    this.changes = 0
    this.revision = 0n
    this.dirty = false
    this.width = 800
    this.height = 600
    this.hostCost = 0
    this.toolCost = 0
    /** Whether `mark.put` can run. */
    this.armed = false
    /** `file`, or `replica` when opened with a stored snapshot. */
    this.opened = 'file'
  }

  static open(_name, bytes) {
    return new TypingDocument(decoder.decode(bytes))
  }

  static openWithReplica(_name, _bytes, snapshot) {
    const stored = JSON.parse(decoder.decode(snapshot))
    const doc = new TypingDocument(stored.text)
    doc.changes = stored.changes
    doc.opened = 'replica'
    return doc
  }

  setCosts(host, tool) {
    this.hostCost = Number(host) || 0
    this.toolCost = Number(tool) || 0
  }

  // The engine contract.
  render(_x, _y, _scale, width, height) {
    return new Uint8Array(width * height * 4).fill(255)
  }

  renderArea(_x0, _y0, _x1, _y1, width, height) {
    return new Uint8Array(width * height * 4).fill(255)
  }

  inspect() {
    return JSON.stringify({ length: [...this.text].length, anchor: this.anchor, focus: this.focus, keys: this.keys.length, canUndo: false, canRedo: false })
  }

  commands() {
    return JSON.stringify(COMMANDS.map((command) => (command.id === 'mark.put' ? { ...command, enabled: this.armed } : command)))
  }

  execute(command, params) {
    if (command === 'text.read') return JSON.stringify({ text: this.text, anchor: this.anchor, focus: this.focus, opened: this.opened, changes: this.changes })
    if (command === 'keys.read') return JSON.stringify({ keys: this.keys })
    if (command === 'mark.arm') {
      this.armed = true
      this.keys.push('Arm')
      return JSON.stringify({ armed: true })
    }
    if (command === 'mark.put') {
      if (!this.armed) throw new Error('mark.put cannot run: not armed')
      this.armed = false
      this.keys.push('Mark')
      return JSON.stringify({ armed: false })
    }
    if (command === 'mark.note') {
      this.keys.push('Note')
      return JSON.stringify({})
    }
    if (command === 'text.append') {
      this.text += String(JSON.parse(params || '{}').text ?? '')
      this.anchor = this.focus = [...this.text].length
      this.changed()
      return JSON.stringify({ text: this.text })
    }
    throw new Error(`no command ${command}`)
  }

  save() {
    return encoder.encode(this.text)
  }

  markSaved() {
    this.dirty = false
  }

  free() {}

  // The engine tools: one text tool that always takes text.
  answer() {
    return JSON.stringify({ requests: [], overlays: [], cursor: 'text', busy: false, wantsText: true })
  }

  tools() {
    return JSON.stringify(TOOLS)
  }

  selectTool() {
    return this.answer()
  }

  pointer() {
    spend(this.toolCost)
    return this.answer()
  }

  toolState() {
    spend(this.toolCost)
    return this.answer()
  }

  toolText(text) {
    spend(this.toolCost)
    this.keys.push(text)
    if (text.includes('(')) this.armed = true
    this.replaceSelection(text)
    return this.answer()
  }

  toolKey(key, modsJson) {
    spend(this.toolCost)
    const mods = JSON.parse(modsJson || '{}')
    const length = [...this.text].length
    this.keys.push(mods.shift ? `Shift+${key}` : key)
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const from = Math.min(this.anchor, this.focus)
      const to = Math.max(this.anchor, this.focus)
      if (mods.shift) this.focus = Math.max(0, Math.min(length, this.focus + (key === 'ArrowLeft' ? -1 : 1)))
      else this.focus = from !== to ? (key === 'ArrowLeft' ? from : to) : Math.max(0, Math.min(length, this.focus + (key === 'ArrowLeft' ? -1 : 1)))
      if (!mods.shift) this.anchor = this.focus
    } else if (key === 'Backspace') {
      if (this.anchor !== this.focus) this.replaceSelection('')
      else if (this.focus > 0) {
        this.anchor = this.focus - 1
        this.replaceSelection('')
      }
    } else if (key === 'Enter') this.replaceSelection('\n')
    else if (key === 'Escape') this.anchor = this.focus
    return this.answer()
  }

  replaceSelection(text) {
    const chars = [...this.text]
    const from = Math.min(this.anchor, this.focus)
    const to = Math.max(this.anchor, this.focus)
    chars.splice(from, to - from, ...text)
    this.text = chars.join('')
    this.anchor = this.focus = from + [...text].length
    this.changed()
  }

  changed() {
    this.changes += 1
    this.revision += 1n
    this.dirty = true
  }

  // The editor state an agent's step runs in apart from the person's.
  editorState() {
    return JSON.stringify({ anchor: this.anchor, focus: this.focus })
  }

  restoreEditorState(state) {
    const parsed = JSON.parse(state)
    if (parsed && typeof parsed === 'object') {
      this.anchor = parsed.anchor
      this.focus = parsed.focus
    }
  }

  setContext() {}

  // The replica and the object model, as a host reaches them while the person types.
  version() {
    return encoder.encode(String(this.changes))
  }

  exportChanges(since) {
    return encoder.encode(JSON.stringify({ since: Number(decoder.decode(since)), changes: this.changes, text: this.text }))
  }

  snapshot() {
    return encoder.encode(JSON.stringify({ text: this.text, changes: this.changes }))
  }

  blobs() {
    return new Uint8Array(0)
  }

  addBlobs() {}

  changesSince(since) {
    spend(this.hostCost)
    const from = Number(decoder.decode(since))
    if (!Number.isFinite(from) || from > this.changes) return JSON.stringify({ changes: null, unavailable: 'unknown version' })
    return JSON.stringify({ changes: { created: [], deleted: [], changed: this.changes > from ? [{ id: 'text', fields: ['text'] }] : [] } })
  }

  modelReply(value) {
    spend(this.hostCost)
    return value
  }

  modelDescribe() {
    spend(this.hostCost)
    return JSON.stringify({ kit: 'kit.typing', root: 'text', types: [{ name: 'Text', fields: [{ name: 'text', kind: 'text' }] }] })
  }

  modelBatch(request) {
    spend(this.hostCost)
    const { ops = [] } = JSON.parse(request)
    if (ops.length) throw new Error(JSON.stringify({ code: 'invalid-op', index: 0, message: 'the typing engine takes no writes' }))
    return JSON.stringify({ refs: {}, results: [], loaded: [{ id: 'text', type: 'Text', fields: { text: this.text } }] })
  }

  /** A draft's changes as this document would take them: its text, or a refusal. */
  draftText(changes) {
    const draft = JSON.parse(decoder.decode(changes))
    if (draft.since !== this.changes) throw new Error(`stale: the document changed since the draft's version ${draft.since}`)
    return draft.text
  }

  compareChanges(changes) {
    spend(this.hostCost)
    const text = this.draftText(changes)
    return JSON.stringify({ created: [], deleted: [], changed: text === this.text ? [] : [{ id: 'text', fields: ['text'] }] })
  }

  mergeChanges(changes) {
    spend(this.hostCost)
    const text = this.draftText(changes)
    if (text === this.text) return JSON.stringify({ damage: { kind: 'none' }, summary: { created: [], deleted: [], changed: [] }, scope: null })
    this.text = text
    this.anchor = this.focus = [...text].length
    this.changed()
    return JSON.stringify({ damage: { kind: 'full' }, summary: { created: [], deleted: [], changed: [{ id: 'text', fields: ['text'] }] }, scope: 'person' })
  }

  restoreState(snapshot) {
    spend(this.hostCost)
    const { text } = JSON.parse(decoder.decode(snapshot))
    if (text === this.text) return JSON.stringify({ kind: 'none' })
    this.text = text
    this.anchor = this.focus = [...text].length
    this.changed()
    return JSON.stringify({ kind: 'full' })
  }
}

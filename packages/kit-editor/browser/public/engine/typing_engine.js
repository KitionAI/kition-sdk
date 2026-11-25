/**
 * A `ts-worker` engine for kit-editor's browser tests: a one-text document typed through the
 * engine tools (one text tool that always takes text), with the members a host reaches while the
 * person types (`modelReply`, `changesSince`, `version`, `modelDescribe`, `modelBatch`,
 * `mergeChanges`, `compareChanges`, `restoreState`) and an editor state of its own (`editorState`,
 * `restoreEditorState`, `setContext`), so the editor offers `model`, `draft`, `changes` and
 * `context` as a real kit's does.
 *
 * Every key and text the tool takes is logged in order (`keys.read`), so a test can tell a key
 * lost or applied out of order from one applied. `setCosts(host, tool)` (the manifest's `setup`)
 * makes each host member and each tool event take that many milliseconds of the worker's one
 * thread, as a large document's would.
 */

export default async function prepare() {}

const COMMANDS = [
  { id: 'text.read', title: 'Read text', menu: [], shortcut: null, mutates: false, enabled: true },
  { id: 'keys.read', title: 'Read keys', menu: [], shortcut: null, mutates: false, enabled: true },
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
  }

  static open(_name, bytes) {
    return new TypingDocument(decoder.decode(bytes))
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
    return JSON.stringify(COMMANDS)
  }

  execute(command) {
    if (command === 'text.read') return JSON.stringify({ text: this.text, anchor: this.anchor, focus: this.focus })
    if (command === 'keys.read') return JSON.stringify({ keys: this.keys })
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

  exportChanges() {
    return encoder.encode(this.text)
  }

  snapshot() {
    return encoder.encode(this.text)
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

  compareChanges() {
    spend(this.hostCost)
    return JSON.stringify({ created: [], deleted: [], changed: [] })
  }

  mergeChanges() {
    spend(this.hostCost)
    return JSON.stringify({ damage: null, summary: { created: 0, deleted: 0, changed: 0 } })
  }

  restoreState() {
    spend(this.hostCost)
    return JSON.stringify(null)
  }
}

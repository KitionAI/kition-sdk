/**
 * What a read-only document (the Kit UI protocol's `document.readOnly`, a viewer's session)
 * refuses. The engine worker enforces these rules on every engine call of every kit; the editor
 * draws from the same rules, so what it offers is what the worker lets through.
 *
 * A kit's `mutates` means "changes the document" (undo, redo, and file commands that replace or
 * save it included; selection, zoom, and navigation not). Film still flags its view and selection
 * commands as edits, so the rules go by command family as well as by the flag. Whatever they let through runs under a backstop: a call that still commits to
 * the replica (or, for an engine without one, makes the document unsaved) is undone and refused.
 *
 * Kits: audit your catalog against `READ_ONLY_RULES`. A command a viewer needs that the rules
 * refuse belongs in `viewingCommands` (or its family in `viewingGroups`); a command in a viewing
 * family that writes to the replica belongs in `documentSettings` (else the backstop undoes and
 * refuses it after the editor offered it), and view state stays out of the replica.
 *
 * A commenter's session (`document.comments.canComment` on a read-only document) runs the kit's
 * comment commands as well (`commentCommands`), under a backstop of their own: a comment command
 * whose change touches anything but `CommentThread` and `Comment` objects (the sync server's rule
 * for a commenter's push) is undone and refused. Undo and Redo take back and bring back the
 * commenter's own comment changes (`commenterHistory`), as many steps as their comment commands
 * made and under the same backstop. Everything else stays as for a viewer; the editor hides what
 * a commenter cannot run (`hiddenForCommenter`) rather than showing it disabled.
 */
import { REDO_COMMANDS, UNDO_COMMANDS } from './kitModel'

/** The reason code a refused call answers with (`error.data.reason` over the protocol). */
export const READ_ONLY_REASON = 'read-only'

export const READ_ONLY_RULES = Object.freeze({
  /**
   * Families whose commands only change what the person sees (zoom, selection, the playhead,
   * playback): they run even when their kit flags them `mutates`.
   */
  viewingGroups: Object.freeze(['view', 'select', 'selection', 'go', 'navigate', 'help', 'playback', 'transport', 'playhead', 'caret']),
  /** Single viewing commands in families that otherwise edit (Film's monitors and markers). */
  viewingCommands: Object.freeze([
    // Selecting everything or nothing (the command naming standard moved them to `edit`).
    'edit.selectAll',
    'edit.deselectAll',
    'marker.goNext',
    'marker.goPrev',
    'marker.goToIn',
    'marker.goToOut',
    'source.open',
    'source.setPlayhead',
    'source.inspect',
    'sequence.open',
    'sequence.moveTab',
    'sequence.inspect',
    'sequence.matchFrame',
    'sequence.revealInProject',
  ]),
  /** Commands refused whatever their flag: the history, which some kits report as not editing. */
  editingCommands: Object.freeze(['edit.undo', 'edit.redo', 'undo', 'redo', 'u']),
  /**
   * Commands in viewing families that change the document all the same, so the editor shows them
   * disabled rather than letting the backstop refuse them: settings a file keeps (a sheet's frozen
   * panes, gridlines, and headings; guides and slices; saved selections and views; a 3D camera).
   * Their kits flag them `mutates`; the viewing families cannot simply follow the flag while a kit
   * (Film) still flags viewing commands as edits.
   */
  documentSettings: Object.freeze([
    // Sheet
    'view.freezePanes',
    'view.freezeTopRow',
    'view.freezeFirstColumn',
    'view.unfreezePanes',
    'view.gridlines',
    'view.headings',
    'view.showZeros',
    'view.rightToLeft',
    'view.newWindow',
    // Motion
    'view.addGuide',
    'view.clearGuides',
    'view.importGuides',
    'view.moveGuide',
    'view.removeGuide',
    'view.lookAtSelected',
    'view.lookAtAll',
    'view.reset3DView',
    // Photo
    'view.newGuide',
    'view.newGuideLayout',
    'view.newGuidesFromShape',
    'view.deleteGuide',
    'view.clearCanvasGuides',
    'view.clearSelectedArtboardGuides',
    'view.clearSlices',
    'view.lockSlices',
    'select.toWorkPath',
    'select.convertToShape',
    'select.saveSelection',
    'select.float',
    'select.drop',
    // Vector
    'view.guides.make',
    'view.guides.release',
    'view.guides.clear',
    'view.guides.lock',
    'view.saved.new',
    'view.saved.edit',
    'select.save',
  ]),
  /** Families refused whatever their commands' flags, except `fileOutputs`. */
  editingGroups: Object.freeze(['file']),
  /** `file` commands that only produce bytes (an export, a copy, a print): they run. */
  fileOutputs: /^file\.(export|saveCopy|saveACopy|print)/,
  /** Engine tool calls that edit (U8a gestures, keys, typed text); `tools`, `toolState`, `selectTool`, `tool` run. */
  refusedTools: Object.freeze(['pointer', 'toolKey', 'toolText']),
  /** Document methods `invoke` refuses: they edit around the contract's checks. */
  refusedMethods: Object.freeze(['executeAs', 'undo', 'redo', 'importChanges', 'addBlobs']),
})

/** Whether running `command` is an edit a read-only document refuses (before the backstop). */
export function editsDocument(command: { id: string; mutates?: boolean | null }) {
  const { id } = command
  const group = id.split('.')[0] ?? ''
  if (READ_ONLY_RULES.editingCommands.includes(id) || READ_ONLY_RULES.documentSettings.includes(id)) return true
  if (READ_ONLY_RULES.editingGroups.includes(group)) return !READ_ONLY_RULES.fileOutputs.test(id)
  if (READ_ONLY_RULES.viewingCommands.includes(id) || READ_ONLY_RULES.viewingGroups.includes(group)) return false
  return command.mutates === true
}

/**
 * The comment commands a commenter's read-only session runs (the Kit UI protocol's
 * `document.comments.canComment`, KitModel rule M23): the kit's `kit.json`
 * `collaboration.comments.commands`, which its editor passes on as `KitModuleManifest.commentCommands`.
 * Never the history or a `file` command, whatever the kit lists: a `file` command stays refused,
 * and Undo and Redo reach only the commenter's own comments (`commenterHistory`). Empty when the
 * person may not comment.
 */
export function commentCommands(listed: readonly string[] | null | undefined, canComment: boolean): ReadonlySet<string> {
  if (!canComment || !listed) return new Set()
  return new Set(listed.filter((id) => typeof id === 'string' && !READ_ONLY_RULES.editingCommands.includes(id) && !READ_ONLY_RULES.editingGroups.includes(id.split('.')[0] ?? '')))
}

/**
 * Whether `id` is Undo or Redo of a commenter's session (`comments` not empty), which takes back
 * or brings back the commenter's own comment changes (KitModel rule M23): the engine
 * worker runs it only while the session has such a step to take, under the comment backstop.
 * `null` for any other command, and for every command of a viewer's session.
 */
export function commenterHistory(id: string, comments: ReadonlySet<string>): 'undo' | 'redo' | null {
  if (comments.size === 0) return null
  return UNDO_COMMANDS.has(id) ? 'undo' : REDO_COMMANDS.has(id) ? 'redo' : null
}

/**
 * Whether a read-only document refuses `command` (before the backstop): an edit that is not one
 * of the session's `comments` (`commentCommands`) or a commenter's Undo and Redo
 * (`commenterHistory`). A comment command runs under the comment backstop instead: what it
 * changes besides `CommentThread` and `Comment` objects is undone and the command refused.
 */
export function refusedReadOnly(command: { id: string; mutates?: boolean | null }, comments: ReadonlySet<string>) {
  return editsDocument(command) && !comments.has(command.id) && commenterHistory(command.id, comments) === null
}

/**
 * Whether a commenter's editor hides `command` (Kit UI protocol `document.comments`): every
 * command the read-only rules refuse them. A commenter sees what they can run (viewing, comment
 * commands, and the history of their comments) instead of a document of disabled edits; a
 * viewer's editor (`comments` empty) still shows the edits, disabled.
 */
export function hiddenForCommenter(command: { id: string; mutates?: boolean | null }, comments: ReadonlySet<string>) {
  return comments.size > 0 && refusedReadOnly(command, comments)
}

/** A refusal because the document is read-only; `reason` is `read-only`. */
export class ReadOnlyError extends Error {
  readonly reason = READ_ONLY_REASON

  /** `what` is refused (as `\`slide.new\``); `message`, when given, is the whole message (one passed on from the worker). */
  constructor(what: string, message?: string) {
    super(message ?? `${what} is not allowed: the document is read-only`)
    this.name = 'ReadOnlyError'
  }
}

/** Whether `error` is a read-only refusal (from the worker, or made on the page). */
export function isReadOnlyError(error: unknown): error is ReadOnlyError {
  return error instanceof ReadOnlyError || (error instanceof Error && (error as { reason?: unknown }).reason === READ_ONLY_REASON)
}

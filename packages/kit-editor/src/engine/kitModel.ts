/**
 * The object model (`KitObjectModel 1.0`) answered by the kit itself: the Kit UI protocol's
 * capability `model` (Kition platform docs/platform/reference/ui-protocol.md section 7a), so a
 * script's batch is a step of the person's own undo history rather than a collaborator's change.
 * The kit's engine answers `modelDescribe()` and `modelBatch(json)` itself
 * (`export_kit_session!`); a batch is one undo group of its session. An engine without them has
 * no object model (`info.model: null`).
 */
import type { ModelErrorData } from '@kition/kit-ui-protocol'
import type { KitModuleDocument } from './kitModule'

export type { ModelErrorData }

/** How a kit's engine answers the object model, if it does. */
export type KitModelSupport = 'engine' | null

export function modelSupport(open: KitModuleDocument): KitModelSupport {
  return typeof open.modelBatch === 'function' && typeof open.modelDescribe === 'function' ? 'engine' : null
}

/** A refused batch: `data` is the protocol's `{ code, index, message }`. */
export class KitModelError extends Error {
  constructor(readonly data: ModelErrorData) {
    super(data.message)
    this.name = 'KitModelError'
  }
}

/** Whether a batch request writes: every operation does; `load` alone only reads. */
export function batchWrites(request: { ops?: unknown }): boolean {
  return Array.isArray(request.ops) && request.ops.length > 0
}

/** The history commands, by id (as `READ_ONLY_RULES.editingCommands` lists them). */
// CAD's own history commands, named by the command naming standard (2026-11-25; were `undo` and `redo`).
export const UNDO_COMMANDS: ReadonlySet<string> = new Set(['edit.undo', 'edit.undoMany'])
export const REDO_COMMANDS: ReadonlySet<string> = new Set(['edit.redo', 'edit.redoStep'])

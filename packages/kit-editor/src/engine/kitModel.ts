/**
 * The object model (`KitObjectModel 1.0`) answered by the kit itself: the Kit UI protocol's
 * capability `model` (Kition platform docs/platform/reference/ui-protocol.md section 7a), so a script's batch is a step of the
 * person's own undo history rather than a collaborator's change. This module is what the page and
 * the worker share; the worker runs batches in `kitModelRunner.ts`.
 *
 * Two ways in, by what the kit's engine offers:
 * - `engine`: the engine answers `modelDescribe()` and `modelBatch(json)` itself
 *   (`export_kit_session!`); a batch is one undo group of its session.
 * - `replica`: any contract 2 engine (it exchanges changes): the worker keeps a scratch replica of
 *   the document, runs each run of model operations as one transaction on it, and hands the
 *   changes to the engine. Those steps are kept in a script history next to the engine's own, so
 *   Undo and Redo reach them in order (see `ReplicaModel`).
 */
import type { ModelErrorData } from '@kition/kit-ui-protocol'
import type { KitModuleDocument } from './kitModule'

export type { ModelErrorData }

/** How a kit's engine answers the object model, if it does. */
export type KitModelSupport = 'engine' | 'replica' | null

export function modelSupport(open: KitModuleDocument): KitModelSupport {
  if (typeof open.modelBatch === 'function' && typeof open.modelDescribe === 'function') return 'engine'
  if (typeof open.exportChanges === 'function' && typeof open.importChanges === 'function' && typeof open.version === 'function') return 'replica'
  return null
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
export const UNDO_COMMANDS: ReadonlySet<string> = new Set(['edit.undo', 'undo'])
export const REDO_COMMANDS: ReadonlySet<string> = new Set(['edit.redo', 'redo'])

/**
 * The object-level difference between two states of one document (standard 2.0 A13): what a
 * change created, changed, moved, and deleted. The engine answers it (the Rust
 * `kition_kdm::diff`: a draft's comparison, a write's receipt); TypeScript carries it.
 */

/** Where an object sits: the object whose list or tree field holds it (a tree node's parent object, or the tree's owner for a root), that field, and its index among its siblings. */
export type Position = { parent: string; field: string; index: number }

/** One field a change changed: its value before and after, values cut to excerpts. */
export type TextSpan = {offset:number;removed:string;inserted:string;removedLength:number;insertedLength:number;before:string;after:string;complete:boolean}
export type FieldEdit = { field: string; before: unknown; after: unknown; named?: string; span?: TextSpan; spansTruncated?: boolean }

/**
 * One object in a `StateDiff`: its id, its type, and the fields concerned (sorted). A created
 * object also gives `values` (list and tree fields left out) and `at`, where a list or tree holds
 * it; a deleted one `at`, where a list or tree held it; a changed one gives `edits`.
 */
export type ObjectChange = { id: string; type: string; fields: string[]; values?: Record<string, unknown>; at?: Position; edits?: FieldEdit[] }

/** An object whose place in a list or tree changed; `from` or `to` is `null` where no changed list holds it. */
export type Move = { id: string; type: string; from: Position | null; to: Position | null }

/** A text-like field (a `text` field, or a string) a draft changed, as plain text before and after. */
export type TextChange = { id: string; field: string; before: string; after: string }

/**
 * What changed between two states, each list sorted by object id (then field): `created` objects
 * only `after` has (`fields`: those holding a value), `changed` objects whose fields differ,
 * `moved` objects whose place in a list or tree changed (also in `changed` when their fields did),
 * `deleted` objects only `before` has (`at`: where a list or tree held them), and `texts`, the full text of changed text-like fields, which
 * only a draft's comparison has. `footprint` states a shift of many objects once
 *; a diff never fills it.
 */
export type StateDiff = {
  created: ObjectChange[]
  changed: ObjectChange[]
  moved: Move[]
  deleted: ObjectChange[]
  texts?: TextChange[]
  footprint?: unknown
}

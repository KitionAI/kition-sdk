/**
 * Object-model batches (`KitObjectModel 1.0`, Kition platform `docs/platform/sets/object-model.md`):
 * the request and result types, the batch error, and the schema of a kit's `model/describe`
 * answer. Batches run in the kit's engine (the Rust `kition_kdm::batch`); TypeScript carries them.
 */
import { errors } from './errors'
import type { Origin } from './origin'
import { KDM_VERSION, parseSchema, type Schema } from './schema'

export const OBJECT_MODEL_CAPABILITY = 'KitObjectModel 1.0'

export type BatchErrorCode = 'invalid-op' | 'not-found' | 'invalid-value' | 'read-only' | 'command-failed'

export class BatchError extends Error {
  readonly code: BatchErrorCode
  readonly index: number | null

  constructor(code: BatchErrorCode, index: number | null, message: string) {
    super(message)
    this.name = 'BatchError'
    this.code = code
    this.index = index
  }

  toJSON() {
    return { code: this.code, index: this.index, message: this.message }
  }
}

export type BatchOp = { op: string; [key: string]: unknown }
export type BatchRequest = { origin?: Origin | null; ops?: BatchOp[]; load?: Array<{ target: string; fields?: string[] }>; objects?: boolean }
export type LoadedObject = { id: string; type: string; fields: Record<string, unknown>; projected?: boolean; at?: { parent: string; field: string; index?: number; node?: string } }
export type BatchResult = { refs: Record<string, string>; results: unknown[]; loaded: LoadedObject[]; objects?: Array<{id:string;type:string}> }

/**
 * The schema a kit's `model/describe` answer describes (Rust's `kition_kits::drafts::schema_of`),
 * for a reader that has no other. The description names a text field's marks by key (OM1), not
 * their definitions (M4c): each expands after here, which only editing a marked text reads.
 */
export function schemaOfDescription(description: object): Schema {
  const described = description as Record<string, unknown>
  for (const name of ['kit', 'schemaVersion', 'root', 'types']) {
    if (described[name] === undefined) throw errors.schema(`the kit's description has no \`${name}\``)
  }
  const types: Record<string, unknown> = {}
  for (const [ty, def] of Object.entries(described.types as Record<string, { fields?: Record<string, Record<string, unknown>> }>)) {
    const fields: Record<string, unknown> = {}
    for (const [name, field] of Object.entries(def.fields ?? {})) {
      fields[name] = Array.isArray(field.marks) ? { ...field, marks: Object.fromEntries(field.marks.map((mark) => [mark, { expand: 'after' }])) } : field
    }
    types[ty] = { ...def, fields }
  }
  return parseSchema({ kdm: KDM_VERSION, kit: described.kit, schemaVersion: described.schemaVersion, root: described.root, types })
}

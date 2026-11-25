/**
 * Reading the content encoding (data model, "The content encoding"): a file's `content.json`, or
 * with a `version` a replica's snapshot. Only the Rust KDM writes it; this reads it with the
 * Rust `content::decode` rules. The objects' fields are read by the store (`store.ts`), which
 * knows their kinds from the schema.
 */
import { errors } from './errors'
import { KDM_VERSION } from './schema'
import type { JsonValue } from './value'

/** A snapshot's version: the line of changes and how many changes of it the state holds. */
export type ContentVersion = { lineage: string; seq: number; authorSchemaVersion: number | null }

/** Content as read: its header and each object's stored fields (`$type` included). */
export type Content = {
  kit: string
  docId: string
  schemaVersion: number
  version: ContentVersion | null
  objects: Map<string, Record<string, JsonValue>>
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ANY_UUID = /^(?:\{|urn:uuid:)?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i

/** Checks a UUID that must be in its lowercase hyphenated form (a document id, a lineage). */
export function checkUuid(text: unknown, what: string): string {
  if (typeof text !== 'string' || !CANONICAL_UUID.test(text)) throw errors.encoding(`not KDM content: ${what} is not a lowercase hyphenated UUID`)
  return text
}

/**
 * Checks an object id as content names it: an id in UUID form must be lowercase and hyphenated
 * (an id a host chose in another form, such as `page:1`, is kept as it is).
 */
export function checkObjectId(text: unknown, what: string): string {
  if (typeof text !== 'string' || text === '') throw errors.encoding(`not KDM content: ${what} is not an object id`)
  if (ANY_UUID.test(text) && !CANONICAL_UUID.test(text)) throw errors.encoding(`not KDM content: ${what} \`${text}\` is not a lowercase hyphenated UUID`)
  return text
}

const isRecord = (value: unknown): value is Record<string, JsonValue> => value !== null && typeof value === 'object' && !Array.isArray(value)

const isU64 = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const HEADER = ['kdm', 'kit', 'docId', 'version', 'schemaVersion', 'objects']

/** Content from its JSON (already read strictly: no duplicate keys). */
export function decodeContent(value: JsonValue): Content {
  const bad = (reason: string) => errors.encoding(`not KDM content: ${reason}`)
  if (!isRecord(value)) throw bad('not a JSON object')
  const unknown = Object.keys(value).find((key) => !HEADER.includes(key))
  if (unknown !== undefined) throw bad(`unknown key \`${unknown}\``)
  if (!isU64(value.kdm)) throw bad('`kdm` is missing')
  if (value.kdm !== KDM_VERSION) throw errors.schema(`the document uses kdm ${value.kdm}; this build reads ${KDM_VERSION}`)
  if (typeof value.kit !== 'string') throw bad('`kit` is missing')
  if (value.docId === undefined) throw bad('`docId` is missing')
  const docId = checkUuid(value.docId, '`docId`')
  if (!isU64(value.schemaVersion)) throw bad('`schemaVersion` is missing')
  let version: ContentVersion | null = null
  if (value.version !== undefined) {
    const held = value.version
    if (!isRecord(held) || !Object.keys(held).every((key) => key === 'lineage' || key === 'seq' || key === 'authorSchemaVersion')) throw bad('`version` is not {lineage, seq}')
    const lineage = checkUuid(held.lineage, '`version.lineage`')
    if (!isU64(held.seq)) throw bad('`version.seq`')
    const author = held.authorSchemaVersion
    if (author !== undefined && !isU64(author)) throw bad('`version.authorSchemaVersion`')
    version = { lineage, seq: held.seq as number, authorSchemaVersion: author === undefined ? null : (author as number) }
  }
  if (!isRecord(value.objects)) throw bad('`objects` is missing')
  const objects = new Map<string, Record<string, JsonValue>>()
  for (const id of Object.keys(value.objects)) {
    checkObjectId(id, 'an object id')
    const fields = value.objects[id]
    if (!isRecord(fields)) throw bad(`object \`${id}\` is not a JSON object`)
    if (typeof fields.$type !== 'string') throw errors.encoding(`object \`${id}\` has no \`$type\``)
    objects.set(id, fields)
  }
  return { kit: value.kit, docId, schemaVersion: value.schemaVersion, version, objects }
}

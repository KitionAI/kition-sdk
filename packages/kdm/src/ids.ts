import { errors } from './errors'

/** The stable identity of one object in a document, unique across all replicas. */
export type ObjectId = string

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The hyphenated lowercase form of 16 UUID bytes. */
export function uuidFromBytes(bytes: Uint8Array): string {
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
}

const UUID_FORMS = [
  /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i,
  /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i,
  /^([0-9a-f]{32})$/i,
]

/** The 16 bytes of a UUID in any form the Rust `uuid` crate parses; anything else is an `encoding` error. */
export function uuidToBytes(text: string): Uint8Array {
  if (typeof text !== 'string') throw errors.encoding('a UUID is a string')
  for (const form of UUID_FORMS) {
    const match = form.exec(text)
    if (!match) continue
    const digits = match.slice(1).join('')
    const bytes = new Uint8Array(16)
    for (let index = 0; index < 16; index += 1) bytes[index] = parseInt(digits.slice(index * 2, index * 2 + 2), 16)
    return bytes
  }
  throw errors.encoding(`\`${text}\` is not a UUID`)
}

/** A UUID v7: 48-bit Unix milliseconds, version and variant bits, the rest random. */
export function uuidV7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let time = BigInt(now)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn)
    time >>= 8n
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return uuidFromBytes(bytes)
}

/** A new object id. UUID v7: unique without coordination and roughly creation-ordered. */
export const newObjectId = (): ObjectId => uuidV7()

/** A new document id: a document's durable identity, never changed by renaming or moving its file. */
export const newDocId = (): string => uuidV7()

/** Only this module constructs handles. */
const CONSTRUCT = Symbol('NodeRef')

/**
 * A node of a tree field, as `Replica.tree` lists it: it names the object that is the node (one
 * node per object in a tree). Handles compare with `equals`; they cannot be constructed outside
 * the KDM.
 */
export class NodeRef {
  /** The node's object id. */
  declare readonly id: string

  /** @internal */
  constructor(token: symbol, id: string) {
    if (token !== CONSTRUCT) throw new TypeError('NodeRef handles come from Replica.tree')
    Object.defineProperty(this, 'id', { value: id, enumerable: true, writable: false, configurable: false })
  }

  equals(other: NodeRef): boolean {
    return this.id === other.id
  }
}

/** @internal The handle of the node of object `id`. */
export const nodeOf = (id: string): NodeRef => new NodeRef(CONSTRUCT, id)

/** One node of a tree field, as `Replica.tree` lists it. */
export interface TreeEntry {
  node: NodeRef
  /** The object the node names. */
  object: ObjectId
  /** `null` for a root. */
  parent: NodeRef | null
}

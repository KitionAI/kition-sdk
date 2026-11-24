/** Versions, and the envelope every byte string a replica exports carries. */
import { VersionVector, type PeerID } from 'loro-crdt'
import { errors, KdmError } from './errors'

/** A replica's version: the set of changes it contains. Exchanged to ask for what is missing. */
export class Version {
  /** Each peer's counter, sorted by peer id (a number): compares structurally and encodes canonically. */
  private readonly counters: ReadonlyArray<readonly [string, number]>

  private constructor(counters: Array<readonly [string, number]>) {
    this.counters = counters.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : BigInt(a[0]) > BigInt(b[0]) ? 1 : 0))
  }

  static empty(): Version {
    return new Version([])
  }

  static decode(bytes: Uint8Array): Version {
    let vv: VersionVector
    try {
      vv = VersionVector.decode(bytes)
    } catch (error) {
      throw errors.encoding(String(error))
    }
    return Version.fromEngine(vv)
  }

  /** @internal */
  static fromEngine(vv: VersionVector): Version {
    return new Version([...vv.toJSON().entries()])
  }

  /** @internal */
  toEngine(): VersionVector {
    return VersionVector.parseJSON(new Map(this.counters as Array<[PeerID, number]>))
  }

  /**
   * The version's canonical bytes: equal versions encode to the same bytes, here and in the Rust
   * KDM, so a host may compare and store them as they are (docs/platform/data-model.md, "Version
   * bytes"). The engine's own encoding writes its entries in the order of its hash map, which two
   * equal versions need not share. These are the same format, a postcard map (an entry count,
   * then each actor id and counter as varints, the counter zigzagged), with the entries sorted by
   * actor id; the engine decodes them, and they decode bytes it wrote.
   */
  encode(): Uint8Array {
    const bytes: number[] = []
    varint(bytes, BigInt(this.counters.length))
    for (const [peer, counter] of this.counters) {
      varint(bytes, BigInt(peer))
      varint(bytes, BigInt(((counter << 1) ^ (counter >> 31)) >>> 0))
    }
    return Uint8Array.from(bytes)
  }

  /**
   * Whether every change in `other` is in this version. Versions are partially ordered: of two
   * replicas that changed concurrently, neither version includes the other.
   */
  includes(other: Version): boolean {
    if (!(other instanceof Version)) throw new KdmError('invalid-value', 'a version must be a `Version`')
    const mine = new Map(this.counters)
    return other.counters.every(([peer, counter]) => counter <= (mine.get(peer) ?? 0))
  }

  equals(other: Version): boolean {
    return this.counters.length === other.counters.length && this.counters.every(([peer, counter], index) => peer === other.counters[index][0] && counter === other.counters[index][1])
  }
}

/** `value` as an unsigned LEB128 varint, as postcard writes integers. */
function varint(bytes: number[], value: bigint): void {
  while (value >= 0x80n) {
    bytes.push(Number(value & 0x7fn) | 0x80)
    value >>= 7n
  }
  bytes.push(Number(value))
}

/** Every byte string a replica exports: 4-byte magic, the 16-byte document UUID, then the engine's bytes. */
const MAGIC = [0x4b, 0x44, 0x4d, 0x01]

/**
 * `bytes` (a Loro snapshot or update) in the envelope of the document `docId` (16 bytes): what
 * `Replica.load` and `openEnvelope` read. Exported as `wrapEnvelope`.
 */
export function wrap(docId: Uint8Array, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(MAGIC.length + docId.length + bytes.length)
  out.set(MAGIC)
  out.set(docId, MAGIC.length)
  out.set(bytes, MAGIC.length + docId.length)
  return out
}

export function open(bytes: Uint8Array): { docId: Uint8Array; engine: Uint8Array } {
  if (!(bytes instanceof Uint8Array)) throw errors.encoding('the bytes are not a Uint8Array')
  if (bytes.length < 20 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw errors.encoding('the bytes are not a KDM export')
  return { docId: bytes.subarray(4, 20), engine: bytes.subarray(20) }
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, index) => byte === b[index])

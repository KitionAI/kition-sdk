/**
 * A replica's version (plan 2026-11-24, section 1.3): its line of changes (`lineage`, a UUID) and
 * how many changes of that line its state holds (`seq`). Two replicas at one version hold one
 * state. The same bytes as the Rust `Version::encode`: none for the empty version, else the 16
 * lineage bytes and `seq` as 8 bytes big-endian.
 */
import { errors } from './errors'
import { uuidFromBytes, uuidToBytes } from './ids'

export class Version {
  private constructor(
    /** The lineage as UUID text, `null` for the empty version. */
    readonly lineage: string | null,
    readonly seq: number,
  ) {}

  /** The version before everything: every version includes it. */
  static empty(): Version {
    return new Version(null, 0)
  }

  /** @internal The version `seq` of line `lineage`. */
  static at(lineage: string, seq: number): Version {
    return new Version(lineage, seq)
  }

  static decode(bytes: Uint8Array): Version {
    if (bytes.length === 0) return Version.empty()
    if (bytes.length !== 24) throw errors.encoding(`a version is 0 or 24 bytes, not ${bytes.length}`)
    let seq = 0n
    for (let index = 16; index < 24; index += 1) seq = (seq << 8n) | BigInt(bytes[index])
    if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw errors.encoding(`the version's seq ${seq} is beyond 2^53`)
    return new Version(uuidFromBytes(bytes.subarray(0, 16)), Number(seq))
  }

  encode(): Uint8Array {
    if (this.lineage === null) return new Uint8Array(0)
    const out = new Uint8Array(24)
    out.set(uuidToBytes(this.lineage), 0)
    let seq = BigInt(this.seq)
    for (let index = 23; index >= 16; index -= 1) {
      out[index] = Number(seq & 0xffn)
      seq >>= 8n
    }
    return out
  }

  isEmpty(): boolean {
    return this.lineage === null
  }

  equals(other: Version): boolean {
    return this.lineage === other.lineage && this.seq === other.seq
  }

  /** Whether this version holds every change `other` holds: `other` is empty, or on the same line and not after this one. */
  includes(other: Version): boolean {
    if (other.lineage === null) return true
    return this.lineage === other.lineage && this.seq >= other.seq
  }
}

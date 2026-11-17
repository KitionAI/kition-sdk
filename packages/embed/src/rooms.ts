/**
 * What an editor remembers of each room it co-edits, keyed by the room's document id in the
 * integrator's `storage.state` (by default one `localStorage` entry, `kition.embed.rooms.v1`):
 * the file it belongs to, this person's role, a share link, and how far the room and the replica
 * have caught up with each other (`lastSent`, `seen`), so a later session sends and pulls only
 * what is new.
 */
import type { Role } from '@kition/sync'
import type { EmbedState } from './types'

export const ROOMS_KEY = 'kition.embed.rooms.v1'

export type RoomRecord = {
  docId: string
  fileId: string
  kit: string
  role: Role
  /** The link this editor made or opened the room with, if any. */
  shareLink?: string
  /** The replica version the room is known to hold from this side (lowercase hex). */
  lastSent?: string
  /** The last server `seq` this side had every change up to, and its replica version then (hex). */
  seen?: { seq: number; version: string }
}

const ROLES: readonly string[] = ['owner', 'editor', 'viewer']

function isRecord(value: unknown, docId: string): value is RoomRecord {
  const record = value as Partial<RoomRecord> | null
  return Boolean(record) && typeof record === 'object' && record!.docId === docId && typeof record!.fileId === 'string' && typeof record!.kit === 'string' && ROLES.includes(record!.role as string)
}

/** `storage.state`'s default: every record in one `localStorage` entry, or memory without one. */
export function localState(storage: Storage | null = defaultStorage()): EmbedState {
  const memory: Record<string, unknown> = {}
  const readAll = (): Record<string, unknown> => {
    if (!storage) return memory
    try {
      const parsed = JSON.parse(storage.getItem(ROOMS_KEY) || '{}') as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return {
    get: (key) => readAll()[key] ?? null,
    set: (key, value) => {
      if (!storage) {
        memory[key] = value
        return
      }
      storage.setItem(ROOMS_KEY, JSON.stringify({ ...readAll(), [key]: value }))
    },
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The records in `state`; changes are made one at a time, so none is lost to another. */
export class RoomRecords {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly state: EmbedState) {}

  async read(docId: string): Promise<RoomRecord | null> {
    await this.queue.catch(() => undefined)
    const value = await this.state.get(docId)
    return isRecord(value, docId) ? value : null
  }

  write(record: RoomRecord): Promise<void> {
    return this.run(async () => {
      await this.state.set(record.docId, record)
    })
  }

  /** Changes the record of `docId`, if there is one. */
  update(docId: string, patch: Partial<Omit<RoomRecord, 'docId'>>): Promise<void> {
    return this.run(async () => {
      const value = await this.state.get(docId)
      if (isRecord(value, docId)) await this.state.set(docId, { ...value, ...patch })
    })
  }

  private run(step: () => Promise<void>) {
    const next = this.queue.catch(() => undefined).then(step)
    this.queue = next
    return next
  }
}

export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string | undefined) {
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return new Uint8Array()
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}

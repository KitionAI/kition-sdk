/**
 * Conflict objects (Kit UI protocol section 7c, KitModel rule M22): when a kit's
 * repair pass after a merge cannot resolve something by itself (a peer's edit made against a file
 * another peer rewrote in full), it records a `Conflict` object in the document that keeps what
 * could not be kept, and the editor tells the host, which shows a notice. A later transaction
 * resolves a conflict by deleting its object.
 */
import { useEffect } from 'react'
import type { KitConflict } from '@kition/kit-ui-protocol'
import type { HostConnection } from './host'

export type { KitConflict }

const reported = new WeakMap<HostConnection, string>()

/** Parses an engine's conflict list (JSON or a value): the well-formed entries, ordered by id. */
export function parseConflicts(value: unknown): KitConflict[] {
  let list = value
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  return list
    .filter((item): item is KitConflict => Boolean(item) && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.summary === 'string')
    .map(({ id, kind, summary }) => ({ id, kind, summary }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Tells the host the document's unresolved conflicts (`document/conflicts`) when they changed since last told. */
export function reportConflicts(host: HostConnection, conflicts: KitConflict[]) {
  const key = JSON.stringify(conflicts.map((conflict) => conflict.id))
  if ((reported.get(host) ?? '[]') === key) return
  reported.set(host, key)
  host.peer.notify('document/conflicts', { conflicts })
}

/**
 * Reads the document's conflicts with `read` after every change (`revision`) and reports them
 * when they changed. `read` failing (an engine without conflicts) reports nothing.
 */
export function useConflictReport(host: HostConnection, read: (() => Promise<unknown>) | null, revision: number) {
  useEffect(() => {
    if (!read) return undefined
    let cancelled = false
    read().then(
      (value) => {
        if (!cancelled) reportConflicts(host, parseConflicts(value))
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [host, read, revision])
}

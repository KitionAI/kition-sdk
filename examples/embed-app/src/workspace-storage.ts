/**
 * The example's documents kept on its own server (serve.mjs with EMBED_WORKSPACE, workspace.mjs):
 * the same `StorageProvider` shape as the browser store, over files an agent may also edit. The
 * list is polled, so an agent's save shows as a new version, and `stamp` asks the server, so the
 * editor sees the file move on and never writes over it.
 */
import { EmbedConflictError, type StorageProvider } from '@kition/embed'
import type { ExampleFile } from './storage'

type Listed = { name: string; version: number; size: number }

const url = (name?: string, query = '') => `/api/files${name ? `/${encodeURIComponent(name)}` : ''}${query}`

async function ok(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`)
  return response
}

export class WorkspaceFileStore {
  private readonly files = new Map<string, ExampleFile>()
  private readonly listeners = new Set<() => void>()

  private constructor() {}

  static async open(pollMs = 1_500) {
    const store = new WorkspaceFileStore()
    await store.refresh()
    setInterval(() => void store.refresh().catch(() => {}), pollMs)
    return store
  }

  list() {
    return [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string) {
    return this.files.get(id) ?? null
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async add(name: string, bytes: Uint8Array) {
    const response = await fetch(url(name), { method: 'PUT', headers: { 'x-expected-version': 'none' }, body: bytes.slice() })
    if (response.status === 409) throw new Error(`${name} exists`)
    const { version } = (await (await ok(response)).json()) as { version: number }
    const file: ExampleFile = { id: name, name, bytes: bytes.slice(), version, saves: 0 }
    this.files.set(name, file)
    this.changed()
    return file
  }

  async remove(id: string) {
    await ok(await fetch(url(id), { method: 'DELETE' }))
    this.files.delete(id)
    this.changed()
  }

  /** Reads the server's list; files that are new or have a new version are fetched again. */
  async refresh() {
    const listed = (await (await ok(await fetch(url()))).json()) as Listed[]
    let changed = listed.length !== this.files.size
    const names = new Set(listed.map((item) => item.name))
    for (const id of this.files.keys()) if (!names.has(id)) this.files.delete(id)
    for (const item of listed) {
      const known = this.files.get(item.name)
      if (known && known.version === item.version) continue
      const response = await ok(await fetch(url(item.name)))
      const bytes = new Uint8Array(await response.arrayBuffer())
      const version = Number(response.headers.get('x-file-version') ?? item.version)
      this.files.set(item.name, { id: item.name, name: item.name, bytes, version, saves: known?.saves ?? 0 })
      changed = true
    }
    if (changed) this.changed()
  }

  /** The provider an editor of these files uses. */
  provider(): StorageProvider {
    return {
      read: async (fileId) => {
        const response = await ok(await fetch(url(fileId)))
        const bytes = new Uint8Array(await response.arrayBuffer())
        return { bytes, version: `v${response.headers.get('x-file-version')}` }
      },
      stamp: async (fileId) => {
        const { version } = (await (await ok(await fetch(url(fileId, '?stamp')))).json()) as { version: number | null }
        return version === null ? null : `v${version}`
      },
      write: async (fileId, bytes, { expectedVersion }) => {
        const headers: Record<string, string> = expectedVersion === null ? {} : { 'x-expected-version': expectedVersion.replace(/^v/, '') }
        const response = await fetch(url(fileId), { method: 'PUT', headers, body: bytes.slice() })
        if (response.status === 409) {
          const { version } = (await response.json()) as { version: number | null }
          throw new EmbedConflictError(fileId, version === null ? null : `v${version}`)
        }
        const { version } = (await (await ok(response)).json()) as { version: number }
        const known = this.files.get(fileId)
        this.files.set(fileId, { id: fileId, name: fileId, bytes: bytes.slice(), version, saves: (known?.saves ?? 0) + 1 })
        this.changed()
        return { version: `v${version}` }
      },
      create: async (name, bytes) => {
        const file = await this.add(name, bytes)
        return { fileId: file.id, name: file.name, version: `v${file.version}` }
      },
    }
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }
}

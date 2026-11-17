/**
 * The example's documents: a `StorageProvider` over files kept in memory and mirrored to this
 * browser's IndexedDB, so they outlive a reload. Versions count writes (`v1`, `v2`, …); a write
 * over a version that moved on is refused with `EmbedConflictError`, as `@kition/embed` expects.
 */
import { EmbedConflictError, type StorageProvider } from '@kition/embed'

export type ExampleFile = { id: string; name: string; bytes: Uint8Array; version: number; saves: number }

const DATABASE = 'embed-app'
const STORE = 'files'

function request<T>(run: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = run()
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error ?? new Error('IndexedDB failed'))
  })
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, { keyPath: 'id' })
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB failed'))
  })
}

export class FileStore {
  private readonly files = new Map<string, ExampleFile>()
  private readonly listeners = new Set<() => void>()

  private constructor(private readonly database: IDBDatabase) {}

  static async open() {
    const database = await openDatabase()
    const store = new FileStore(database)
    const all = (await request(() => database.transaction(STORE, 'readonly').objectStore(STORE).getAll())) as ExampleFile[]
    for (const file of all) store.files.set(file.id, { ...file, saves: file.saves ?? 0 })
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
    const file: ExampleFile = { id: crypto.randomUUID(), name, bytes: bytes.slice(), version: 1, saves: 0 }
    await this.put(file)
    return file
  }

  async remove(id: string) {
    this.files.delete(id)
    await request(() => this.database.transaction(STORE, 'readwrite').objectStore(STORE).delete(id))
    this.changed()
  }

  /** The provider an editor of these files uses. */
  provider(): StorageProvider {
    return {
      read: async (fileId) => {
        const file = this.files.get(fileId)
        if (!file) throw new Error(`no file ${fileId}`)
        return { bytes: file.bytes.slice(), version: `v${file.version}` }
      },
      stamp: async (fileId) => {
        const file = this.files.get(fileId)
        return file ? `v${file.version}` : null
      },
      write: async (fileId, bytes, { expectedVersion }) => {
        const file = this.files.get(fileId)
        if (!file) throw new Error(`no file ${fileId}`)
        if (expectedVersion !== null && expectedVersion !== `v${file.version}`) throw new EmbedConflictError(fileId, `v${file.version}`)
        const next = { ...file, bytes: bytes.slice(), version: file.version + 1, saves: file.saves + 1 }
        await this.put(next)
        return { version: `v${next.version}` }
      },
      create: async (name, bytes) => {
        const file = await this.add(name, bytes)
        return { fileId: file.id, name: file.name, version: `v${file.version}` }
      },
    }
  }

  private async put(file: ExampleFile) {
    this.files.set(file.id, file)
    await request(() => this.database.transaction(STORE, 'readwrite').objectStore(STORE).put(file))
    this.changed()
  }

  private changed() {
    for (const listener of this.listeners) listener()
  }
}

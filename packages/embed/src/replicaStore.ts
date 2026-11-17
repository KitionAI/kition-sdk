/**
 * Where a collaboration session keeps its document's replica when the integrator's storage has
 * no `replica` store: this browser's IndexedDB, keyed by the file id, or memory where IndexedDB is
 * unavailable (the replica then lasts as long as the page).
 */
import type { StoredReplica } from '@kition/kit-ui-protocol'
import type { ReplicaStore } from './types'

const DATABASE = 'kition.embed'
const STORE = 'replicas'

export function memoryReplicaStore(): ReplicaStore {
  const replicas = new Map<string, StoredReplica>()
  return {
    read: async (fileId) => replicas.get(fileId) ?? null,
    write: async (fileId, replica) => {
      replicas.set(fileId, replica)
    },
  }
}

function request<T>(run: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = run()
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error ?? new Error('IndexedDB failed'))
  })
}

export function indexedDbReplicaStore(factory: IDBFactory | undefined = globalThis.indexedDB): ReplicaStore {
  if (!factory) return memoryReplicaStore()
  let database: Promise<IDBDatabase> | null = null
  const open = () => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1)
      opening.onupgradeneeded = () => opening.result.createObjectStore(STORE)
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error ?? new Error('IndexedDB failed'))
    }).catch((error: unknown) => {
      database = null
      throw error
    })
    return database
  }
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE)
  return {
    read: async (fileId) => {
      const objects = await store('readonly')
      const stored = (await request(() => objects.get(fileId))) as StoredReplica | undefined
      return stored ?? null
    },
    write: async (fileId, replica) => {
      const objects = await store('readwrite')
      await request(() => objects.put(replica, fileId))
    },
  }
}

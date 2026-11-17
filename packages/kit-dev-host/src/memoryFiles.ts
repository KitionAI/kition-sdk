/**
 * The development host's in-memory folder as KitFiles storage (`@kition/kit-host`'s
 * `KitFilesStorage`): workspace-relative paths are its references, folders are the paths' prefixes
 * (and any added empty), and a hidden segment (a leading dot) is never visible to the kit (LR2).
 */
import { fileError, type KitFileEntry, type KitFilesStorage } from '@kition/kit-host'

export type MemoryFile = { bytes: ArrayBuffer; version: number }

const MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain', json: 'application/json' }

const hidden = (path: string) => path.split('/').some((segment) => segment.startsWith('.') || segment === '')
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/**
 * Storage over `files` (path → bytes and version). `documentFolder` is where new files go without
 * a folder handle; `folders` are empty folders that exist too.
 */
export function memoryFilesStorage(files: Map<string, MemoryFile>, documentFolder: () => string, folders: Set<string> = new Set()): KitFilesStorage {
  const isFolder = (path: string) => folders.has(path) || [...files.keys()].some((name) => name.startsWith(`${path}/`))
  const stat = (path: string): KitFileEntry | null => {
    if (hidden(path)) return null
    const file = files.get(path)
    if (file) {
      const mime = MIME[path.split('.').pop()?.toLowerCase() ?? '']
      return { kind: 'file', size: file.bytes.byteLength, version: String(file.version), ...(mime ? { mime } : {}) }
    }
    return isFolder(path) ? { kind: 'folder', version: null } : null
  }
  return {
    stat,
    read: async (path, offset, length) => {
      const file = hidden(path) ? undefined : files.get(path)
      if (!file) throw fileError('file-not-granted', 'the file is gone')
      const end = length === undefined ? file.bytes.byteLength : Math.min(file.bytes.byteLength, offset + length)
      return { bytes: file.bytes.slice(offset, end), version: String(file.version), size: file.bytes.byteLength }
    },
    list: (folder) => {
      const entries = new Set<string>()
      for (const name of [...files.keys(), ...folders]) {
        if (!name.startsWith(`${folder}/`) || hidden(name)) continue
        const rest = name.slice(folder.length + 1)
        entries.add(`${folder}/${rest.split('/')[0]}`)
      }
      return [...entries].sort()
    },
    child: (folder, name) => {
      const parent = folder ?? documentFolder()
      return parent ? `${parent}/${name}` : name
    },
    commit: async (path, bytes, mode) => {
      const existing = files.get(path)
      if (mode.mode === 'create' && (existing || isFolder(path))) throw fileError('conflict', 'a file with this name exists')
      if (mode.mode === 'replace' && (!existing || String(existing.version) !== mode.expected)) throw fileError('conflict', 'the file changed since it was read')
      if (!isFolder(parentOf(path)) && parentOf(path) !== '') folders.add(parentOf(path))
      const version = (existing?.version ?? 0) + 1
      files.set(path, { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, version })
      return { version: String(version) }
    },
  }
}

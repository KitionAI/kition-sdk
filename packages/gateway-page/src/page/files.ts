/**
 * The workspace as a kit's file storage (KitFiles 1.x, `files/*`), for a kit whose manifest asks
 * for files (Note, Scene), as Kition's `kitionFiles.ts` serves it, through the gateway: workspace
 * paths are the references, which never reach the kit (`@kition/kit-host` hands it handles).
 *
 * Reads go through `/kit-files/`, which serves no hidden path (LR2). Listings and writes go
 * through the gateway's grant session for this kit and document: the page names what the person
 * picked by walking the choices the gateway offers (`POST /api/v1/kits/grants/choices`), never by
 * a path, and commits through a grant of that choice, so a new file never replaces one (H5) and a
 * replacement commits only over the version the kit read (FA9).
 */
import type { KitFileEntry, KitFilesManifest, KitFilesOptions, KitFilesPickParams, KitFilesStorage } from '@kition/kit-host'
import { fileError, KitRpcError } from '@kition/kit-host'
import { cleanPath, type Gateway, GatewayError } from './gateway'
import { readFile, stampFile } from './host'
import { dialog, h } from './ui'

/** The largest chunk one write sends (the gateway takes 64 MiB). */
const CHUNK = 32 << 20

type Choice = { choice: string; name: string; kind: 'file' | 'folder' }
type Choices = { folder: string; choices: Choice[] }

const visible = (ref: string) => Boolean(cleanPath(ref)) && !ref.split('/').some((part) => part.startsWith('.'))
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/')
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** The gateway's refusal as the KitFiles reason the kit sees; `io-error` for anything else. */
function refusal(error: unknown) {
  if (error instanceof KitRpcError) return error
  const reason = error instanceof GatewayError ? error.reason : null
  const known = ['file-not-granted', 'not-allowed', 'conflict', 'already-committed', 'unsaved-edits', 'quota', 'io-error']
  return reason && known.includes(reason) ? fileError(reason as never, `the host refused the file (${reason})`) : fileError('io-error', 'the host could not reach the file')
}

export function filesStorage(gateway: Gateway, { kit, document, manifest, readOnly, unsaved }: { kit: string; document: string; manifest: KitFilesManifest; readOnly: boolean; unsaved: (path: string) => boolean }) {
  let session: Promise<string> | null = null
  const grants = () => {
    session ??= gateway.send<{ session: string }>('api/v1/kits/grants/sessions', { kit, document, files: manifest, readOnly }).then((answer) => answer.session)
    return session
  }
  /** The choices of `folder` (a workspace path, `''` the top). */
  const choices = async (folder: string): Promise<Choices> => {
    const id = await grants()
    let listing = await gateway.send<Choices>('api/v1/kits/grants/choices', { session: id })
    for (const name of folder ? folder.split('/') : []) {
      const next = listing.choices.find((entry) => entry.name === name && entry.kind === 'folder')
      if (!next) throw fileError('file-not-granted', 'this folder is not available to the kit')
      listing = await gateway.send<Choices>('api/v1/kits/grants/choices', { session: id, folder: next.choice })
    }
    return listing
  }

  const storage: KitFilesStorage = {
    stat: async (ref) => {
      if (!visible(ref)) return null
      const listing = await choices(parentOf(ref)).catch(() => null)
      const entry = listing?.choices.find((choice) => choice.name === ref.split('/').pop())
      if (entry?.kind === 'folder') return { kind: 'folder', version: null }
      const version = await stampFile(gateway, ref)
      return version === null ? null : ({ kind: 'file', version } satisfies KitFileEntry)
    },
    read: async (ref, offset, length) => {
      if (!visible(ref)) throw fileError('file-not-granted', 'this file is not available to the kit')
      const file = await readFile(gateway, ref, { offset, length })
      if (!file) throw fileError('file-not-granted', 'this file is not available to the kit')
      return { bytes: file.bytes, version: file.stamp ?? '', size: file.size }
    },
    list: async (folder) => {
      const listing = await choices(folder)
      return listing.choices.map((entry) => join(folder, entry.name)).sort()
    },
    child: (folder, name) => join(folder ?? parentOf(document), name),
    unsaved: (ref) => unsaved(ref),
    commit: async (ref, bytes, mode) => {
      if (!visible(ref)) throw fileError('not-allowed', 'this file is not available to the kit')
      let handle: string
      let id: string
      try {
        id = await grants()
        const listing = await choices(parentOf(ref))
        const name = ref.split('/').pop() ?? ref
        const existing = listing.choices.find((entry) => entry.name === name && entry.kind === 'file')
        if (mode.mode === 'create' && existing) throw fileError('conflict', 'a file of that name exists')
        const granted =
          mode.mode === 'create'
            ? await gateway.send<{ handle: string }>('api/v1/kits/grants', { session: id, choice: listing.folder, name, rights: ['create'], flow: 'pick' })
            : await gateway.send<{ handle: string; version?: string | null }>('api/v1/kits/grants', {
                session: id,
                choice: existing?.choice ?? '',
                rights: ['write'],
                flow: 'pick',
              })
        handle = granted.handle
      } catch (error) {
        throw refusal(error)
      }
      let offset = 0
      try {
        for (;;) {
          const end = Math.min(bytes.byteLength, offset + CHUNK)
          const final = end === bytes.byteLength
          const query = new URLSearchParams({ session: id, offset: String(offset), final: String(final) })
          if (final && mode.mode === 'replace') query.set('expected', mode.expected)
          const answer = await gateway.json<{ version?: string }>(`api/v1/kits/grants/${encodeURIComponent(handle)}/content?${query}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: bytes.slice(offset, end),
          })
          if (final) return { version: answer?.version ?? '' }
          offset = end
        }
      } catch (error) {
        throw refusal(error)
      }
    },
  }
  return {
    storage,
    /** The person's picker: the workspace's folders and the files the kit may read, browsed through the choices. */
    pick: (params: KitFilesPickParams) => pickFiles(choices, params),
    end: async () => {
      const opened = session
      session = null
      if (opened) await opened.then((id) => gateway.fetch(`api/v1/kits/grants/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })).catch(() => undefined)
    },
  }
}

/** The picker: a dialog of the folder's entries; a file chooses it, a folder opens it. */
function pickFiles(choices: (folder: string) => Promise<Choices>, params: KitFilesPickParams): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false
    const list = h('ul', { class: 'picker', 'data-testid': 'file-picker' })
    const finish = (paths: string[]) => {
      if (done) return
      done = true
      opened.close()
      resolve(paths)
    }
    const show = async (folder: string) => {
      list.replaceChildren(h('li', { class: 'picker__loading' }, '…'))
      const listing = await choices(folder).catch(() => ({ folder: '', choices: [] as Choice[] }))
      const rows: HTMLElement[] = []
      if (folder) rows.push(row('..', () => void show(parentOf(folder))))
      for (const entry of listing.choices) {
        const path = join(folder, entry.name)
        rows.push(row(entry.kind === 'folder' ? `${entry.name}/` : entry.name, () => (entry.kind === 'folder' ? void show(path) : finish([path]))))
      }
      list.replaceChildren(...rows)
      rows[0]?.querySelector('button')?.focus()
    }
    const row = (label: string, run: () => void) => {
      const button = h('button', { type: 'button', class: 'picker__entry' }, label)
      button.addEventListener('click', run)
      return h('li', {}, button)
    }
    const opened = dialog(params.purpose || 'Choose a file', list, () => finish([]), 'Close')
    void show('')
  })
}

/** `mountKit`'s `files` option for the kit whose manifest asks for `manifest`. */
export function filesOption(gateway: Gateway, kit: string, document: string, manifest: KitFilesManifest, readOnly: boolean, unsaved: (path: string) => boolean) {
  const files = filesStorage(gateway, { kit, document, manifest, readOnly, unsaved })
  const option: KitFilesOptions = { storage: files.storage, kit, principal: 'person:local', manifest, pick: files.pick }
  return { option, end: files.end }
}

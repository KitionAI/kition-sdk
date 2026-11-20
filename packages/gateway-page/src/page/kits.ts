/**
 * Which kit opens a file: by its extension, among the kits the gateway serves. A kit that edits
 * the extension wins over one that only views it (`.html` goes to the HTML kit, which edits it,
 * not to Doc, which views it); among kits of the same role, the first listed.
 */

/** A kit as `GET /api/v1/kits` lists it. */
export type KitStatus = { id: string; name: string; extensions: string[]; creates: string[]; installed: boolean }

/** The extensions a kit opens, by role. */
export type KitFormats = { id: string; edit: string[]; view?: string[] }

/** A kit's editor as `GET /api/v1/kits/editors` lists it. */
export type EditorEntry = {
  id: string
  version: string | null
  installed: boolean
  local: boolean
  available: boolean | null
  downloading: { done: number; total: number } | null
  failed: string | null
  /** Where an installed one loads from, relative to the gateway's root. */
  base?: string
}

/** The extension of `path`, lowercase, without the dot; `''` when it has none. */
export function extensionOf(path: string) {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The kit that opens `path`, and whether it edits it; `null` when none opens it. */
export function chooseKit(kits: KitFormats[], path: string): { id: string; edits: boolean } | null {
  const extension = extensionOf(path)
  if (!extension) return null
  const editing = kits.find((kit) => kit.edit.includes(extension))
  if (editing) return { id: editing.id, edits: true }
  const viewing = kits.find((kit) => kit.view?.includes(extension))
  return viewing ? { id: viewing.id, edits: false } : null
}

/** The kit's short name: `table` for `kit.table`. */
export const shortName = (id: string) => id.replace(/^kit\./, '')

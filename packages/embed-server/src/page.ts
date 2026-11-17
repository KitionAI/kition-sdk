/**
 * The editor page the service answers `GET /v1/open` with: `@kition/embed` mounting the kit for the
 * session's file, its storage provider the service's own `/v1/file` and `/v1/replica`, with the
 * session as the bearer. Nothing in it is trusted by the service: every call is checked again.
 */
import type { Session } from './session'

export type PageOptions = { session: string; claims: Session; kitUrl: string; embedModule: string; nonce: string; title: string }

/** JSON safe inside `<script>`: no `<` that could close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export function editorPage({ session, claims, kitUrl, embedModule, nonce, title }: PageOptions) {
  const { perms } = claims
  const config = {
    session,
    kit: { id: claims.kit, url: kitUrl },
    file: { id: claims.file, name: title },
    user: { id: claims.sub, name: claims.name || claims.sub },
    mode: perms.edit ? 'edit' : perms.comment ? 'comment' : 'view',
    display: { permissions: { download: perms.download, export: perms.export, share: perms.share }, watermark: claims.watermark },
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style nonce="${nonce}">html,body,#editor{margin:0;height:100%;overflow:hidden}</style></head>
<body><div id="editor"></div>
<script type="application/json" id="kition-config">${scriptJson(config)}</script>
<script type="module" nonce="${nonce}">
import { KitionEmbed, EmbedConflictError } from ${scriptJson(embedModule)}
const config = JSON.parse(document.getElementById('kition-config').textContent)
// The open token stays out of the page's address, history and referrers.
history.replaceState(null, '', location.pathname)
const auth = { authorization: 'Bearer ' + config.session }
async function failed(response) {
  throw new Error('the embed server answered ' + response.status)
}
const replica = {
  read: async () => {
    const response = await fetch('/v1/replica', { headers: auth })
    if (response.status === 404 || response.status === 501) return null
    if (!response.ok) return failed(response)
    const body = new Uint8Array(await response.arrayBuffer())
    const length = new DataView(body.buffer, body.byteOffset).getUint32(0)
    return { snapshot: body.slice(4, 4 + length).buffer, blobs: body.slice(4 + length).buffer, fileStamp: response.headers.get('x-kition-file-stamp') }
  },
  write: async (_id, stored) => {
    const snapshot = new Uint8Array(stored.snapshot), blobs = new Uint8Array(stored.blobs)
    const body = new Uint8Array(4 + snapshot.length + blobs.length)
    new DataView(body.buffer).setUint32(0, snapshot.length)
    body.set(snapshot, 4)
    body.set(blobs, 4 + snapshot.length)
    const response = await fetch('/v1/replica', { method: 'PUT', headers: { ...auth, 'x-kition-file-stamp': stored.fileStamp }, body })
    if (!response.ok && response.status !== 501) return failed(response)
  },
}
const storage = {
  read: async () => {
    const response = await fetch('/v1/file', { headers: auth })
    if (!response.ok) return failed(response)
    return { bytes: new Uint8Array(await response.arrayBuffer()), version: response.headers.get('x-kition-version') }
  },
  stamp: async () => {
    const response = await fetch('/v1/file/stamp', { headers: auth })
    if (!response.ok) return failed(response)
    return (await response.json()).version
  },
  write: async (fileId, bytes, { expectedVersion }) => {
    const response = await fetch('/v1/file', { method: 'PUT', headers: { ...auth, ...(expectedVersion ? { 'if-match': expectedVersion } : {}) }, body: bytes })
    if (response.status === 409) throw new EmbedConflictError(fileId, response.headers.get('x-kition-version'))
    if (!response.ok) return failed(response)
    return await response.json()
  },
  replica,
}
const editor = await KitionEmbed.mount(document.getElementById('editor'), {
  kit: config.kit,
  file: config.file,
  storage,
  identity: { user: () => config.user },
  permissions: { mode: config.mode },
  display: config.display,
})
editor.on('saved', (saved) => parent.postMessage({ kitionDocument: 1, event: 'saved', version: saved.version }, '*'))
await editor.ready()
parent.postMessage({ kitionDocument: 1, event: 'ready' }, '*')
</script></body></html>`
}

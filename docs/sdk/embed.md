# Embed: kit editors in your page (`@kition/embed`)

The full reference is [the embed reference](../platform/reference/embed.md). This page is the SDK view: what a customer
wires up, and where it sits in the Kition kit platform.

```ts
import { KitionEmbed } from '@kition/embed'

const editor = await KitionEmbed.mount(element, {
  kit: { id: 'kit.note', url: 'https://kits.example.com/note-ui/' }, // the kit package you host
  file: { id: 'plan-2026', name: 'Plan.md' },
  storage,             // your StorageProvider: read, stamp, write (versioned), create
  identity,            // your IdentityProvider: user, users, permissions
})
```

- **Kit packages** (each kit's editor, the npm package `@kition/kit-<kit>-ui`, which holds the
  folder `<kit>-ui/`; [distribution.md](distribution.md#kit-packages-and-the-kit-index)) are static
  folders: host them on their own origin with the policy in
  [the embed reference](../platform/reference/embed.md) section 3.
- **Storage** is yours. A write carries the version it read; refuse a stale one with
  `EmbedConflictError`, and answer `stamp` with the current version, so an edit made elsewhere (an
  agent's save) is never written over. The editor writes one save at a time, each over the
  version the one before it wrote, and does not write the same bytes twice in a row, so a stale
  version always means the file changed elsewhere.
- **Identity and permissions** are yours: `edit`, `comment`, or `view` per person and file.
- **One editor per document**: the embed does not co-edit.

- **Checks**: `editor.check()` lists what the kit finds wrong with the document (`{ code,
  severity, target, message, fix? }`, errors first); `editor.check({ draft: true })` checks the
  agent's draft.

## Links, web addresses, and your shortcuts

A kit opens no window itself. Give the storage provider the callbacks and the kit offers what they
serve; leave them out and it shows links as plain text:

```ts
const storage = {
  ...files,
  resolveLink: (fromFileId, link) => workspace.resolve(fromFileId, link), // { fileId, name, kitId, version, path } | null
  open: (fileId, view) => app.openTab(fileId, view),                       // { opened }
  openUrl: async (url) => ({ opened: await app.confirmAndOpen(url) }),     // show the full address first
}
const editor = await KitionEmbed.mount(element, { kit, file, storage, shortcuts: ['Cmd+S', 'Cmd+J'] })
editor.on('shortcut', (key) => app.runShortcut(key))
```

- The embed calls them only from a person's gesture in the kit and passes `openUrl` only
  `https:`, `http:`, and `mailto:` addresses; asking the person before opening an address is the
  page's job.
- `shortcuts` are keys the kit forwards instead of handling (`shortcut` event). List `Cmd+S` only
  if the page saves itself with `editor.save()`.

## The agent's draft, reviewed in your page

An agent edits a **draft** of the document; the person sees what it changes and merges or discards
it. The `draft` event says when the draft opens, changes, is ready for review, or closes:

```ts
editor.on('draft', async ({ state }) => {
  if (state !== 'ready') return hideReview()
  const { summary, before, after } = await editor.draft.compare({ maxSize: 640 })
  showReview(summary, before, after) // created / changed / deleted objects, and PNGs of both sides
})
mergeButton.onclick = () => editor.draft.merge()     // one undo step, recorded as the agent's
discardButton.onclick = () => editor.draft.discard() // the document stays as it is
```

- Call `merge()` and `discard()` only from the person's click, never from an agent's or a model's
  output (the Kit UI protocol requires it). A person who may not edit cannot (`EmbedError` `read-only`).
- `state()` answers `none`, `open`, or `ready`; a kit without drafts answers `none` and refuses
  `compare`, `merge`, `discard` (`unsupported`); there is nothing to merge without a draft
  (`no-draft`).
- The draft's comparison needs the kit's schema; the embed reads the one the kit package ships
  (`model/schema.json`; serve it with the package, readable by the page), else loads it from
  `@kition/script`'s generated kits, or pass `kit.schema` yourself.

## Your agent in the open editor (`editor.agentPort`)

Your agent (on your server) can work in the document the person has open, with the same MCP tools
`kition mcp` offers on files (`<prefix>_inspect`, `_commands`, `_run`, `_query`, `_batch`,
`_check`, `_draft_ready`, `_draft_reopen`). `editor.agentPort()` is an MCP server for one editor;
your page relays its messages to your server, and your server hands them to the agent:

```ts
// In the page:
import { relayAgentPort } from '@kition/embed'
const port = editor.agentPort({ principal: 'agent:assistant', label: 'Assistant' })
void relayAgentPort(port, {
  next: async () => { const r = await fetch('/agent/next'); return r.status === 204 ? null : r.json() },
  reply: async (message) => { await fetch('/agent/reply', { method: 'POST', body: JSON.stringify(message) }) },
})

// On the server (Node): one relay per open document.
import { createAgentRelay } from '@kition/script/node'
const relay = createAgentRelay()
// GET /agent/next  -> relay.next({ signal })   (abort when the page's request closes)
// POST /agent/reply -> relay.reply(body)
// the agent's MCP messages -> relay.request(message)
```

- The agent's edits go to a draft by default (`agentPort({ draft: false })` lets it edit live).
  It can ask for review (`<prefix>_draft_ready`) but has no tool that merges or discards: the
  person does, in the page.
- It edits no more than the person may (`view` and `comment` refuse writes with `read-only`), and
  only the open document (`path` must be its name, else `not-open`).
- Authenticate both sides yourself: relay only to the page of the person who asked for the agent.
- Without a relay, an agent works **headless** on the file (`kition mcp`, [agent.md](agent.md))
  and the page sees its save as a new version (`storage.stamp` changes; the editor offers to
  reload), never as a draft.

Example: [examples/embed-app](../../examples/embed-app). With `EMBED_WORKSPACE=<folder>` its
server keeps the files in a folder (`workspace.mjs`, `src/workspace-storage.ts`), which is how the
agent example shares them; its server also relays an agent to the open editors
(`agent-relay.mjs`, `/api/agent/<name>/mcp`), and the page shows a review bar for the agent's
draft. [examples/agent-mcp/live.mjs](../../examples/agent-mcp/live.mjs) is such an agent.

Kition kit platform: [embed](../platform/sets/embed.md), the Kit UI protocol
([reference](../platform/reference/ui-protocol.md)), [kit editors](../platform/kits/ui.md).

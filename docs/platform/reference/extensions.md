# Extensions: `@kition/extensions`

An extension adds commands to a kit's documents without changing the kit
(`KitExtensions 1.0`, [`KitExtensions 1.0`](../sets/extensions.md)). It is a
manifest and one ES module; a host runs it in a sandbox and gives it the
object model ([object-model.md](object-model.md)) of the documents it works
on, within the permissions it declares.

## Write an extension

`extension.json`:

```json
{
  "kitExtensions": "1.0",
  "id": "com.example.title-case",
  "name": "Title case headings",
  "version": "1.0.0",
  "entry": "extension.mjs",
  "activation": { "kits": ["kit.note"], "on": "command" },
  "contributes": { "commands": [{ "id": "titleCase.apply", "title": "Title case headings" }] },
  "permissions": ["model.read", "model.write"]
}
```

`extension.mjs` (one file: bundle anything it imports):

```js
export function activate(ctx) {
  ctx.commands.register('titleCase.apply', async () => {
    const changed = await ctx.document.run(async (context) => {
      context.root.load(['body'])
      await context.sync()
      // … read and edit through proxies, as with @kition/script …
      return 1
    })
    ctx.notify(`Title-cased ${changed} headings`, { level: 'success' })
    return { changed }
  })
}

export function deactivate(ctx) {}
```

- `ctx.document` has `@kition/script`'s document API: `run`, `context`,
  proxies with `load` and `sync()`, `batch`, `describe`, `commands.list`,
  `enabled`, `run`, `on('changed')`, and `readOnly`.
- `ctx.commands.register(id, handler)` handles a command the manifest
  contributes; the handler's answer goes back to the host.
- `ctx.notify(title, { level, description })` shows a message.
- `ctx.subscriptions.push(dispose)` runs `dispose` on deactivation.
- `ctx.panels.register(id, handler)` serves a panel the manifest contributes
  (see Panels).

`activate` runs once per document. A host has the schema of every kit with
generated typings (`@kition/script/kits`, see [object-model.md](object-model.md)),
so an extension or a script works on documents of any of them. `activation.on: "open"` activates it when
a matching document opens; `"command"` (the default) on its first command.
`activation.formats` narrows `kits` to file extensions.

## Panels

A panel is a small page of the extension's own that the host shows next to
the kit's editor (Kition: a side panel to its right). The manifest declares
it, and the package carries its HTML:

```json
"contributes": {
  "commands": [],
  "panels": [{ "id": "titleCase.titles", "title": "Headings", "entry": "panel.html", "kits": ["kit.note"] }]
}
```

`kits` (optional) narrows the documents it is offered for to some of
`activation.kits`. Opening a panel activates the extension on the document,
like a command. The panel talks to the extension's worker, never to the
document: in the worker,

```js
ctx.panels.register('titleCase.titles', (panel) => {
  panel.onRequest(async (message) => {            // the panel's kitionPanel.request(message)
    if (message.type === 'titles') return { titles: await readTitles(ctx.document) }
  })
  const stop = ctx.document.on('changed', () => panel.post({ type: 'changed' }))
  panel.onClose(() => {})                          // the person closed it
  return stop                                      // runs when the panel closes
})
```

and in the panel's HTML, `window.kitionPanel`:

```html
<ol id="titles"></ol>
<script>
  kitionPanel.onMessage((message) => { /* panel.post(message) */ })
  kitionPanel.request({ type: 'titles' }).then(({ titles }) => { /* show them */ })
</script>
```

`kitionPanel.info` has `extension`, `panel`, `documentId`, `title`, and the
host's `locale`. A panel shown twice has two sessions (`panel.session`), each
with its own handler call.

The entry is one self-contained HTML file: its inline classic scripts run in
order (bundle anything they need; scripts with `src` and module scripts do
not run, and neither do inline event handler attributes, so use
`addEventListener`); inline styles and `<style>` apply; images, fonts, and
media load only from `data:` and `blob:` URLs. The host's theme arrives as
CSS custom properties on the root (`--kit-surface`, `--kit-text`,
`--kit-text-muted`, `--kit-border`, `--kit-primary`, `--kit-primary-text`,
`--kit-radius-control`, `--kit-font-sans`, …), so a panel can look like the
host.

## Permissions

| Permission | Allows |
| --- | --- |
| `model.read` | `load`, `describe`, the command catalogue |
| `model.write` | every write operation (needs `model.read`) |
| `commands.run` | the kit's commands; one that mutates also needs `model.write` |
| `network:<origin>` | connections to that origin: `network:api.example.com` (HTTPS and WSS), `network:https://api.example.com:8443`, `network:http://localhost:3000` (plain HTTP for loopback only) |

A refused call rejects with an error whose `code` is `permission-denied`.
Edits are recorded with origin `{ kind: "extension", principal: "ext:<id>" }`.

## Host an extension

```ts
import { ExtensionHost, iframeSandbox, openPanelFrame } from '@kition/extensions'
import { portFromConnection } from '@kition/script'

const host = new ExtensionHost({
  sandbox: iframeSandbox({ url: '/extensions/sandbox.html' }),
  notify: ({ level, title, description }) => toast(level, title, description),
})
host.load({ manifest: manifestText, source: entrySource })
host.openDocument({ id: path, kitId: 'kit.note', path, port: portFromConnection(connection) })
host.commandsFor(path)                                   // for a palette or a menu
await host.runCommand(path, 'com.example.title-case', 'titleCase.apply')
await host.runScript({ source, name: 'review.mjs' }, path) // a module whose default export takes ctx

// Panels: the files besides the entry come with the package.
host.load({ manifest: manifestText, source: entrySource, files: { 'panel.html': panelHtml } })
host.panelsFor(path)                                     // the panels to offer for the document
const panel = await openPanelFrame(host, { documentId: path, extension: 'com.example.title-case', panel: 'titleCase.titles' }, {
  url: '/extensions/panel.html',
  container: element,                                    // the frame fills it
  theme: { '--kit-primary': '#5645d4' },
})
panel.dispose()                                          // closes it here and in the worker
```

Serve `sandbox/sandbox.html` (also `SANDBOX_HTML` from
`@kition/extensions/runtime`) as a static file at the sandbox URL, and
`sandbox/panel.html` (`PANEL_HTML`) at the panel URL, without a CSP header of
your own that loosens them. Keep the host page's own `frame-src` to its own
origin (and `data:`/`blob:`): it is what keeps a panel's frame from loading
another origin's page, which a sandboxed frame may otherwise do to itself.
`openPanelFrame` also removes a panel frame that loads another page.
`host.openPanel(documentId, extension, panel, port)` is the part without a
page: it hands the extension's worker one end of a `MessageChannel`.

## How the sandbox works

Each extension gets a hidden `sandbox="allow-scripts"` iframe on an opaque
origin, loaded from the sandbox page. Its only script (allowed by hash) takes
the worker runtime, the extension's `connect-src` (its `network:` origins, or
`'none'`), and a `MessagePort` from the host; it adds the `connect-src`
policy, then starts a classic worker from a blob, which inherits the page's
CSP and imports the extension's module from a blob URL. The extension can
reach the network only at its declared origins and cannot load scripts from
anywhere. Every object-model call goes over the port to the host, which checks
it against the permissions, stamps its origin, and runs it with `@kition/script`
over the kit's `ModelPort`.

`scripts/build-runtime.mjs` builds the worker (`src/generated/runtime.ts`)
and the page; a test fails when their sources change without a rebuild.

Panels get the same treatment: a visible `sandbox="allow-scripts"` frame on
an opaque origin, loaded from the panel page, whose only script (allowed by
hash) takes the panel's HTML, the extension's `connect-src`, the theme, and
the panel's end of its channel to the worker. It adds the `connect-src`
policy, gives the page `kitionPanel`, and shows the HTML, running its inline
scripts as `blob:` scripts (the page's `script-src` is the hash and `blob:`
only). A panel has no object model of its own: everything it does to the
document, the extension's worker does, within the extension's permissions.

## Example

`examples/extensions/title-case/` title-cases every heading of a note (the
Note kit), rewriting only the letters whose case changes, from its command or
from its panel (`panel.html`), which lists the note's headings and follows its
changes. Its test runs both on a real note when the Note kit's package is
available (`KITION_KITS_DIR`).

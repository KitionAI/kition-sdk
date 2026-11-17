# `KitExtensions 1.0`: extending kit editors

For integrators who add commands and panels to kit editors. The SDK package is `@kition/extensions`; the full API is in [the extensions reference](../reference/extensions.md).

An extension adds behaviour to the documents of one or more kits without
changing the kits. The reference host is `@kition/extensions`
([extensions.md](../reference/extensions.md)).

- **EX1** An extension is a folder (or a zip of one) with `extension.json`
  and one self-contained ES module, its `entry`. The manifest names
  `kitExtensions: "1.0"`, a reverse-domain `id`, `name`, a semantic
  `version`, `activation { kits, formats?, on?: "open" | "command" }`,
  `contributes { commands: [{ id, title, description? }], panels?: [{ id,
  title, entry, kits? }] }`, and `permissions`. A host refuses a manifest
  with unknown permissions, `model.write` without `model.read`, a `network:`
  value that is not an origin, a duplicated command or panel id, a panel
  whose `kits` are not among `activation.kits`, or an entry (the module's or
  a panel's `.html`) outside the package.
- **EX2** Permissions: `model.read` (loads, `model/describe`, the command
  catalogue), `model.write` (every write operation), `commands.run` (command
  operations; a command the catalogue does not mark `mutates: false` also
  needs `model.write`), and `network:<origin>`. A refused call fails with
  `code: "permission-denied"`; the rules of [`KitObjectModel 1.0`](object-model.md) apply on top
  (`read-only`).
- **EX3** The host runs each extension in a worker on an opaque origin whose
  CSP allows connections only to the declared `network:` origins and scripts
  only from the host's bootstrap and `blob:`; extensions reach the document
  only through the host. There are no native extensions.
- **EX4** The host stamps every batch of an extension with origin `{ kind:
  "extension", principal: "ext:<id>" }`, whatever the extension sends.
- **EX5** The module exports `activate(ctx)`, called once per document it
  works on, and may export `deactivate(ctx)`. `ctx.document` is the object
  model of that document ([`KitObjectModel 1.0`](object-model.md), as `@kition/script`),
  `ctx.commands.register(id, handler)` handles a contributed command (any
  other id is refused), `ctx.notify(...)` shows a message, and
  `ctx.subscriptions` are disposed on deactivation. A host lists contributed
  commands for documents the manifest applies to and activates the extension
  on open (`on: "open"`) or on its first command.
- **EX6** A host MAY run a script, a module whose default export takes the
  same `ctx`, once against a document in a sandbox of its own.
- **EX7** A host MAY show contributed panels next to the kit's editor. It
  shows a panel's HTML in a frame on an opaque origin whose CSP allows
  connections only to the extension's `network:` origins, scripts only from
  the host's page script and `blob:`, and images, fonts, and media only from
  `data:` and `blob:`; the frame MUST NOT be able to leave its page for
  another origin. The panel talks only to the extension's worker, over a
  channel of its own (`ctx.panels.register(id, handler)` there,
  `kitionPanel` in the panel); opening one activates the extension on the
  document.

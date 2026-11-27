# Hosts in any language

A host is a program that opens a person's files in Kition's kits: a desktop app, a server, a
script. It does not matter what language it is written in. Every host uses the kits the same way:
it starts one program, `kition serve`, and talks to it in JSON, one line at a
time, on that program's standard input and output. Files are named by their path in a workspace
folder.

`kition serve` does the rest of what the [Kit Process Protocol](../platform/reference/kit-process-protocol.md)
asks of a host, so no host has to implement it:

- it starts each kit's headless executable when a file of its kind is first opened, and stops it
  when the host goes away;
- it gives the kit a file handle for each file instead of a path, and answers the kit's `storage.*`
  requests from the workspace, never outside it, never a hidden file (`.git/`, `.kition/`);
- a save is written to a temporary file and moved into place in one step, and only while the
  file is still the version the kit read: if someone changed it meanwhile, the save fails with
  `file_conflict` and their change is kept;
- a new document never replaces a file.

The examples in [`examples/hosts/`](../../examples/hosts) are complete hosts in Python, Node and
Go, each in one file with nothing but its standard library. The SDK's tests run all three.

## Start it

```sh
npm install -g @kition/cli          # or install.sh / install.ps1 (cli.md)
kition kit install note table       # the kits your host opens; --all for every kit
kition serve --workspace <folder>
```

With neither `--kit` nor `--kits-dir`, `kition serve` runs the version in use of each kit
installed in the kit store, `~/.kition/kits` ([cli.md](cli.md#the-store)); it installs no kit
itself, so install the kits your host needs first. `--kit <executable>` names a kit built
elsewhere (its `kit.json` is the nearest one above it) and `--kits-dir <folder>` a folder with one
folder per kit holding its `kit.json`; with either, the store is not used.

The process ends when its standard input closes, after shutting its kits down.

Both this program and `kition mcp` offer `--sandbox`, `--call-timeout-secs` (120),
`--idle-timeout-secs` (600), and optional `--memory-limit-mib`. Calls to one document are FIFO;
different documents have independent workers. Idle reclaim saves dirty state first. See
[process controls](process-control.md) for platform enforcement, recovery and MCP control gaps.

## Talk to it

Each line you write is one JSON-RPC 2.0 request; each line it writes is one answer, with the
request's `id`. Answers come as requests finish, not necessarily in order: a host that sends one
request at a time can simply read the next line.

```text
→ {"jsonrpc":"2.0","id":1,"method":"kits.initialize","params":{"client":{"name":"my-app","version":"1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"serviceVersion":1,"protocolVersion":1,"workspace":true,"kits":[{"id":"kit.note","name":"Note","extensions":["md","markdown"],"creates":["md"],"installed":true}]}}
→ {"jsonrpc":"2.0","id":2,"method":"documents.open","params":{"path":"Plan.md"}}
← {"jsonrpc":"2.0","id":2,"result":{"kitId":"kit.note","documentId":"82aab04c…:1","path":"Plan.md","format":"markdown","readOnly":false,"dirty":false,"canUndo":false,"canRedo":false,"conflict":false,"details":{…},…}}
→ {"jsonrpc":"2.0","id":3,"method":"command.execute","params":{"kit":"kit.note","documentId":"82aab04c…:1","command":"block.append","params":{"markdown":"- [ ] Ship the plan"},"origin":"system"}}
→ {"jsonrpc":"2.0","id":4,"method":"documents.save","params":{"kit":"kit.note","documentId":"82aab04c…:1"}}
```

The methods, their parameters and their answers are in
[`schemas/kits-service.schema.json`](../../schemas/kits-service.schema.json); generate types from
it if your language likes them.

| Method | Parameters | Answer |
| --- | --- | --- |
| `kits.initialize` | `client: { name, version }` | `serviceVersion` (1), `protocolVersion` (the kits', 1), `workspace`, `kits` |
| `kits.list` | none | `kits`: each kit's `id`, `name`, `extensions`, `creates`, `installed` |
| `kits.ping` | none | `{}` |
| `documents.open` | `path` | a document |
| `documents.create` | `path`, optional `options` (for example `width`, `height`) | a new document, saved so the file exists; when `path` exists the next free name is used (`Untitled 2.md`), so read the answer's `path` |
| `documents.get` | `kit`, `documentId` | the document |
| `documents.save` | `kit`, `documentId` | the document |
| `documents.saveAs` | `kit`, `documentId`, `path`, optional `format` | the document, which now lives in `path` |
| `documents.reload` | `kit`, `documentId` | the document read from its file again, its unsaved edits dropped |
| `documents.changedOnDisk` | `path` | `{}`; tell the kits a file changed outside them: a clean document is read again, one with unsaved edits gets `conflict: true` |
| `documents.close` | `kit`, `documentId`, optional `discardChanges` | `{}` |
| `documents.preview` | `kit`, `documentId`, optional `maxSize` | `{ mimeType, data }`, a base64 PNG |
| `documents.check` | `kit`, `documentId` | `{ diagnostics }` |
| `command.list` | `kit`, optional `documentId`, optional `query` | `{ commands }` |
| `command.execute` | `kit`, `documentId`, `command`, `params`, `origin` (`user`, `agent` or `system`), optional `originLabel` | `{ changed, result, document }` |
| `model.describe`, `model.batch` | `kit`, `documentId`, and the batch | as in the [object model](../platform/reference/object-model.md) |
| `tools.list`, `tools.call` | as MCP's `tools/list` and `tools/call` | the kits' agent tools, for a host's own agent |

`origin` says who made a change: `user` is the person, `agent` an agent acting for them (a
separate connection to the kit, with the agent's limits), and `system` the host itself acting on
the person's behalf, for example importing mail into a table. A `system` change is no undo step:
neither the person's undo nor an agent's takes it back. `originLabel` names the host feature
(`emailsync`) in the document's history. A kit that cannot keep a change out of undo refuses
`system` with `command_disabled`.

## Errors

An error has a `code` and a stable `data.reason`; `data.detail` is a message for logs.

| Reason | Code | Meaning |
| --- | --- | --- |
| `file_conflict` | -32015 | The file changed since the kit read it; nothing was written, and the document's `conflict` is `true`. `documents.reload` takes the file, `documents.saveAs` keeps the edits elsewhere |
| `file_not_allowed` | -32018 | The path is outside the workspace or hidden |
| `invalid_path` | -32602 | No kit opens this kind of file, or the file does not exist |
| `unknown_kit` | -32602 | No kit has this id |
| `kit_unavailable` | -32050 | The kit is not installed, could not start, or stopped; a retry starts it again |
| `call_timeout` | -32051 | A request exceeded its deadline; the worker was stopped and its next use reopens the saved file |
| `memory_limit` | -32052 | The resident monitor stopped the worker for exceeding its memory ceiling |
| `document_not_found` | -32010 | No such open document |
| `command_not_found`, `command_disabled`, `invalid_params` | -32020, -32021, -32022 | The command is unknown, not enabled now, or its parameters are wrong |
| `unsupported_format` | -32012 | The kit cannot open, save or export this format |

## Hosts that serve files themselves

A host that keeps files somewhere other than a local folder (a cloud store, a database, a page's
storage) can speak the Kit Process Protocol to each kit directly instead, and serve `storage.*` from its
storage: the [protocol](../platform/reference/kit-process-protocol.md), its
[schema](../../schemas/kit-process-protocol.schema.json), and [files beyond the open document](../platform/sets/files.md)
say everything it must do. The published kits are its test: the `regressions/issue-2` case in
the SDK drives a kit that way, with nothing but a socket and JSON.

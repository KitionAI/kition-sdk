# Agent: kit tools over MCP

`kition mcp` is a stdio MCP server, a command of `kition`, the Kition command line (`@kition/cli`
on npm). It gives any MCP client (Claude Code, Claude Desktop, Cursor, Codex, DeepSeek Harness,
your own agent) the kits' tools on one workspace folder. The agent creates, inspects, edits and
checks files there through each kit's headless executable; `kition` downloads each kit into
`~/.kition/kits` the first time the agent opens a file of it. No Kition app has to run, and the
server is free on any machine with no licence key. All 16 Kition kits are published: Note, for Markdown notes; Table, for `.ktable` tables; Board, for whiteboards; Doc, for Word documents; Sheet, for spreadsheets; Slide, for presentations; PDF; HTML, for `.html` pages; Photo, for layered images; Vector, for vector drawings; Layout, for page layouts; Design, for interface designs; Film, for video projects; Motion, for motion graphics; CAD, for `.dxf` drawings; and Scene, for 3D scenes.

## Connect your agent

With Node.js 20 or later, in your project folder:

```sh
npm install -g @kition/cli
kition agent add claude          # or codex, cursor
```

`kition agent add` registers `kition mcp --workspace <folder>` with the agent as the MCP server
named `kition`, and prints what it ran or wrote; `kition agent list` shows where it is registered
([cli.md](cli.md#your-agent): scopes, and where each agent keeps it). Without Node.js, install
`kition` with `install.sh` (macOS, Linux with glibc) or `install.ps1` (Windows) and run the same
`kition agent add` ([cli.md](cli.md#installing-it)). `kition` runs on macOS arm64 and x64, Linux
arm64 and x64 (glibc) and Windows x64.

### By hand

Every client starts the same command: `kition mcp --workspace <folder>`, or, with nothing
installed, `npx -y @kition/cli mcp --workspace <folder>` (npx keeps `kition` in npm's cache).
`--workspace` is the only folder the server reads or writes. A relative path is resolved against
the folder the client starts the server in. Replace `<folder>` with an absolute path where the
client does not start servers in your project (Claude Desktop, Codex). When the client does not
find `kition` on its `PATH`, give its absolute path (`~/.kition/bin/kition` from `install.sh`);
`kition agent add` does that for you.

**Claude Code**: in the project folder,

```sh
claude mcp add kition -- kition mcp --workspace "$PWD"
# with nothing installed:
claude mcp add kition -- npx -y @kition/cli mcp --workspace "$PWD"
```

Add `--scope project` to share it through the project's `.mcp.json`. `/mcp` shows whether the
server started. The Claude Code plugin in kition-sdk (`plugins/claude-code`, marketplace
`kition`, plugin `kition-kits`) adds a skill per kit and draft review commands, and starts the
same server.

**Claude Desktop, and any client with an `mcpServers` file** (`claude_desktop_config.json`,
`.mcp.json`, ...):

```json
{
  "mcpServers": {
    "kition": {
      "command": "kition",
      "args": ["mcp", "--workspace", "/absolute/path/to/folder"]
    }
  }
}
```

**Cursor**: `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "kition": {
      "command": "kition",
      "args": ["mcp", "--workspace", "${workspaceFolder}"]
    }
  }
}
```

**Codex**: `~/.codex/config.toml`:

```toml
[mcp_servers.kition]
command = "kition"
args = ["mcp", "--workspace", "/absolute/path/to/folder"]
```

With npx instead, the command is `npx` and the arguments start with `-y`, `@kition/cli`:
`["-y", "@kition/cli", "mcp", "--workspace", "<folder>"]`.

Options for every form:

- `--unified`: one set of ten tools for every kit (`kit_inspect`, `kit_run`, `kit_check`, ...),
  routed by the file's extension, instead of ten `<prefix>_<action>` tools per kit
  (`note_inspect`, `note_run`, ...). Use it when several kits are installed or the client limits
  tools or tool-definition tokens; with Note alone, both give ten tools.
- `--drafts`: the agent's edits go to drafts the person reviews ([Drafts](#drafts)).
- `--sandbox`: run every kit process in the operating system's sandbox.
- `--no-install`: install no kit on first use; `--index <address or file>`: another kit index
  ([cli.md](cli.md#kits-installed-on-first-use)).
- `kition mcp --list-kits` prints the kits the server found and exits. `kition mcp --schemas`
  prints every tool's argument and result JSON Schema. `kition mcp --help` lists every option.

Other clients:

- **DeepSeek Harness**: the plugin `@kition/dsh-kits`
  ([plugins/deepseek-harness/kition-kits](../../plugins/deepseek-harness/kition-kits)), installed with
  `dsh plugin --profile <profile> add <the plugin's folder>`: the tools, an editing skill per kit and
  the person's draft review.
- **Kition running**: its loopback endpoint `POST /v1/mcp/kits` also edits files open in kit
  editors live.
- **Agent skill**: [skill/SKILL.md](skill/SKILL.md) tells a coding agent how to use the tools.

## The server

```sh
kition mcp --workspace <folder>          # the kits of the kit store, installed on first use
kition mcp                               # the same, on the folder it starts in
```

With neither `--kits-dir` nor `--kit`, its kits are those of the kit store (`~/.kition/kits`, or
`KITION_HOME`'s): the version in use of each installed kit, and each kit of the kit index
installed the first time the agent names a file of it ([cli.md](cli.md#kits-installed-on-first-use)).
`--kit <path>` (repeatable) or `--kits-dir <folder>` names the kits instead, and the store is not
used; `KITION_KIT_<KIT>_BINARY` names a kit executable to use instead of the store's (a
development build). Without `--workspace`, it serves the folder it starts in and names it on
standard error.

Options: `--unified` (one `kit_<action>` set for every kit), `--drafts` (the agent's edits are
drafts unless a call says `draft: false`; a kit whose `kit.json` declares no `agent.drafts`
refuses them, see [Drafts](#drafts)), `--guard premise|epoch|off` and `--require-basis` (see
[What others changed](#what-others-changed)), `--sandbox`, `--help`.
The server is free on any machine and takes no licence key: only collaboration is paid.
`kition mcp --schemas` prints every tool's argument and result JSON Schema (`input`,
`output`; the same as Kition's `contracts/kit/mcp-tools.schema.json`). A product shipping the SDK
bundle runs the bundle's `kition-kits-mcp` instead ([In the SDK bundle](#in-the-sdk-bundle-kition-kits-mcp)).

Each kit whose executable is set adds its tools (prefix = the kit, such as `note`):

| Tool | Does |
| --- | --- |
| `<prefix>_inspect` | the document as JSON, with a rendered preview with `preview: true`; `target` is the part to list and, for a kit with a render command (`agent.render`), the view drawn (`{ time }`, `{ range, frames }`, `{ sequence }`, …), and `preview` in the answer says what the picture shows |
| `<prefix>_commands` | search the kit's commands by keywords |
| `<prefix>_run` | run command steps in order, then save (`{ path, target?, steps: [{ command, params?, on?, at? }] }`: `on` the ids a step acts on, `at` `{ part?, time? }` where; the kit's selection and current part are put back after the call; `preview: true` with `view` draws the after-picture at that view through the kit's render command) |
| `<prefix>_query`, `<prefix>_batch` | read and edit objects through the object model |
| `<prefix>_draft_ready`, `<prefix>_draft_reopen` | drafts a person reviews |
| `<prefix>_check` | what the kit finds wrong with the file: `{ diagnostics: [{ code, severity, target, message, fix? }] }` |
| `<prefix>_create` | a new file at `path` (`size` optional) |
| `<prefix>_export` | the file written in another format the kit exports, as a new file `to` (`format`, `options` for the kit's export command) |

Every tool names its file by `path` (workspace-relative); `<prefix>_query` follows objects with
`follow` (`slides.0.shapes`), never `path`. `draft` is an argument of `_inspect`, `_query`, `_run`,
`_batch`, and `_check`. Failed calls answer `isError` with `structuredContent.error.code`
(`not-found`, `read-only`, `unknown-command`, …) and `error.index` for the failing step. Objects are also `kit://`
resources. Tell the model to call `<prefix>_check` after editing and to fix what it reports.

### What a write changed

Every accepted `<prefix>_run` and `<prefix>_batch` (on the file, or on a headless draft) answers
what the whole call changed, so the model need not inspect again just to see it. The server reads
it from the document's data model through the kit (Kit Process Protocol `model.version` before the
first step, `model.changes` after the last; kits do nothing for it):

| Member | Meaning |
| --- | --- |
| `changes` | `{ created, changed, moved, deleted, truncated? }`, objects named by the ids `_inspect` and `_query` use (tool ids where the kit declares them), each list ordered by id. A created object is `{ id, type, fields, values, at? }` (`at`: `{ parent, field, index }` where a list or tree holds it); a changed one `{ id, type, fields, edits: [{ field, before, after }] }`; a moved one `{ id, type, from, to }` (an object both moved and changed is in both lists); a deleted one `{ id, type, fields: [], at? }` (`at`: where a list or tree held it). Values are given as they are, except texts over 80 characters (`{ excerpt, length }`) and blobs (`{ size }`); a list or tree field's change is told by `moved`, `created`, `deleted`. A `map` field that owns no objects is told per changed key (`{ field: "attrs.stretch", before: 100, after: 200 }`, `null` for a key added or taken out), and a `json` value, or a key's value, down to its changed leaves (object members, items of arrays of one length: `look.kind.start`, `attrs.markers.1.time`) when that is at most 16 edits and fewer bytes than the value whole, else whole; each path stands in `fields` for the field, so a batch's `map.set` of one key conflicts with others' change of that key only. Where the kit's schema says how held objects are named (`pathName`, a layer's property tree), an edit inside them also gives `named`, the place in the words of the kit's commands (`{ field: "props.children.2.children.7.value.v", named: "transform/opacity.value.v" }`). An object without a tool id that an object with one holds (through a list or tree, or a ref the schema marks `owns`: a paragraph in a shape's text body) is told as an edit of the nearest such holder, `field` being the path from it (`body.paragraphs.0.text`): created `{ field: "body.paragraphs.2", before: null, after: { text: "New" } }`, deleted the other way round, moved `{ field: "body.paragraphs", before: "body.paragraphs.1", after: "body.paragraphs.0" }` |
| `revision` | the document's revision after the call (see [What others changed](#what-others-changed)); the same after a call that changed nothing; left out for a kit without an object model |
| `changesUnavailable` | why `changes` is `null`: the kit has no object model, the document was replaced (reloaded) while the call ran, or the file is open in an editor that does not report it (one that lists the Kit UI capability `changes` does, from its replica). Never an empty change set in its place |
| `diagnostics` | `{ new, resolved }`: the kit's check before the first step and after the last, matched by `code` and `target` |

A failed (rolled-back) call answers none of them. Arguments: `changes` (`true` by default: at
most 50 objects across the lists, `truncated` counting what each list left out; `"all"` lifts the
cap; `false` leaves `changes` out) and `check` (`true` by default; `false` skips both checks). On
the mock kit a debug build's run took 1.4 ms bare, 5.4 ms with the change set and 5.8 ms with the
checks too.

A shift of many objects is stated once (`footprint`): when at least 4 objects one after another
in one list had one numeric field changed by the same amount and nothing else changed in them (a
ripple edit moving every later clip), their entries are replaced by `{ parent, field, from, count,
shift: { field, by } }` (`from` and `count` index the list as it is after the call; `by` is a
number, or a string for whole numbers kept as strings, a video kit's ticks). A list's own entry
that says no more than that the list changed (`{ id: "V1", fields: ["clips"], edits: [] }`) is
left out when the footprint or the created, deleted or moved objects of that list say it.
At least 4 objects whose every change is the same shifts and that are in no such run (scattered
through a list, or in none the change set names: 200 nodes of a scene moved by one offset) are one
entry by their ids, `{ ids: [...], edits: [{ field: "location.2", by: 1 }] }`. An object's change
may say what it carries with it that is no stored change, `carries: { count, what }` (a parent's
move: `{ count: 200, what: "world location" }`), as its kit answers it (`model.carried`).
Inside one object, at least 4 edits of one leaf of the items of a held list shifted by one amount
(200 keyframes moved half a second: `keys.0.time`, `keys.1.time`, …) are one edit `{ field:
"keys.*.time", named?, count, shift: { by } }`, and `fields` names that pattern. The indexes a
list's created, deleted or moved objects shifted are stated once too, `{ parent, field, from,
count, shift: { index } }` in `footprint` for each run of at least 4 items kept whose index moved
by one amount (the bottom layer of 200 moved to the top: `{ from: 1, count: 199, shift: { index:
1 } }`), unless a footprint of a field already states that list. In `others`, an object others
created is told by its id, type, `at`, its fields' names and only the values of its naming fields
(`name`, `title`, `label`, `text`, `caption`, `kind`) and `position` fields; `changes: "all"`
tells every value.
`changes: "all"` lists every object and no footprint.
A tool id on an `integer` field without prefix (a clip `9`) is a number in `changes`,
`others`, `conflicts`, `_query`'s objects and a batch's `loaded`, as the kit's commands take it;
`on`, `_query`'s `objects` and a batch's `target` take `9` or `"9"`. A position's parent takes the
form of its type.

### What others changed

Several agents, and people editing the file, may work on one document at once. Every answer of
`<prefix>_inspect`, `_query`, `_run` and `_batch` on a file the headless kit edits (or a headless
draft) carries `revision`, a short token (`qxa7`) naming the document's state it describes. The
server keeps each document's journal: every accepted write, by the agent that made it, and every
change found in the file (by `outside`, compared object by object with what the server had read,
by the ids the tools use). A file open in an editor that lists the Kit UI capability `changes`
has a journal too, of the editor's document: before every call the server reads the editor's
replica version, and what changed since the version it was up to that no agent call made (each
write moves it past its own change) is someone else's, an entry by `person` when the editor
reported the change as the person's, else by `other`, with its change set. Its revisions are the
editor's own: a `basis` from the headless kit's answers is unknown there, and the other way
round. Every tool on a document's contents takes `basis`, the `revision` of
the last answer the agent was given:

| Member | Meaning |
| --- | --- |
| `others` | what others changed since `basis`, merged into one change set as `changes` reads (capped at 50 objects, `truncated` counting what each list left out; when it lists fewer than changed, parts created, deleted or moved come first, then the objects the pending call names, then the rest, so a slide another program duplicated is always named), with `by` (the other agents' names, `outside`, and in the open editor `person` or `other`), `unnamed` (changes made in the file to objects no tool id names, counted by type and list: `{ "Media": { "changed": 1 } }`; the root's own fields and derived values are named by its object id instead when the kit keeps it on every read), `renumbered` (one line naming the ids another program renumbered in the file) and `unknown: true` when part of it cannot be told object by object; left out when nothing |
| `conflicts` | on a refused write: `[{ id?, reason, now? }]`, `reason` `deleted`, `relocated`, `changed` or `unknown`; `now` where the object is now (`{ parent, field, index }` and its `position` fields, one named like those three in `now.fields`; or a part as `{ "slide": n }`) |
| `interface` | (`_inspect`) the protocol, the kit and its version, `khp/2 kit.slide@1.4.0`; `serverInfo.version` is the kit's |

A write with `basis` is checked before anything runs against its premises: its targets (the ids
in each step's `on` and in the parameter a command declares as its `targets`, the objects a batch
operation names, and the declared targets of a batch's `command` operations), every object any
other parameter names, the part a step addresses (`at.part`, the run's `target`), and the fields
a batch replaces (`set`, `text.set`). An object a parameter names: in a step's or a batch
`command` operation's other parameters, a `set` operation's `value` and a `create` operation's
`fields`, each string that is a parameter's whole value, an item of a list, or a member of an
object or of a list's objects (one level deep, nothing deeper), and each whole number there when
the parameter names objects (`"x-khp-role": "object"`, or an index spelling: an integer tool id,
`from: 5`; a count or an element index is no id), counts as a target, on any field,
when the WHOLE string names an object of the document as it was at `basis` (one others' changes
name and did not create, or one the document has now, by tool id or object id). So a shape given
as `id` to a command that declares `ids`, or as a connector's `from` and `to`, is checked as a
declared target is; free text that names no object is nothing, and a part of a string never
counts (a text that is exactly an object's id does). It is refused as a whole with `error.code` `conflict` (`retryable`), `others`, `conflicts` and the
`revision` to pass next, when others since `basis`:

- deleted a target, or a part named by its id (`deleted`);
- moved a target or an object holding it, created, deleted or moved objects before it in its list
  so that its index changed, or changed which part a part number (`{"slide": 3}`) names
  (`relocated`). Indexes are followed through every entry since `basis`, the agent's own included.
  A part's noun names the type whose tool id carries it (`slide` the type with prefix `slide:`),
  and the parts are the root's list of that type; a kit's declared nouns (`agent.parts`, `page`
  and `slide` included) address parts by id only, and when no type's tool id carries the noun as a
  prefix the part's type is the one named as the noun (`sheet` → `Sheet`), its id as listed. A part
  addressed by number conflicts by its tool id (`slide:271`), `now` giving its number now;
- moved a target in time, order or space: changed a field the kit's schema marks `position` (a
  clip's `start`), or a path inside one (`location.0`, one coordinate of a json position), which is
  a move, not a change of content (`relocated`, `now` with those fields' values now; a position
  field named `parent`, `field` or `index` is in `now.fields`, apart from the list place). A
  command declared position-independent (`x-khp-position: independent`, a clip's opacity) is not
  refused when its target only moved, its index shifted or a holder moved: the write runs, and
  `others` says the target moved;
- changed what a step names by a place (`relocated`): a step that gives a parameter the command
  marks `x-khp-role: place` (a track, a time; also beside its `targets` parameter, where a placed
  clip lands), a value in the command's index spelling in any parameter (`"#3"`, `parent: "#2"`),
  `at.time` to a command that reads `time` (also beside `on` or its `targets` parameter:
  a source by id written at the playhead), or, with no `on` and no `targets` parameter, the
  current time, names whatever is there (the kit's `context.under` says what: nothing, for a time
  that selects no object). Its premise is that the objects under the place now (Kit
  Process Protocol `context.under`) are those that were there at `basis`. For a place in time the kit
  gives as a span over its items' time fields (`within.time`), the guard replays which items
  covered it after each change since `basis` from the times the change sets carry (a changed
  `start`'s value before, a deleted item's times, kept by the journal and never shown): refused
  exactly when others put an item under the place or took one from it, and a change next to the
  place (a neighbour trimmed, a clip inserted after it) does not refuse. A place in the index
  spelling is followed through every change since `basis`: the object it named must be at that
  index still (when others moved it, the conflict names that object with `now`, where it is,
  besides the one `"#3"` names now). An index among a tree's children (a layer of a group) is followed alike, through inserts, deletes and moves below it and across groups;
  when the guard cannot read the list an index counts in, the write is refused (`unknown`). A
  command that counts its index from the other end (`x-khp-index-order: "reversed"`, a stack
  shown top-first) is followed from that end, and a conflict of a place by index says where the
  object is now in the command's spelling (`now.spelled`, `"#2"`). For a window the kit gives by indexes alone, an object under
  the place now that others created or moved, or one at or next to the window at `basis` that
  others deleted or moved, refuses it. For a place no window can declare (a world point, which
  depends on geometry, the hierarchy and visibility), the kit answers `covers` and the guard asks it
  (`context.covered`) whether each object others moved, reparented, hid, deleted or
  created since `basis` was under the place then, from the values the change sets carry: refused
  when an object under the place now was put there by others, or one that was there is not (the
  conflict names it with `now`, where it went, and `place.under`, what is there now); a move,
  delete or reparent elsewhere does not refuse. The objects under the place are targets too, as if named by
  id: their content and positions are premises, every field and every position unless the kit
  states fewer (below). Each conflict names the object, `now` where it is (index and `position`
  fields), and `place`, the place as the step named it with `under`, what it names now, so a retry
  can name the object by id. A kit that cannot say what a place names (no `context.under`) has such
  a write refused after any create, delete, move or position change by others (`place.unknown`). A
  step with no time of its own that reads `time` after an earlier step of the same run (which may
  have moved it) is refused after any change by others (`place.unknown`), unless the kit says its
  time names nothing. A place parameter is no object a step mentions. A whole number in the
  `targets` parameter of a command that declares `x-khp-index-numbers` is a place counted from 1
  when it names no object at `basis` or now, else an id. `on` takes ids only: an index spelling
  there is `invalid-params` when the command declares one;
- what a call needs, stated by the kit: the guard asks `context.under` for every step of
  a write with `basis`, and the kit may answer `premises`, `{ id, fields?, positions? }` for an
  object the call names (by id, by place, or one it reads that no parameter names, a sequence item
  holding the caption it edits). Where it gives `fields` (paths as receipts give them, positional
  or in the kit's words, `named`), only a change by others at, inside or holding one of them is
  `changed` (a held object with a tool id counts at its path under the object, `sequence.videoTracks.0.items.3`); a path may name a list item by a member instead of its index, `keys[time=2]` or
  `markers[id=7]`, which the guard follows through every save since `basis`: touched when
  an item matching it was changed or removed or an item now matching it did not before, not by
  index shifts of other items; where it gives `positions` (fields the schema marks `position`, and the list holding
  the object by its field, `clips` or `comp.layers`, for its index there), only a change of those
  is `relocated` (`[]`: the call does not depend on where the object is, as
  `x-khp-position: independent` says for every call of a command). An object the kit says nothing
  of keeps every field and every position. `fields` may name a derived value (`~topology`: a value the kit computes and never stores, which change sets tell beside the stored
  fields, `before` and `after` when small): a write by face index holds the mesh's topology, not
  the whole mesh, and applies after a vertex moved. A change set whose derived values the server
  could not read refuses such a premise for any change of the object;
- changed a field a batch replaces, or any field of a command's target but its `position` fields,
  since what a command writes is not known (`changed`). A change inside the target counts: an object without a tool id
  is reported under the nearest object holding it that has one, at a path (editing a shape's text
  is a change of the shape at `body.paragraphs.0.text`, which conflicts with a batch replacing
  `body` but not one replacing `color`), and a change of an object with a tool id the target holds
  (a text body with its own id) is a change of the target. Holding is the schema's ownership: list
  and tree fields, and refs declared `owns`; a shared object a plain ref points to is not held. A
  batch naming a held object by the object id a query answered is checked by following the paths
  others' changes give to it;
- changed the part itself, for a step that acts on its part: a step with no `on`, no `targets`
  parameter given, no place, and no parameter naming an object, that addresses a part (`at.part`,
  the run's `target`; a comp's marker, its settings, a slide's own properties) has that part as its
  target (`changed`, with the part's tool id). Only the part's own fields count, and changes held
  in it without a tool id of their own (a comp's `attrs` under its item); not its position, not
  its lists of objects (a layer added), not the objects with tool ids it holds (a layer's
  opacity). A step that names an object keeps its part as a premise of existence (and, by
  number, of position) only.

A step whose parameters the command's schema does not take (`additionalProperties: false`) is
refused as `invalid-params`, in the kit's words, before the guard: a misspelt parameter whose value
happens to name a changed object is never a `conflict`. A top-level parameter's value of a type its
schema does not allow (`type`, or a `oneOf`/`anyOf` of types; `null` counts as left out) is refused
the same way; nothing deeper is checked there (an array's items, an object's members, `enum`,
bounds), which stays the kit's to refuse when the step runs, after the guard.

Limits of the place premise: a place the kit gives as a window of indexes (no `within.time`) is
told approximately: an object next to the window that others deleted, moved, or moved in time
refuses the write though the place may name the same objects. A place in time is replayed exactly
only from change sets that carry the times. SDK editor receipts retain private
`$was` position values; custom change adapters must preserve them. When the
historical placement cannot be established, the kit must answer cannot-say and
the held comparison refuses `unknown`.
Times are compared as 64-bit floats: exact for tick counts below 2^53 (about ten hours at 254 016
000 000 ticks a second). For a kit that marks no `position` field, a place is followed by indexes
only: a change of an object's time that keeps its order is not seen.

The server reads the document for the guard as the agent (a batch with origin `{ kind: agent }`
and no operations, which makes no edit and no undo step), as a kit process requires.

#### A change made in the file

When the file changed since the agent's last call on it ended (another program saved it), the
next call has the kit read it again, once, and compares the document as the server last served
it with the document as read now. The first is read from the document the kit still holds,
before anything asks the kit to open the file (a kit may read a clean document again when it is
opened and its file changed), and only when the kit holds it at the object-model version the
server last served; otherwise (the kit read the file on its own, or was started again) the change
is `unknown`. The two reads are paired object by object, not compared by object id: a kit that
builds its replica from its file mints new object ids on every read, and only tool ids survive
(the pairing: [data model](../platform/data-model.md), "Two reads of one file compared"). So
`others` tells the colleague's edit as a receipt would (`shape:9/2` at `body.paragraphs.0.text`,
before and after), a picture whose shared media got a new id did not change, and changes of
objects no agent can name (layouts, masters, media) are counted by type in `unnamed`. A file
saved again unchanged (in another form: a package's parts reordered or stored) is no change:
nothing is reported or refused. Parts addressed by number are followed through the change as
through any other (a slide inserted before the one a step numbers is `relocated`, its deletion
`deleted`).

When another program renumbered objects (two shapes swapped their numbers, their content
unchanged), `others` says so in one line (`renumbered`) instead of telling each shape's text as
changed into the other's, and a write naming one of them is refused as `unknown` with its id,
saying to inspect again. The `revision` that refusal gives is the agent's own `basis`, not the
current one: a revision means "you have seen the document up to here", and a retry with a later
one would make the stale id current and write into the other shape. So a retry is refused again
until a read (`_inspect`, `_query`) gives the agent the ids as they are now.

A change of a shared object (media, a layout) never refuses a write to an object that points at
it: the write's target did not change, and a shared object is another object, as for any object
a write does not act on.

On the mock kit (a debug build, ten slides, thirty shapes with text, a table, two connectors,
median of 10, on a shared machine) a write with `basis` took 40 to 80 ms with no change made in
the file, 280 to 650 ms after an unrelated change (the two reads walk the document in a few
batched loads each, and one more load names the ids inside json values), and 190 to 240 ms when
refused; `others` for one text edit is about 230 bytes. On the presentation kit's 20-slide test
deck, 50 writes after 50 file changes took 170 to 260 ms each (median), none refused. The pairing is `O(N log N)` in the
objects of both reads. A document of any size is walked: on the mock kit, a deck of 2,100 slides
and 21,026 objects took 19 s per write after an unrelated change (debug build; each read of the
document about 4.4 s, the kit's read again 1.2 s, the comparison 2 s), the change told object by
object and no write on an untouched shape refused. Only the change set is kept afterwards.

#### What a kit must provide for outside changes to be compared precisely

- Tool ids (`toolId`, OM9) on the objects agents address (slides, shapes, notes): they pair the
  two reads by construction. The tool id's field may have any name, `id` included (loads answer
  every declared field in `fields`).
- `owns` on the refs and maps that hold parts of an object (a shape's text body, a table's cells):
  objects without tool ids pair by their place under a paired holder, and their changes are told
  at a path under it.
- Object ids kept in json values and map keys as whole strings or `:`-separated key segments (a
  connector's `look.kind.start`, a cell's `<row id>:<col id>`), never inside longer text.

Nothing else: no stable object ids across reads, no kit-side diff.

Changes by others to anything else never refuse: the write runs and its answer carries `others`.
The agent's own writes never count against it. A `basis` the journal no longer covers (it keeps
256 entries and 20,000 objects of change sets per document by default,
`KitManager::with_journal_limits`; it drops the oldest entries first and never the newest, so the
revision handed out before the latest change is always covered, however large that change), or an
entry since that cannot be told object by object (a kit without an object model, a file changed
while the document had unsaved edits), is refused with `unknown`: inspect again. An agent's undo
(`edit.undo` in the agents' scope) is refused as `conflict` when the agents' last step is another
agent's, so an agent never takes back another's edit.

Each MCP connection is its own agent: the client's `clientInfo.name` and a suffix drawn for the
connection (`claude-code-x3k9`), the author of its writes in the journal and the label of the
`origin` of its batches; the person stays the principal its edits are attributed to (A11). A
server that does not tell connections apart (`mcp::handle_with`) is one agent, `agent-` and a
suffix drawn per process.

`--guard epoch` refuses any write with `basis` after anyone else's change; `--guard off` disables
staleness refusals but still answers `others`; raw batch declaration and model validation
still apply. `--require-basis` refuses `_run` and `_batch` without `basis`
(`invalid-params`). A call without `basis` keeps the A56 notice: after the file changed outside,
the next read says so once (`changedOutside`) and the next `_run` or `_batch` is refused once;
reads do not clear the refusal. On the mock kit a debug build's run took 5.8 ms without `basis`
and 7.0 ms with it (median of 20, another agent writing between runs); a `revision` is about 4
characters, a typical `others` of one changed object about 175.

### Receipts, replacements and declarations

Receipts and `others` expose public model changes. Private derived premises and
unproven derived comparisons stay in the guard's journal; unchanged derived
facts are omitted. Requests for all changes follow the same visibility rules.
An absent `before` or `after` member is distinct from a known JSON null value.

Commands that replace the document can complete through the replica exchange
and isolated planner. The exchange loads the new document and discards the old
scratch history. A receipt whose original version belongs to the replaced
document may report `changesUnavailable`; it never claims nothing changed.
Malformed replacement exports still fail with their reason.

An explicit `region: null` is passed to the kit's content callback as null;
omitting the required region remains invalid. Explicit declared `targets`
replace fallback selection reads. Other object parameters and per-call
premises retain the dependencies the kit declares, including newly created
objects it explicitly holds. Unnecessary selection or sibling holds require
the kit to narrow its declarations. See the
[call-context guide](../platform/kits/call-context.md#selection-and-list-holds).

A clean outside file reload preserves resolving editor state. Kits reconcile
file differences into the existing session so agent undo still addresses the
agent's own history and retains outside edits. A deleted active target or a
kit unable to reconcile retained history refuses with `file-conflict`; the
previous session stays intact. Reobserve after resolving the conflict. Kits
adopt this through the [reread contract](../platform/kits/call-context.md#session-continuity-on-reread).

Conditional command recipients can be guarded with the existing coverage
callbacks. Kits declare the chosen parameter branch and reconstruct historical
subset or content matches, including recipients that no longer match now.
See [conditional recipients](../platform/kits/call-context.md#conditional-recipients).

JSON resource conflicts distinguish `deleted` stable addresses from
`relocated` index occupants and renamed sources. Kits declare an immutable
member with `Premise.identities` for either selector or index paths. Outside
identity-paired tool ID renames report `relocated` and `now.id`. See the
[resource identity contract](../platform/kits/call-context.md#json-resource-identity).
Literal premise paths can use JSON Pointer syntax, such as
`/data/flag[id=7]`, so map keys containing selector syntax remain literal.
Receipt edits may omit `before` or `after`; absence means the value was not
provided, while a present `null` is a known null value.
Kits may declare `{kind:"map",owns:true,of:"Cell"}` for maps of object IDs.
The SDK enforces the referenced type in both Rust and TypeScript and resolves
public IDs in `map.set`; omit `of` for untyped owning maps.
Successful closing commands return `closed:true` and end the run with
`saved:false` and no `document` view. No post-close state restoration,
receipt capture or preview runs. `notRun` counts any following steps; put close
last. Kits adopt this by returning `{closed:true}` after closing and declaring
only the premises close actually needs.

Command schemas and per-call premises describe the objects, fields, places,
editor state and external inputs a write reads. With a `basis`, the server
compares those dependencies against recorded changes and refuses a stale write
before executing it. Unavailable comparisons refuse `unknown`.

Kit authors should follow the [call-context guide](../platform/kits/call-context.md)
for declarations, isolated batch planning, projected objects, callbacks and
history limits. [Environment tasks](env.md) use the same guarded calls for replay.

Example: [examples/agent-mcp](../../examples/agent-mcp) appends a section to a note, then has the
Note kit check it.

## Drafts

With `draft: true` on a call (or every call, with `--drafts`), the agent's edits go to its
**draft** of the file and the file stays as it is. The draft lives in the workspace's
`.kition/drafts/<key>/` (`draft.json`: `path`, `kit`, `mode`, `state`, `baseSha256`, times), so
it survives the server; `<prefix>_inspect`, `_query`, and `_check` with `draft: true` read it.
The agent asks for review with `<prefix>_draft_ready`. It never merges: merge and discard are
not tools.

Only a kit whose `kit.json` declares `agent.drafts` keeps drafts (KHP A12) and offers
`<prefix>_draft_ready` and `<prefix>_draft_reopen` (A35). A call that asks another kit for a
draft (`draft: true`) is refused with `unsupported`. Under `--drafts`, the server's choice not to
edit files directly holds for every kit: an edit (`<prefix>_run`, `<prefix>_batch`) of a kit
without `agent.drafts` is refused with `unsupported` and changes nothing, unless the call says
`draft: false`, which edits the file itself; reads, exports and new files are not edits and run.
The server's instructions name those kits. So no edit is left in a draft that no tool can hand to
the person and `drafts list` does not show, and no file is edited against the server's mode
without the call saying so. `@kition/embed`'s agent port answers the same in a page whose kit
keeps no drafts.

The person, or your page's server for them, reviews and merges with `kition mcp drafts`
(`kition mcp drafts list --workspace <folder>`, `kition mcp drafts merge <path> --workspace
<folder>`, ...) or `workspaceDrafts` in `@kition/script/node`:

```ts
import { workspaceDrafts } from '@kition/script/node'

const drafts = workspaceDrafts({ server: 'kition', serverArgs: ['mcp'], workspace })
// with the SDK bundle: { server: 'bin/<platform>/kition-kits-mcp', workspace, kitsDir: 'kits' }
const [draft] = await drafts.list() // { path, state: 'ready', stale, mode, … }
const comparison = await drafts.compare(draft.path, { previews: true }) // { diff, summary, previews }
await drafts.merge(draft.path) // the person approved: the draft becomes the file
```

| Command | Answers |
| --- | --- |
| `drafts list` | `{ drafts: [{ path, kit, mode, state, baseSha256, created, updated, stale }] }` |
| `drafts compare <path> [--previews]` | `{ path, kit, mode, state, stale, diff, summary: { base, draft }, previews? }`; `diff` is `{ created, changed, moved, deleted, texts, truncated?, renumbered? }`, using the receipt vocabulary and ids for any declared object model; otherwise `null` with `diffUnavailable` |
| `drafts merge <path> [--overwrite]` | `{ path, merged, sha256 }`; refused as `stale` when the file changed since the draft forked |
| `drafts discard <path>` | `{ path, discarded }` |

Compare keeps at most 50 objects, 50 entries per nested list, and 80 Unicode characters per
value, with `diff.truncated` counting omissions and `{ excerpt, length }` for long values.
File copies export and pair their states. See [the comparison shape and limits](../platform/kits/implementations.md#manifests-and-headless-drafts).

A refusal prints `{ "error": { code, message } }` and exits with status 1 (`not-found`, `stale`, or
a tool's error code). A file's replica is rebuilt each time a kit opens the file, so a draft
merges onto the version it forked from: the merge writes the draft as the file when the file is
unchanged since. Kition's own agent keeps drafts in the person's open editor instead.

## Open embed (`agentPort`)

When the person has the file open in your page (`@kition/embed`), your agent can work in that
editor instead of on the file: `editor.agentPort()` serves the same tools over MCP, and your page
and server relay the messages ([embed.md](embed.md), `relayAgentPort`, `createAgentRelay`). There:

- edits go to the agent's **draft** unless the page allows live edits; finish with
  `<prefix>_draft_ready` and the person merges or discards it in the page;
- `path` is the open document's name; only the tools the kit's editor supports are listed
  (`<prefix>_query`/`_batch` with an object model, `_check` with checks, the draft tools with drafts);
- the answers and error codes are those of `kition mcp`.

Without a relay, the agent works headless on the file as above, and the page reloads when the
file's version changes. [examples/agent-mcp/live.mjs](../../examples/agent-mcp/live.mjs) drafts in
an open note through the example page.

## In the SDK bundle: `kition-kits-mcp`

This section is for a product that ships the SDK bundle ([distribution.md](distribution.md)) and
starts the server itself, on the kits the bundle carries rather than on a kit store. An agent
user does not need it: `kition mcp` is the same server ([Connect your agent](#connect-your-agent)).

The bundle's `bin/<platform>/` holds `kition-kits-mcp`, the same server without the kit store:

```sh
# from the unpacked SDK bundle
bin/<platform>/kition-kits-mcp --workspace <folder> --kits-dir kits
# or one kit: --kit bin/<platform>/kition-note (repeatable)
```

`--kits-dir` names the bundle's `kits/`, where each kit's `kit.json` is; the server finds each
kit's executable in the bundle's `bin/<platform>/`, beside itself, through
`KITION_KIT_<KIT>_BINARY`, or on the PATH, and says on standard error which kit it found no
executable for (`--list-kits` gives the same reason). It takes `kition mcp`'s options and its
`drafts` commands (`kition-kits-mcp drafts list --workspace <folder> --kits-dir kits`), with these
differences: `--workspace` is required, there is no store, and it installs no kit (no
`--no-install`, no `--index`). In an `mcpServers` file, the command is its path and the
arguments are `["--workspace", "<folder>", "--kits-dir", "<bundle>/kits"]`.

Kition kit platform: [`KitAgent 1.4`](../platform/sets/agent.md): tools (A1–A6), object-model tools (A16), error
codes (A18), resources (A19), Verify (A21–A23), DeepSeek Harness (D1).

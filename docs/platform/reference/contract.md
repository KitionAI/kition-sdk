# Kition SDK Contract

Version 1. A kit implements it with the `kition-kit` crate; Kition's in-page
editors use exactly these members. Changing the contract bumps
`CONTRACT_VERSION` here and `KIT_CONTRACT_VERSION` in Kition together.

## The contract

Each kit repository adds `crates/kition-<kit>-kit` on top of the
`kition-kit` crate. The SDK's `examples/grid-kit` provides a complete example:

```rust
use kition_kit::{KitCommand, KitDocument};

pub struct SketchDocument { /* the engine's session */ }

impl KitDocument for SketchDocument {
    fn open(name: &str, bytes: &[u8]) -> Result<Self, String> { /* … */ }
    // create, width, height, revision, dirty, render, render_area,
    // execute, inspect, commands, save, mark_saved
}

kition_kit::export_kit_document!(SketchDocument as "SketchDocument");

#[test]
fn keeps_the_kit_contract() {
    kition_kit::testing::check_contract::<SketchDocument>(&fixture(), "fixture.sketch", |doc| {
        doc.execute("draw.line", serde_json::json!({ "from": [1, 1], "to": [20, 10] })).map(|_| ())
    })
    .unwrap();
}
```

- `check` is optional: override it to answer what is wrong with the document
  as `kition_kit::diagnostics::Diagnostic`s ([`KitAgent 1.4`](../sets/agent.md) A21, the agent's
  `<prefix>_check`); the default answers none. `check_contract` checks that
  its diagnostics are well formed and that it changes nothing.
- `editor_state`, `restore_editor_state` and `set_context` are optional: a
  kit whose commands read editor state (`KitCommand::reads`, an
  `EditorState`: `Selection`, `Part`, `Time`, and `Mode` (the editor's mode,
  which changes what a command does to the same objects: a 3D edit mode, a
  document's editing mode) and `Active` (the active layer, track or object
  new content goes to; a spreadsheet's active sheet is its `Part`)) answers a
  snapshot of it, puts a
  snapshot back, and sets it from a `kition_kit::CallContext` (`on`, the ids a
  call acts on; `part`, as a run's `target` names it; `time`, in seconds).
  No context member sets `Mode` or `Active`: the snapshot includes them so a
  host puts them back, and a run sets them with the kit's own command.
  None of them may mark the document dirty, move `revision`, enter the undo
  history, or change the document's content;
  `kition_kit::testing::check_context(doc, context, EDITOR_STATE)` checks it
  with a context that moves the editor. Its third argument is the kit's
  editor-state list (the keys and JSON Pointers of `inspect()` that are
  editor state, the same list the kit gives kition-headless as its volatile
  keys, and the list `kit.json` publishes to hosts as `engine.editorState`,
  [manifest](../kits/manifest.md) K23): `inspect()` may report the current part, the selection or the
  playhead, and the check compares `kition_kit::document_content` (inspect
  without them and without the session's bookkeeping), `revision`, the dirty
  state and `canUndo`/`canRedo`, then that `restore_editor_state` brings
  `editor_state()` back to the snapshot. Hosts set the
  state for one call and put it back (Kit Process Protocol section 7a); by
  default a kit keeps no state and refuses every member given. The steps of
  adopting it are in [Adopting call context in a kit](../kits/call-context.md).
- `KitCommand::targets` names the parameter a step's `on` fills. It is an id
  or a list of ids: a `string`, an `integer`, or a `oneOf` of those (what
  `from_kit_params` writes for `{id}`, or for a parameter that takes a name or
  an id), or an `array` of any of them. `kition_kit::schema::check_targets`
  (run by `testing::check_commands`) refuses anything else: an object, a
  boolean, free `json`.
- `max_render_scale` is optional: the largest scale at which `render` draws
  the document as a zoom shows it, not its 1× pixels repeated. An engine that
  rasterizes vectors and text at the scale it is given answers 2 or more, and
  so may a pixel editor; the default is 1. A headless kit's `view.screenshot`
  (Kit Process Protocol section 7, [`KitAgent 1.4`](../sets/agent.md) A39) draws
  previews up to it and refuses a larger `scale`.
- `crate-type = ["cdylib", "rlib"]`. The macro expands to nothing outside
  `wasm32`, so native `cargo test` needs no wasm-bindgen. A kit's own extras
  go in another
  `#[wasm_bindgen(js_class = "<Class>")] impl __kition_kit_export::WebDocument`
  block and are reached from the page with `KitEngine.invoke`.
- No `unsafe`, no `unwrap`, `expect`, or `panic!`. Bad input returns an error
  (a `JsError` in JavaScript), never a panic, because a panic kills the worker.
- `examples/grid-kit` is the smallest complete kit to copy. It does not
  depend on wasm-bindgen; the macro brings it. Extras beyond the contract
  go in an `impl` on
  `__kition_kit_export::WebDocument` through `kition_kit::wasm_bindgen`, as
  `grid-kit`'s `greyAt` shows; Kition calls them with `KitEngine.invoke`.

The JavaScript class the macro generates (`KitModuleDocument` in
Kition's `src/features/kits/module/kitModule.ts`):

| Member | Meaning |
| --- | --- |
| `static open(name, bytes)` | Opens file bytes; `name`'s extension picks the format |
| `static create(name, width, height)` | A new blank document (for New) |
| `static contractVersion()` | The contract the SDK implements (now 1); Kition refuses newer ones |
| `width`, `height` | Document size in document pixels |
| `revision` (`u64`, a `bigint` in JS) | Moves with every change |
| `dirty` | Unsaved changes exist |
| `render(x, y, scale, width, height)` | RGBA8, straight alpha, of the area at (`x`, `y`) shown at `scale` screen pixels per document pixel. Below 1 it averages; above 1 it repeats exact pixels |
| `renderArea(x0, y0, x1, y1, width, height)` | RGBA8 of exactly that integer area averaged to exactly that size. When the area is k times the size, every output pixel must be the exact k × k box average (the canvas relies on it for seamless patches) |
| `execute(command, paramsJson)` | Runs an engine command, returns its JSON result; unknown commands and bad parameters are errors |
| `inspect()` | The document as JSON; must include `canUndo` and `canRedo`; the rest is the kit's own. A headless kit's `view.describe` (the details of `<prefix>_inspect`) leaves out the session's bookkeeping at the top (`canUndo`, `canRedo`, `dirty`, `revision`, `history`, `undo`, `redo`, `path`, `title`) and the editor state the kit declares (the `volatile` keys it gives `kition_headless::run_manifest`, which `kit.json` publishes as `engine.editorState`: a name wherever it is, a JSON Pointer such as `/time` at that place only); nothing else is taken for editor state by its name, so a keyframe's `time` stays. A host that reads `inspect()` in the page leaves out the same (Kit UI protocol `ai/inspect`) |
| `commands()` | JSON array of `{ id, title, description?, menu: string[] \| null, shortcut, params, mutates, enabled, schema?, outputSchema?, keywords?, targets?, reads? }`. `targets` names the parameter that says what the command acts on (an id, or a list of ids), which an agent's run step may give as `on`; `reads` lists the editor state the command reads besides its parameters (`selection`, `part`, `time`). `description` is what the command does, when to choose it over the commands next to it, and what it changes or answers, in one or two sentences: hosts list it to people and agents (an MCP `<prefix>_commands` answer carries it, and command search matches its words). It is never the title again nor the parameter notation, and a host makes none up when a kit gives none; `kition_kit::testing::check_commands` checks it, and that every read command an agent is offered (`mutates` false, with a `schema`) has an `outputSchema` or is listed as answering nothing. `keywords` are words an agent's command search finds the command by that its id, title and params do not say (the effect names `effect.apply` takes); they are searched, never listed. Kition builds the menus from `menu` and binds `shortcut`; `schema` is the parameters as a DeepSeek Harness `ParameterSchemaSpec`, which makes the command available to agents; `outputSchema` is what the command answers, one `ValueSchemaSpec` (KHP A1 `output.schema`, checked by `kition_kit::schema::validate_output` and `check_contract`), which hosts send as the tool's MCP `outputSchema`. Optional in contract 1: a command without one lists no output schema |
| `disabledCommands()` | JSON array of the ids of the commands that cannot run now. Hosts ask after every change for menu and shortcut states, so it must be cheap; `KitDocument::disabled_commands` defaults to deriving it from `commands()`, and kits whose commands carry schemas answer it directly. Optional in contract 1: hosts fall back to `commands()` when it is missing |
| `prepareSave()` | Optional: gets the document ready for `save`, right before it (engine rule E4). A kit whose file holds its KDM replica seals the live replica here (`KitDocument::prepare_save`, `KitSession::seal`; data model 7.3). It changes no content and does not mark the document saved. Kition calls it before every `save` |
| `save(name?)` | The document as file bytes. It must **not** mark the document saved |
| `markSaved()` | Marks the last `save` as written. Kition calls it only after the file reached the disk |
| `takeOutput(id)` | Optional (E16, [`KitFiles 1.1`](../sets/files.md)): the next chunk of the bytes of an output a command answered in `outputs`, empty once all were taken; the engine then forgets the output |
| `editorState()`, `restoreEditorState(state)`, `setContext(context)` | The editor-state hooks (`KitDocument::editor_state`, `restore_editor_state`, `set_context`) as JSON text: the state that is not the document (`null` for a kit that keeps none), putting it back, and setting what one command reads from a call context `{ on?, part?, time? }`. `export_kit_document!` adds them. An editor runs an agent's step in an editor state of the agent's own with them, so the person's selection, part and time do not move ([Kit UI protocol](ui-protocol.md) section 2, capability `context`) |
| `free()` | Releases the document |

Two module functions beside the class, both optional in contract 1, give a
web build fonts it does not embed ([engine contract](../kits/engine.md) E9,
E9a): `addFont(bytes)` adds a font file's faces and answers how many it added,
and `wantsFonts()` answers whether text laid out since the last call needed a
character none of the faces has, and clears it. kit-editor gives `addFont` the
engine manifest's `fonts` before a document opens and its `lazyFonts` once
`wantsFonts()` answers `true` (right after the document opens when the engine
has no `wantsFonts`); `KitEngine.onFonts` tells the page after each one.

Commands must include `edit.undo` and `edit.redo`; the shared frame's Undo and
Redo call them. Under engine contract 2 they take an optional `scope` (`"person"`
or `"agent"`) and otherwise work in the scope of the origin they run as
([engine contract](../kits/engine.md) E14a). Shortcuts are written `Cmd+Shift+Z`, `Alt+Backspace`, `F12`;
`Cmd` means Control off macOS.

Prove the contract twice: `check_contract` in the kit's Rust tests, and the
built WebAssembly with `tools/check-sdk.mjs` (`--dir`, `--module`, `--class`,
`--name`, `--edit`, and `--files` for lent files). `--edit` is one
`{command, params}` step or a list of them; a string `"$0.item"` in params is
step 0's result field (create a clip, then place it). In Kition, `kits/modules.json`
lists the built-in kits and `pnpm check:kit-modules` checks them.

Building a kit's WebAssembly module needs `wasm-pack` and a Rust toolchain
supported by the kit. Build outputs are not committed. wasm-pack writes a
`.gitignore` of `*` into its output directory.

The headless executable must also reload a document from disk when the file
changed since it read it and nothing is unsaved there. Otherwise the agent
edits a stale copy and its save overwrites the person's work. The SDK's
`kition-headless` crate handles reloading for kits that use it.

## Lent files

A document that refers to other files (a film project's media, linked
images) reads them with `kition_kit::host::{size, read_range, read}`. Reads are
synchronous; in Kition the kit worker serves them as ranged reads of the
workspace, so long media is never loaded whole and never copied into the
document.

- Paths are as the document names them. Kition resolves relative paths against
  the document's folder and refuses anything outside the workspace.
- Errors are messages: missing media is an ordinary error the editor shows
  ("media offline"), never a panic.
- A link check asks `kition_kit::host::exists(path)`: `Ok(true)` when the
  file is there, `Ok(false)` when the host says it is not found (Kit Process
  Protocol `file_not_found`, answered only for a path that passes every
  check of H3 and LR2), and `Err` with the host's refusal otherwise, the
  same whether the file exists or not. Report a missing file only on
  `Ok(false)`: a host that cannot tell (an older one, or a page binding
  without `kitionHost.exists`) answers `Err` for both.
- In native tests, `kition_kit::host::set_root(Some(dir))` lends a directory,
  refusing hidden paths and links out of it as a host does.
  `tools/check-sdk.mjs --files <dir>` does the same for the built SDK.

Lent files are an optional capability of contract 1: a kit that never calls
`host` works in any host.

Files the host granted ([`KitFiles 1.1`](../sets/files.md), E15) are read the
same way, with the handle (`fh_…`) in place of the path: the binding answers
`host::read_range` for a handle from the host's grant, never from the
workspace by name.

## Links

Optional, for kits whose documents link other files (standard E17 to E19,
[`KitLinks 1.0`](../sets/links.md)). Extras the class gains, declared in
`kit.json` `extras` (K6):

| Member | Answers |
| --- | --- |
| `linksOf()` | JSON list of links (`{ id, kind, target: { path?, name?, docId?, url? }, view?, at, text }`), every outgoing link in document order, comments excluded; never reads a target |
| `areaOf(viewJson)` | `[x0, y0, x1, y1]` in document units for a link's `view`, or `null` |

`links.retarget { from, to }` is an ordinary command (E18). Link targets are
read like lent files, by the path the document stores; the binding answers
those reads from the link handles the host granted, so a read of a target
not resolved yet fails with `not-resolved` and the editor draws again once
it is.

## Engine tools

Optional, with the `engine-tools` capability (standard U8b,
[`KitPointer 1.0`](../sets/pointer.md) section 6). The class gains:

| Member | Answers |
| --- | --- |
| `tools()` | JSON list of `{ id, label, shortcut, icon, group, role, mutates, hint }` |
| `tool()` | The active tool's id |
| `selectTool(id, zoom)` | A tool response |
| `pointer(eventJson)` | A tool response; the event is `{ action: down\|drag\|up\|move, x, y, mods?, zoom, button, pointerType, clicks, pressure?, tilt? }` in document pixels (a double click is `down` with `clicks: 2`) |
| `toolKey(key, modsJson, zoom)` | A tool response |
| `toolText(text, zoom)` | A tool response |
| `toolState(x, y, modsJson, zoom)` | The overlays and cursor now |

A tool response is `{ requests, overlays, cursor, busy, wantsText,
selection?, caret? }`; `kition_kit::tools` defines every field. Version 2 of
these types (roles, the new event fields, `selection`, `caret`, and the
requests and overlays of `KitPointer 1.0` section 6) replaces version 1 with
no compatibility layer; the SDK does not implement it yet. `examples/grid-kit` has a one-tool
example (a pencil).

A response may also carry `damage: { x0, y0, x1, y1 }`, the document area (document pixels) the
event changed when it changed only that: a caret or a text selection moved. The page then
re-renders that area of every pane it reaches instead of the whole view, so it must cover every
pixel the event changed. A kit gives it with `KitTools::take_damage` (none by default: a change
repaints everything).

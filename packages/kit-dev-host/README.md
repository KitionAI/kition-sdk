# @kition/kit-dev-host

A development host for a kit's embedded editor. It mounts the editor in an iframe over the Kit UI
protocol with an in-memory workspace, so you can run and test a kit without Kition. Kit authors
load it from the kit's `dev.html`, and flow tests drive it through `window.devHost`. It can also
serve presence, KitFiles, host generation, opening files, and picking links, each from a script,
and keep each document's replica, checkpoints and view state.
An ES module with type declarations, for the browser.

```sh
npm i @kition/kit-dev-host
```

```ts
// dev.html holds <iframe id="kit">, <span id="status"> and <input id="file" type="file">.
import { startDevHost } from '@kition/kit-dev-host'

startDevHost({ sample: './sample/Sample.md', entry: './index.html', presence: true })

// In a Playwright test of the page (add ?role=viewer to open it read-only):
const state = await page.evaluate(() => window.devHost.connection()?.state())
```

### The workspace: lent files, picks, downloads

The dev host keeps an in-memory workspace (`window.devHost.files`: the document, the `files` you
list, everything the kit writes). Three things make it usable by a person at the page, with no
server of the kit's own:

- **Lent files.** `lend: true` lends the workspace to the engine (`document.lend`), as Kition
  lends a project's folder, so the engine reads footage, pictures and fonts beside the document
  with ranged reads. The engine reads them with synchronous requests from its worker, so they are
  served over HTTP by a Vite plugin: add `devHostWorkspace()` to the kit's Vite config. Every file
  put in the workspace is mirrored there at once, under a path of this page load.
  `folder` is the workspace folder the sample opens in, so its relative links resolve.

  ```ts
  // vite.config.ts
  import { devHostWorkspace } from '@kition/kit-dev-host/vite'
  export default defineConfig({ plugins: [react(), devHostWorkspace()] })

  // src/devHost.ts
  startDevHost({ sample: './sample/films/Cut.kfilm', folder: 'films', lend: true, pickable: /\.(mp4|mov|wav|png)$/i })
  ```

- **A real chooser.** When the kit asks to pick a file (`host/pick`, `links/pick`, or KitFiles'
  `files/pick` to open), the page shows the workspace files that fit (`pickable` and the request's
  extensions) and **Choose from computer…** (从电脑选择…), which opens the computer's file
  chooser for those extensions (several when the request allows) and copies the chosen files into
  the workspace beside the document. Tests keep answering at once: a queued answer
  (`scriptHostPick`, `scriptLinkPick`, `scriptPick`) comes first; with none, an automated browser
  (`navigator.webdriver`, as every Playwright browser is) or `?pick=first` (option `pick: 'first'`)
  answers the first fitting file (`host/pick`), all of them (`links/pick`), or cancels
  (`files/pick`). `?pick=chooser` shows the chooser in a test.
- **The Workspace panel** in the top bar (collapsed) lists every workspace file with its size and
  a download link, so a person can save what the kit exported, and **Add files…** copies files from
  the computer beside the document.

The page's own strings are in en-US and zh-CN (`?locale=`, else the browser's language).

### Replica, checkpoints and view state

`replica: true` keeps each document's replica (Kit UI protocol section 7), `checkpoints: true` its
checkpoints with it (section 7m: saved versions, record history), and `viewState: true` the
person's view state (section 7n); `?replica=1`, `?checkpoints=1` and `?view-state=1` do the same.
All three are kept in memory for the page load, per workspace path, apart from the files.
`@kition/kit-host` checks every rule (lengths, origins, read-only documents, sizes) before the
store runs. A checkpoint's `version` is the one the save's replica write carries (the version its
snapshot holds, UI-R6); the store keeps that save's snapshot and blobs with the checkpoint, so
`host/checkpointRead` answers them whatever was saved since.

- `devHost.reload()` reopens the document as its last save left it, keeping its replica,
  checkpoints and view state: a test saves a version, reloads, and finds it.
- `devHost.reopenChanged(bytes)` changes the open document's file outside the editor, as another
  program's save would (the editor closes, the file takes `bytes` at a new version), and reopens it
  with its replica, checkpoints and view state kept. The host hands the stored replica over under
  its earlier `fileStamp` (Kit UI protocol UI-R1): the kit opens with it and records the file's
  difference as one `import` change.
- `devHost.open(path, bytes)` opens a file alone: its replica is dropped; its checkpoints keep
  their states.
- `devHost.restoreCheckpoint(id)` restores the open document to a checkpoint's state as a host's
  "restore this version" does: `replica/restore` with the snapshot and blobs it keeps, one step of
  the person's undo.
- `devHost.recordCheckpoint({ origin: 'save' })` records a host checkpoint (which the kit may not
  change) at the kit's current version; saving a label at that version makes it the kit's.
- `devHost.history` answers what is kept: `replica(path)`, `checkpoints(path)` (newest first),
  `viewState(path)`.

```ts
// src/devHost.ts
startDevHost({ sample: './sample/Poster.kdesign', checkpoints: true, viewState: true })

// In the editor: useKitDocument / useKitSession from @kition/sdk/editor
const saved = await session.saveCheckpoint({ label: 'Sent to print' }) // null without the capability
const { checkpoints } = (await listCheckpoints(host.files, path, { labelled: true })) ?? { checkpoints: [] }

// In a Playwright test
await page.evaluate(() => window.devHost.reload())
const kept = await page.evaluate(() => window.devHost.history.checkpoints('Poster.kdesign'))

// A note changed outside the editor (dev page: startDevHost({ checkpoints: true }))
await page.evaluate((text) => window.devHost.reopenChanged(new TextEncoder().encode(text).buffer), changedMarkdown)
const still = await page.evaluate(() => window.devHost.history.checkpoints('Notes.md'))
```

Five subpaths run in Node:

- `@kition/kit-dev-host/vite`: `devHostWorkspace`, the Vite plugin that serves the lent workspace (dev and preview servers).

- `@kition/kit-dev-host/check-ui-ids`: `checkUiIds`, which checks that every control of the editor carries an element id the editor lists.
- `@kition/kit-dev-host/mode-smoke`: `runModeSmoke`, a smoke test of the editor in each display mode. It watches each page it opens with `watchPage`.
- `@kition/kit-dev-host/line-row`: `lineRowReport` and `focusBarReport`, what the Single line row and the Focus bar show.
- `@kition/kit-dev-host/watch-page`: `watchPage`, which says which step a test was running when its page crashed or was closed under it.

`watchPage(page, { name?, log?, now? })` returns `{ step(label), current, closing(), stop() }`.
Call `step(label)` before each step. A crash of the page is always printed (to `console.error`,
or `log`) with the step running then and how long it had run. A close of the page, its context or
its browser is printed only when the test did not close it itself: watchPage wraps `close()` of
those three objects, so a `close()` the test calls on any of them is not printed, while the
page's own `window.close()`, a browser process that exits, or a close through another handle is.
The page's line says whether its context and browser were still open. Call `closing()` before a
close that does not go through those objects, and `stop()` to remove the listeners. Playwright
reports a crash as "Target crashed" and a close as "Target page, context or browser has been
closed"; these lines tell which step and which object.

```js
import { watchPage } from '@kition/kit-dev-host/watch-page'

const watch = watchPage(page, { name: 'kit.sheet' })
watch.step('open the comments panel')
await frame.getByTestId('comments').click()
// watchPage: kit.sheet: the page was closed, not by the test, during "open the comments panel" (2310 ms into the step; http://127.0.0.1:5173/dev.html); its context is open, the browser is connected
await context.close() // not printed
watch.stop()
```

Documentation: https://developer.kition.ai/docs

<!-- kition-family:begin (generated by kition-sdk from templates/community/repositories.json, its family; edit the data there, not this text) -->
## Part of the Kition SDK

`@kition/kit-dev-host` is a package of the [Kition SDK](https://github.com/KitionAI/kition-sdk) ([its source](https://github.com/KitionAI/kition-sdk/tree/main/packages/kit-dev-host)), which lets you put Kition's editors in your product, and give the same files to your AI agent. Guides and reference: [developer.kition.ai](https://developer.kition.ai).

## The Kition family

Kition is the open pro suite for AI: 16 kits, editors that people and AI agents use on the same files, and the products around them ([all repositories](https://github.com/KitionAI)).

| Product | What it is | Links |
| --- | --- | --- |
| Kition Desktop | The open pro suite for AI: 16 editors and an agent in one desktop app | [GitHub](https://github.com/KitionAI/kition) · [kition.ai](https://kition.ai) |
| **Kition SDK** | Put Kition's editors in your product, and give the same files to your AI agent | [GitHub](https://github.com/KitionAI/kition-sdk) · [developer.kition.ai](https://developer.kition.ai) |
| `kition` command line | Install kits on demand and run them for your agent: `npx @kition/cli` | [developer.kition.ai](https://developer.kition.ai) · [Guide](https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md) |
| Kition One | A self-hosted team workspace built on Kition's kits | [one.kition.ai](https://one.kition.ai) |
| Kition Server | Real-time co-editing for kits, self-hosted | [developer.kition.ai](https://developer.kition.ai) |
| Kit Harness Protocol (KHP) | The open protocol between a kit and its host | [GitHub](https://github.com/kitharness/kitharness) · [kitharness.org](https://kitharness.org) |
| Kition Tessera | The design system for kits | [GitHub](https://github.com/KitionAI/kition-tessera) · [tessera.kition.ai](https://tessera.kition.ai) |
| Kition Showcase | Sample files for every kit | [GitHub](https://github.com/KitionAI/kition-showcase) |
| Kition Universe | A 3D map of the kits and what they make | [GitHub](https://github.com/KitionAI/kition-universe) · [universe.kition.ai](https://universe.kition.ai) |
| Kition Fonts | The open fonts the editors use | [GitHub](https://github.com/KitionAI/kition-fonts) |

| Product line | Kits |
| --- | --- |
| Office | [Note](https://github.com/KitionAI/kition-note) · [Table](https://github.com/KitionAI/kition-table) · [Board](https://github.com/KitionAI/kition-board) · [Doc](https://github.com/KitionAI/kition-doc) · [Sheet](https://github.com/KitionAI/kition-sheet) · [Slide](https://github.com/KitionAI/kition-slide) · [PDF](https://github.com/KitionAI/kition-pdf) · [HTML](https://github.com/KitionAI/kition-html) (Preview) |
| Design | [Photo](https://github.com/KitionAI/kition-photo) · [Vector](https://github.com/KitionAI/kition-vector) · [Layout](https://github.com/KitionAI/kition-layout) · [Design](https://github.com/KitionAI/kition-design) (Preview) |
| Media | [Film](https://github.com/KitionAI/kition-film) · [Motion](https://github.com/KitionAI/kition-motion) |
| Engineering | [CAD](https://github.com/KitionAI/kition-cad) · [Scene](https://github.com/KitionAI/kition-scene) (Preview) |

## License

Apache-2.0 ([LICENSE](https://github.com/KitionAI/kition-sdk/blob/main/LICENSE)).
<!-- kition-family:end -->

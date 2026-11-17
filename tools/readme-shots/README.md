# README pictures

`shots.mjs` takes a kit's README pictures: it starts the kit's Vite development host
(`web/dev.html`), opens a sample document in it with Playwright, runs each shot's steps, and writes
`assets/readme/<name>.png` at the kit repository's root. Every kit has a short
`web/scripts/readme-shots.mjs` that says what to open and what to show; this module does the rest.

Playwright and Vite come from the kit's `web/node_modules` (its `package.json` lists both), not
from kition-sdk, so the kit's own versions run. (`tools/readme-shots.mjs`, beside this folder,
takes kition-sdk's own README pictures and does not use this module.)

## A kit's script

```js
// web/scripts/readme-shots.mjs: the README pictures of Kition Poster (assets/readme/).
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdk = path.resolve(process.env.KITION_SDK ?? path.join(web, '..', '..', 'kition-sdk'))
const { takeShots } = await import(pathToFileURL(path.join(sdk, 'tools/readme-shots/shots.mjs')).href)

await takeShots({
  web,
  sample: path.join(web, 'samples', 'Spring market.kposter'),
  ready: '[data-testid="poster-canvas"] canvas',
  shots: [
    { name: 'hero', viewport: { width: 1440, height: 1100 } },
    { name: 'layers', steps: (page, { kit }) => kit.getByTestId('ribbon-tab-Layers').click() },
  ],
})
```

Run it from `web/` after building the engine:

```sh
pnpm install && pnpm engine            # the engine (and fonts) in public/
node scripts/readme-shots.mjs          # every shot
node scripts/readme-shots.mjs layers   # only the named ones
```

It needs a kition-sdk checkout next to the kit repository, or `KITION_SDK` naming one. Set `CHROME`
to a Chrome or Chromium executable to use it instead of Playwright's browser. Run it with no HTTP
proxy set: the browser talks to a local server.

## What `takeShots` takes

| Option | What it is |
| --- | --- |
| `web` | The kit's `web/` directory |
| `sample` | The file every shot opens (a path), or `async (page, shot) => …` that opens one; `openFile(page, { name, bytes, options })` opens bytes through `window.devHost.open` and waits for the host's status line |
| `shots` | `{ name, steps?, clip?, viewport?, screenshot? }` each. `steps(page, { kit, frame, context, out, shot })` runs once the editor is ready (`kit` is a frame locator for the kit's frame, `frame` the frame); it may answer the names of other files it wrote into `out`, which are reported too. `clip` (`{ x, y, width, height }`, CSS pixels of the page) takes that region instead of the kit's frame. `screenshot: false` takes no picture: the steps write theirs |
| `viewport` | The default view, `{ width: 1440, height: 900 }`; a shot's `viewport` replaces it |
| `ready` | A selector in the kit's frame that exists once the editor has drawn (`[data-testid="note-canvas"] canvas`), or `async (page, { kit, frame }) => …` |
| `query` | More parameters of `dev.html` (`{ files: '1' }`); `locale=en-US` is always there unless given |
| `storage` | `localStorage` entries set before the page's scripts run (`{ 'kit.note.autosave': 'off' }`) |
| `context` | More Playwright browser context options (`{ timezoneId: 'UTC' }`) |
| `settle` | Milliseconds to wait after the editor is ready (`open`, 2500) and before each picture (`shot`, 800) |
| `target` | The element pictured, by default the kit's frame (`#kit`) without the host's header |
| `names` | The shots to take; by default the command line's arguments, and every shot when there are none. An unknown name is an error that lists the shots |
| `out` | Where the pictures go; by default `assets/readme/` beside `web/` |

Each shot gets a fresh browser context at device scale 2. When every shot has run, `takeShots` prints
each file's size and flags any over 400 KB; if a shot failed, it then throws with the list of the
shots that failed and why (the other shots are still taken).

## The pictures

`node tools/sync-community.mjs <kit> --check` checks the hero, the count, the alts and the sizes.

| Item | Rule |
| --- | --- |
| Where | `assets/readme/`, and only pictures the README uses |
| File names | `hero.png`; `see-1.png` … `see-4.png`, or named by feature (`comments.png`); `made-1.png` … `made-4.png` |
| How many | At least 3 from `assets/readme/`; a full README has 9 (the hero, 4 under "See it", 4 under "Made with") |
| Source | Editor pictures come from `web/scripts/readme-shots.mjs`, so they can be taken again; a "Made with" picture is the `thumb.png` of that sample in kition-showcase |
| The editor | Classic display mode, light theme, English, 1440 × 900, device pixel ratio 2 |
| Sample content | Invented but believable working files (a launch plan, a quarterly report, a poster); invented people and companies; no real people, real brands, local paths or user names |
| Size | Each at most 400 KB, all of `assets/readme/` at most 3 MB; shrink a larger one with `pngquant --quality 70-90` |
| Markup | `<img src="assets/readme/hero.png" alt="…" width="100%" />`; pictures side by side go in a `<table>`, each cell `width="50%"` |
| alt | One full English sentence, at least 20 characters, saying what the picture shows ("The Layers panel with a group, two adjustment layers and a masked photo."); never "screenshot" |
| Not | GIFs and videos (large, and they cannot be taken again); device frames; promotional pictures with headline text |

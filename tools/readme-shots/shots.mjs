// Takes a kit's README pictures (assets/readme/<name>.png at the kit repository's root): the
// kit's Vite development host (web/dev.html) with a sample document open, one browser context per
// shot, at device scale 2. A kit's web/scripts/readme-shots.mjs calls takeShots(); README.md here
// says how, and the rules the pictures follow.
//
// Playwright and Vite are not kition-sdk's: they are resolved from the kit's web/ (its
// node_modules), so the kit's own versions run, and kition-sdk needs nothing installed for it.
//
//   cd web && pnpm install && pnpm engine          # the engine (and fonts) in public/
//   node scripts/readme-shots.mjs [name ...]       # every shot, or only the named ones
//
// Set CHROME to a Chrome or Chromium executable to use it instead of Playwright's own browser.
// Run it with no HTTP proxy set (the browser reaches a local server).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAX_PICTURE_BYTES } from '../sync-community.mjs'

/** The view every picture is taken at (the README standard: 1440 × 900, device scale 2). */
export const VIEWPORT = Object.freeze({ width: 1440, height: 900 })
export const DEVICE_SCALE = 2
export { MAX_PICTURE_BYTES }

/** A shot's name is its file's name: lower case letters, digits and dashes. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * The shots to take: every one, or the ones `names` lists (the command line), in the shots' order.
 * Throws on a malformed or repeated shot name, and on a name no shot has.
 */
export function selectShots(shots, names = []) {
  const known = []
  for (const shot of shots) {
    if (typeof shot?.name !== 'string' || !NAME.test(shot.name)) throw new Error(`a shot's name is lower case letters, digits and dashes (it names the file): ${JSON.stringify(shot?.name)}`)
    if (known.includes(shot.name)) throw new Error(`two shots are named ${shot.name}`)
    known.push(shot.name)
  }
  const unknown = names.filter((name) => !known.includes(name))
  if (unknown.length > 0) throw new Error(`no shot named ${unknown.join(', ')}; the shots are ${known.join(', ')}`)
  return names.length === 0 ? [...shots] : shots.filter((shot) => names.includes(shot.name))
}

/** A size as the report writes it: whole kilobytes, rounded up (1 byte is 1 KB). */
export const kilobytes = (bytes) => `${Math.ceil(bytes / 1024)} KB`

/** Each file's size, and whether it is over `limit` bytes. `files` are { file, bytes }. */
export function sizeReport(files, limit = MAX_PICTURE_BYTES) {
  return files.map(({ file, bytes }) => ({ file, bytes, over: bytes > limit }))
}

/** The report's lines: one per file, an over-limit file flagged, then a summary when any is over. */
export function sizeLines(report, limit = MAX_PICTURE_BYTES) {
  const width = Math.max(0, ...report.map(({ file }) => file.length))
  const lines = report.map(({ file, bytes, over }) => `${file.padEnd(width)}  ${kilobytes(bytes).padStart(7)}${over ? `  OVER ${kilobytes(limit)}` : ''}`)
  const over = report.filter((entry) => entry.over).length
  if (over > 0) lines.push(`${over} picture${over === 1 ? ' is' : 's are'} over ${kilobytes(limit)}; shrink with pngquant --quality 70-90 (a README picture is at most ${kilobytes(limit)})`)
  return lines
}

/**
 * The ES module entry of package `name` as the project at `dir` (a folder with a package.json)
 * has it installed: its exports' "import" (or "node", "default") target for ".", else its module
 * or main field. Only the node_modules folders of `dir` and its parents are searched, not NODE_PATH
 * (a pnpm bin sets it to its own store, which would hand over kition-sdk's packages). Throws when
 * the package is not installed there.
 */
export function moduleEntry(dir, name) {
  let manifest = null
  for (let at = path.resolve(dir); manifest === null; at = path.dirname(at)) {
    const candidate = path.join(at, 'node_modules', ...name.split('/'), 'package.json')
    if (fs.existsSync(candidate)) manifest = candidate
    else if (path.dirname(at) === at) throw new Error(`${name} is not installed in ${dir}: run pnpm install there`)
  }
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  const pick = (target) => {
    if (typeof target === 'string') return target
    if (Array.isArray(target)) return target.map(pick).find(Boolean) ?? null
    if (target && typeof target === 'object') {
      for (const [condition, value] of Object.entries(target)) {
        if (['import', 'node', 'default'].includes(condition)) {
          const found = pick(value)
          if (found) return found
        }
      }
    }
    return null
  }
  const exports = pkg.exports
  const dot = typeof exports === 'string' || Array.isArray(exports) ? exports : exports && Object.keys(exports).some((key) => key.startsWith('.')) ? exports['.'] : exports
  const entry = pick(dot) ?? pkg.module ?? pkg.main ?? 'index.js'
  return path.join(path.dirname(manifest), entry)
}

/** Imports package `name` as the project at `dir` has it installed. */
export const importFrom = async (dir, name) => import(pathToFileURL(moduleEntry(dir, name)).href)

/** The development host's page, with `query` (locale en-US unless it says otherwise). */
export const hostUrl = (origin, host, query = {}) => `${origin}/${host}?${new URLSearchParams({ locale: 'en-US', ...query })}`

/** The status line the development host (#status) shows: "<file> open in <time>". */
const statusIncludes = (page, text, timeout) =>
  page.waitForFunction((part) => document.getElementById('status')?.textContent?.includes(part) ?? false, text, { timeout })

/**
 * Opens `bytes` as the file `name` in the development host (window.devHost.open) and waits until
 * the host says it is open. `options` is devHost.open's third argument (for example a kit's
 * `{ view }`).
 */
export async function openFile(page, { name, bytes, options, timeout = 90_000 }) {
  await page.evaluate(
    async ({ name, data, options }) => {
      const binary = atob(data)
      const buffer = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) buffer[index] = binary.charCodeAt(index)
      await window.devHost.open(name, buffer.buffer, ...(options === undefined ? [] : [options]))
    },
    { name, data: Buffer.from(bytes).toString('base64'), options },
  )
  await statusIncludes(page, `${name} open in `, timeout)
}

/** The first Vite config file in `web`, or false (no config file). */
function viteConfig(web) {
  return ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].map((file) => path.join(web, file)).find((file) => fs.existsSync(file)) ?? false
}

/**
 * Takes the shots and writes assets/readme/<name>.png for each; prints each file's size, flags any
 * over 400 KB, and throws with the list of shots that failed (after trying every one).
 *
 *   web      the kit's web/ directory
 *   sample   the file every shot opens (a path), or async (page, shot) => … that opens one
 *            (openFile helps)
 *   shots    [{ name, steps?: async (page, { kit, frame, context, out, shot }) => …, clip?, viewport?,
 *            screenshot? }]: steps run once the editor is ready, and may answer the names of
 *            other files they wrote into out, which are reported too; clip is a region of the page
 *            (CSS pixels) to take instead of the kit's frame; screenshot false takes no picture
 *            (the steps write theirs)
 *   viewport the default view, 1440 × 900
 *
 * Where kits' development hosts differ:
 *   ready    a selector in the kit's frame that is there once the editor has drawn (or
 *            async (page, { kit, frame }) => …); none: only the host's status line is awaited
 *   query    more parameters of dev.html (locale en-US always, unless given)
 *   storage  localStorage entries set before the page's scripts run ({ 'kit.note.autosave': 'off' })
 *   context  more browser context options ({ timezoneId: 'UTC' })
 *   settle   milliseconds to wait: after the editor is ready (open, 2500) and before a picture (shot, 800)
 *   target   the element taken (the kit's frame, '#kit')
 *   host     the development host's page (dev.html)
 *   names    the shots to take (default: the command line's arguments; none: every shot)
 *   out      where the pictures go (default: assets/readme/ beside web/)
 */
export async function takeShots({
  web,
  sample,
  shots,
  viewport = VIEWPORT,
  ready = null,
  query = {},
  storage = {},
  context: contextOptions = {},
  settle = {},
  target = '#kit',
  host = 'dev.html',
  names = process.argv.slice(2),
  out,
  timeout = 90_000,
}) {
  if (!web || !fs.existsSync(path.join(web, 'package.json'))) throw new Error(`takeShots: web must be the kit's web/ directory (a folder with a package.json): ${web}`)
  if (typeof sample !== 'function' && (typeof sample !== 'string' || !fs.existsSync(sample))) throw new Error(`takeShots: sample must be a file or a function that opens one: ${sample}`)
  const wanted = selectShots(shots, names)
  const wait = { open: 2500, shot: 800, ...settle }
  const dir = out ?? path.resolve(web, '..', 'assets', 'readme')
  fs.mkdirSync(dir, { recursive: true })
  const opened = typeof sample === 'function' ? null : { name: path.basename(sample), bytes: fs.readFileSync(sample) }

  const { createServer } = await importFrom(web, 'vite')
  const { chromium } = await importFrom(web, 'playwright')
  const server = await createServer({ root: web, configFile: viteConfig(web), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' })
  const written = []
  const failed = []
  let browser = null
  try {
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {})
    for (const shot of wanted) {
      const context = await browser.newContext({ viewport: shot.viewport ?? viewport, deviceScaleFactor: DEVICE_SCALE, ...contextOptions })
      try {
        if (Object.keys(storage).length > 0) {
          await context.addInitScript((entries) => {
            for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
          }, storage)
        }
        const page = await context.newPage()
        page.on('pageerror', (error) => console.log(`${shot.name}: page error: ${error.message}`))
        await page.goto(hostUrl(origin, host, query))
        // The host opens its own first file; the sample replaces it.
        await statusIncludes(page, ' open in ', timeout)
        if (opened) await openFile(page, { ...opened, timeout })
        else await sample(page, shot)
        const kit = page.frameLocator(target)
        const frame = await (await page.locator(target).elementHandle())?.contentFrame() ?? null
        if (typeof ready === 'function') await ready(page, { kit, frame })
        else if (ready) await kit.locator(ready).first().waitFor({ timeout })
        await page.waitForTimeout(wait.open)
        const extra = (await shot.steps?.(page, { kit, frame, context, out: dir, shot })) ?? []
        if (shot.screenshot !== false) {
          await page.waitForTimeout(wait.shot)
          const file = path.join(dir, `${shot.name}.png`)
          if (shot.clip) await page.screenshot({ path: file, clip: shot.clip })
          else await page.locator(target).screenshot({ path: file })
          written.push(`${shot.name}.png`)
        }
        for (const file of Array.isArray(extra) ? extra : []) written.push(file)
        console.log(`took ${shot.name}`)
      } catch (error) {
        failed.push({ name: shot.name, error: String(error?.message ?? error).split('\n')[0] })
        console.log(`failed ${shot.name}: ${failed.at(-1).error}`)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser?.close()
    await server.close()
  }

  const files = written
    .map((file) => path.join(dir, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file: path.relative(path.resolve(web, '..'), file).split(path.sep).join('/'), bytes: fs.statSync(file).size }))
  const report = sizeReport(files)
  for (const line of sizeLines(report)) console.log(line)
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${wanted.length} shots failed:\n${failed.map(({ name, error }) => `  ${name}: ${error}`).join('\n')}`)
  }
  return report
}

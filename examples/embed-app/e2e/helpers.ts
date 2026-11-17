/**
 * Helpers for the embed example's end-to-end tests: the kit engines (to make fixtures and read
 * saved files in Node), a Kition Server per test, a sync connection a test can cut, and
 * the example page's controls and test hook (`window.__EMBED_TEST__`).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, type BrowserContext, type FrameLocator, type Locator, type Page, type WebSocketRoute } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdkRoot = path.resolve(here, '..', '..', '..')
export const kitsDir = path.resolve(sdkRoot, process.env.KITION_KITS_DIR || path.join('..', 'kition', 'public', 'kits'))
const serverRepo = path.resolve(sdkRoot, process.env.KITION_SERVER_REPO || path.join('..', 'kition-server'))
const cache = process.env.EMBED_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-embed-e2e')

/** The kit's engine (`<kit>-ui/engine/<module>.js`), as the page's worker runs it, loaded in Node. */
export function kitEngine<T>(kit: string, module: string) {
  const dir = path.join(kitsDir, `${kit}-ui`, 'engine')
  const wasm = path.join(dir, `${module}_bg.wasm`)
  let loaded: Promise<T> | null = null
  return {
    built: existsSync(wasm),
    load: () =>
      (loaded ??= (async () => {
        const sdk = (await import(pathToFileURL(path.join(dir, `${module}.js`)).href)) as { default: (input: { module_or_path: Buffer }) => Promise<unknown> } & T
        await sdk.default({ module_or_path: await fs.readFile(wasm) })
        return sdk
      })()),
  }
}

// Loro (a dependency of @kition/sync) reads replica versions as each author's change count.
const { VersionVector } = createRequire(path.join(sdkRoot, 'packages', 'sync', 'package.json'))('loro-crdt') as {
  VersionVector: { decode: (bytes: Uint8Array) => { toJSON: () => Map<string, number> } }
}

/** A replica version (lowercase hex) as each author's change count, in a stable order. */
export function versionCounters(hex: string): Record<string, number> {
  return hex ? Object.fromEntries([...VersionVector.decode(Buffer.from(hex, 'hex')).toJSON().entries()].sort()) : {}
}

// --- Kition Server ------------------------------------------------------------------------------

function cargo() {
  for (const candidate of ['cargo', path.join(os.homedir(), '.cargo', 'bin', 'cargo')]) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next one.
    }
  }
  return null
}

/**
 * Why the test skips here, or `null` when it runs. kition-server is a private tool (not open
 * source; docs/quality.md, Private tools): without its checkout the test is skipped, and this prints
 * `SKIP: <reason>`. A missing Rust toolchain is not a skip: starting the server fails.
 */
export function kitionServerSkipReason() {
  if (existsSync(path.join(serverRepo, 'Cargo.toml'))) return null
  const reason = `the private kition-server is missing: no checkout at ${serverRepo} (set KITION_SERVER_REPO)`
  console.log(`SKIP: ${reason}`)
  return reason
}

let built: string | null = null

function buildKitionServer() {
  if (built) return built
  const bin = cargo()
  if (!bin) throw new Error('no Rust toolchain (cargo) to build kition-server')
  execFileSync(bin, ['build', '-p', 'kition-server'], { cwd: serverRepo, stdio: 'inherit', timeout: 1_200_000 })
  built = path.join(process.env.CARGO_TARGET_DIR || path.join(serverRepo, 'target'), 'debug', 'kition-server')
  return built
}

const SERVER_CONFIG = `listen = "127.0.0.1:0"
public_url = "http://kition-server.test"

[auth]
mode = "dev"

[[auth.users]]
token = "dev-alice"
id = "dev:alice"
name = "Alice"
pro = true

[[auth.users]]
token = "dev-bob"
id = "dev:bob"
name = "Bob"
pro = true

[storage]
mode = "memory"
`

export type KitionServer = { url: string; stop: () => Promise<void> }

/** A fresh in-memory kition-server with the development tokens, on a free port. */
export async function startKitionServer(name: string): Promise<KitionServer> {
  const executable = buildKitionServer()
  const dir = path.join(cache, 'kition-server', `${name}-${process.pid}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  const config = path.join(dir, 'kition-server.toml')
  await fs.writeFile(config, SERVER_CONFIG)
  const child: ChildProcess = spawn(executable, ['--config', config, '--memory'], { cwd: serverRepo, env: { ...process.env, RUST_LOG: 'info', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`kition-server did not start:\n${output}`)), 30_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.replace(/\u001b\[[0-9;]*m/g, '').match(/addr=127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`kition-server exited (${code}):\n${output}`))
    })
  })
  return {
    url: `ws://127.0.0.1:${port}/v1/sync`,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * The context's connection to the sync server, through Playwright so a test can cut it: offline,
 * open sync sockets close and new ones are refused, as on a network that went away.
 */
export async function syncNetwork(context: BrowserContext) {
  let online = true
  const open = new Set<{ page: WebSocketRoute; server: WebSocketRoute }>()
  await context.routeWebSocket(/\/v1\/sync$/, async (page) => {
    if (!online) {
      await page.close({ code: 1001, reason: 'offline' })
      return
    }
    const socket = { page, server: page.connectToServer() }
    open.add(socket)
    page.onClose(() => open.delete(socket))
  })
  return {
    setOnline: async (value: boolean) => {
      online = value
      if (value) return
      for (const socket of [...open]) {
        await socket.server.close().catch(() => undefined)
        await socket.page.close({ code: 1001, reason: 'offline' }).catch(() => undefined)
      }
      open.clear()
    },
  }
}

// --- The example page ---------------------------------------------------------------------------

export type Hook = {
  files: () => Array<{ id: string; name: string; version: number; saves: number; size: number }>
  bytes: (name: string) => string | null
  saves: (name: string) => number
  replicaVersion: (name: string) => Promise<string>
  runReview: (name: string) => Promise<{ heading: string; level: number; task: { text: string; checked: boolean }; text: string }>
  readNote: (name: string) => Promise<string>
  collab: (name: string) => { status: string; docId: string | null; role: string | null } | null
  save: (name: string) => Promise<{ saved: boolean; version: string | null } | undefined>
  tokenCalls: () => number
  comments: (name: string) => string[]
  run: (name: string, command: string, params: Record<string, unknown>) => Promise<{ command: string; changed: boolean; result: unknown } | undefined>
  mode: (name: string) => 'edit' | 'comment' | 'view' | null
  check: (name: string) => Promise<Array<{ code: string; severity: string }> | null>
  usersAsked: () => string[]
  errors: () => string[]
}

declare global {
  interface Window {
    __EMBED_TEST__: unknown
  }
}

export type AppOptions = { user?: 'alice' | 'bob'; server?: string; mode?: 'edit' | 'comment' | 'view' }

/** The example page as `user`, co-editing through `server` when given. */
export async function openApp(page: Page, { user = 'alice', server, mode = 'edit' }: AppOptions = {}) {
  const params = new URLSearchParams({ user, mode, collab: server ? '1' : '0', ...(server ? { server } : {}) })
  await page.goto(`/?${params}`)
  await expect(page.getByTestId('files')).toBeAttached()
  await page.waitForFunction(() => Boolean(window.__EMBED_TEST__))
}

/** Puts a file into the page's storage through its upload control. */
export async function upload(page: Page, name: string, bytes: Buffer) {
  await page.getByTestId('upload').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
  await expect(page.locator(`[data-file="${name}"]`)).toBeVisible()
}

export type OpenEditor = { pane: Locator; kit: FrameLocator }

export function editorFor(page: Page, name: string): OpenEditor {
  const pane = page.locator(`[data-pane="${name}"]`)
  return { pane, kit: pane.frameLocator('iframe') }
}

/** Opens `name` from the file list; answers its pane and the kit's frame once the kit showed it. */
export async function openFile(page: Page, name: string): Promise<OpenEditor> {
  await page.locator(`[data-file="${name}"]`).getByTestId('file-open').click()
  const editor = editorFor(page, name)
  await expect(editor.pane).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  return editor
}

export async function closeFile(page: Page, name: string) {
  await editorFor(page, name).pane.getByTestId('pane-close').click()
  await expect(editorFor(page, name).pane).toHaveCount(0)
}

/** The page's replica version of `name` as counters. */
export async function replicaCounters(page: Page, name: string) {
  return versionCounters(await page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).replicaVersion(wanted), name).catch(() => ''))
}

/** The replica version of `name` once it stops changing (typing streams one change per key). */
export async function settledVersion(page: Page, name: string) {
  let previous = null as string | null
  await expect
    .poll(
      async () => {
        const next = JSON.stringify(await replicaCounters(page, name))
        const stable = next === previous
        previous = next
        return stable
      },
      { timeout: 10_000, intervals: [50] },
    )
    .toBe(true)
  return previous ?? ''
}

/** 'same' once both pages hold the same changes of `name`, else both versions. */
export async function sameReplica(pageA: Page, pageB: Page, name: string) {
  const [a, b] = await Promise.all([replicaCounters(pageA, name), replicaCounters(pageB, name)])
  return JSON.stringify(a) === JSON.stringify(b) ? 'same' : `${JSON.stringify(a)} / ${JSON.stringify(b)}`
}

/**
 * Waits until `name` in `pageA` leaves `baseline` and settles, then until `pageB` holds the same;
 * answers the time from `start` to then.
 */
export async function liveTo(pageA: Page, pageB: Page, name: string, baseline: string, start: number) {
  await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, name)), { intervals: [10] }).not.toBe(baseline)
  const version = await settledVersion(pageA, name)
  await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, name)), { timeout: 5_000, intervals: [20] }).toBe(version)
  return Date.now() - start
}

/** A file's bytes in the page's storage. */
export async function fileBytes(page: Page, name: string) {
  const base64 = await page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).bytes(wanted), name)
  if (!base64) throw new Error(`no file ${name}`)
  return Buffer.from(base64, 'base64')
}

export const saves = (page: Page, name: string) => page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).saves(wanted), name)
export const errors = (page: Page) => page.evaluate(() => (window.__EMBED_TEST__ as Hook).errors())
export const tokenCalls = (page: Page) => page.evaluate(() => (window.__EMBED_TEST__ as Hook).tokenCalls())
export const collabState = (page: Page, name: string) => page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).collab(wanted), name)

/** The pane's collaboration status (`off`, `connecting`, `online`, `offline`). */
export const collabStatus = (editor: OpenEditor) => editor.pane.getByTestId('pane-status')

/** Shares the document open in `editor` and answers the page's link to it. */
export async function shareLink(editor: OpenEditor) {
  await editor.pane.getByTestId('share-create').click()
  const field = editor.pane.getByTestId('share-link')
  await expect(field).not.toHaveValue('', { timeout: 30_000 })
  return field.inputValue()
}

/** Joins a document from a link in the page's join field; answers its editor once shown. */
export async function join(page: Page, link: string, name: string) {
  await page.getByTestId('join-link').fill(link)
  await page.getByTestId('join-submit').click()
  const editor = editorFor(page, name)
  await expect(editor.pane).toHaveAttribute('data-ready', 'true', { timeout: 60_000 })
  return editor
}

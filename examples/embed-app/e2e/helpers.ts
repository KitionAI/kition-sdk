/**
 * Helpers for the embed example's end-to-end tests: the kit engines (to make fixtures and read
 * saved files in Node), and the example page's controls and test hook (`window.__EMBED_TEST__`).
 */
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const sdkRoot = path.resolve(here, '..', '..', '..')
export const kitsDir = path.resolve(sdkRoot, process.env.KITION_KITS_DIR || path.join('..', 'kition', 'public', 'kits'))

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

// --- The example page ---------------------------------------------------------------------------

export type Hook = {
  files: () => Array<{ id: string; name: string; version: number; saves: number; size: number }>
  bytes: (name: string) => string | null
  saves: (name: string) => number
  replicaVersion: (name: string) => Promise<string>
  runReview: (name: string) => Promise<{ heading: string; level: number; task: { text: string; checked: boolean }; text: string }>
  readNote: (name: string) => Promise<string>
  save: (name: string) => Promise<{ saved: boolean; version: string | null } | undefined>
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

export type AppOptions = { user?: 'alice' | 'bob'; mode?: 'edit' | 'comment' | 'view' }

/** The example page as `user`. */
export async function openApp(page: Page, { user = 'alice', mode = 'edit' }: AppOptions = {}) {
  const params = new URLSearchParams({ user, mode })
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

/** A file's bytes in the page's storage. */
export async function fileBytes(page: Page, name: string) {
  const base64 = await page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).bytes(wanted), name)
  if (!base64) throw new Error(`no file ${name}`)
  return Buffer.from(base64, 'base64')
}

export const saves = (page: Page, name: string) => page.evaluate((wanted) => (window.__EMBED_TEST__ as Hook).saves(wanted), name)
export const errors = (page: Page) => page.evaluate(() => (window.__EMBED_TEST__ as Hook).errors())

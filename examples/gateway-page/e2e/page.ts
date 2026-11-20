/** What the page's end-to-end tests share about the page itself. */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { cache, installKits, repo, scratch } from './helpers'

export const shots = path.join(cache, 'shots')

/** A Table document: the Table repository's sample (its first view a grid of records). */
export const tableSample = () => path.join(repo, '../kition-table/web/dist/sample/Sample.ktable')
export const noteSample = () => fs.readFileSync(path.join(repo, '../kition-note/web/dist/sample/Sample.md'))

/**
 * Console errors and failed requests of `page`. A stamp of a file that is not there (`HEAD
 * /kit-files/<path>` answering 404: a kit asking after a file its document links to, which the
 * workspace lacks) is an answer, not a failure.
 */
export function watch(page: Page) {
  const problems: string[] = []
  const missing = (url: string, status: number | string) => url.includes('/kit-files/') && String(status).includes('404')
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' && !missing(message.location().url, message.text())) problems.push(`console: ${message.text()} (${message.location().url})`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !(response.request().method() === 'HEAD' && missing(response.url(), response.status()))) problems.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`)
  })
  return problems
}

export async function opened(page: Page) {
  await page.waitForFunction(() => (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status === 'open', null, { timeout: 120_000 })
}

/**
 * The open Note editor's document as its engine holds it now (unsaved edits included): the note
 * exported as HTML by the editor's own engine (`file.export`, which changes nothing).
 */
export async function inspected(page: Page) {
  return page.evaluate(async () => {
    type Run = (steps: unknown[], save: boolean) => Promise<{ completed: Array<{ result: { data?: string } }> }>
    const state = (window as unknown as { kitionGatewayPage: { state: { connection: { ai: { run: Run } } } } }).kitionGatewayPage.state
    const ran = await state.connection.ai.run([{ command: 'file.export', params: { format: 'html' } }], false)
    const data = ran.completed[0]?.result?.data ?? ''
    return new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)))
  })
}

export const kitFrame = (page: Page) => page.frames().find((frame) => frame.url().includes('/kits-ui/'))!

export async function setup(name: string, kits = ['table', 'note']) {
  const dirs = scratch(name)
  installKits(dirs.home, kits)
  return dirs
}

/** The proxy's address of the page of `file`. */
export const proxied = (proxy: string, file: string, view = '') => `${proxy}page/${view}?path=${encodeURIComponent(file)}`


/**
 * Every kit's editor in the gateway's page (`pnpm test:gateway:smoke`): for each of the kits the
 * SDK publishes, a sample document in a workspace whose Kition home has no kit installed; the page
 * installs the kit's editor package on first use (the kit index's release asset, its download
 * followed), mounts it, and is opened again warm. It records per kit the version, the first and
 * the warm opening time, and the console errors, in GATEWAY_E2E_CACHE/smoke.json, and prints the
 * table. Table and Note must open; the others are reported as they are. Each editor downloaded is
 * kept at once, so a first run cut short by the ten-minute limit of a test step goes on where it
 * stopped the next time; `GATEWAY_SMOKE_KITS=table,note` limits the kits.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cache, repo, scratch, startGateway, startProxy } from './helpers'

const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'sdk.json'), 'utf8')) as { kits: string[] }
const kits = process.env.GATEWAY_SMOKE_KITS ? process.env.GATEWAY_SMOKE_KITS.split(',') : sdk.kits
const sibling = (...parts: string[]) => path.join(repo, '..', ...parts)

/** The sample document of each kit: workspace path, and the files to put there. */
function sample(kit: string): { file: string; copies: Array<[string, string]> } | null {
  const dist = (name: string) => sibling(`kition-${kit}`, 'web/dist/sample', name)
  const one = (name: string, source = dist(name)) => (fs.existsSync(source) ? { file: name, copies: [[source, name]] as Array<[string, string]> } : null)
  switch (kit) {
    case 'design':
      return one('Empty.kdesign', sibling('kition-design', 'conformance/check-empty-component.kdesign'))
    case 'film':
      return fs.existsSync(dist('films/Sample.kfilm'))
        ? { file: 'films/Sample.kfilm', copies: [[dist('films/Sample.kfilm'), 'films/Sample.kfilm'], [dist('clips/bars.mp4'), 'clips/bars.mp4']] }
        : null
    case 'html':
      return { file: 'Sample.html', copies: [] }
    case 'note':
      return one('Sample.md')
    case 'table':
      return one('Sample.ktable')
    default: {
      const found = fs.existsSync(path.dirname(dist('x'))) ? fs.readdirSync(path.dirname(dist('x'))).find((name) => name.startsWith('Sample.')) : undefined
      return found ? one(found) : null
    }
  }
}

type Row = { kit: string; version: string | null; file: string | null; status: string; firstMs: number | null; warmMs: number | null; errors: string[] }

async function openAndWait(page: Page, address: string) {
  const errors: string[] = []
  const missing = (url: string, text: string) => url.includes('/kit-files/') && text.includes('404')
  const onConsole = (message: { type: () => string; text: () => string; location: () => { url: string } }) => {
    if (message.type() === 'error' && !missing(message.location().url, message.text())) errors.push(message.text().slice(0, 200))
  }
  const onError = (error: Error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`)
  page.on('console', onConsole)
  page.on('pageerror', onError)
  const started = Date.now()
  await page.goto(address)
  const status = await page
    .waitForFunction(() => {
      const state = (window as unknown as { kitionGatewayPage?: { state: { status: string } } }).kitionGatewayPage?.state.status
      return state && !['opening', 'downloading'].includes(state) ? state : null
    }, null, { timeout: 280_000, polling: 100 })
    .then((handle) => handle.jsonValue() as Promise<string>)
    .catch(() => 'timeout')
  const ms = Date.now() - started
  // Errors the editor logs just after it opened count too.
  await page.waitForTimeout(1500)
  page.off('console', onConsole)
  page.off('pageerror', onError)
  return { status, ms, errors }
}

test('every kit’s editor opens in the gateway page', async ({ page }) => {
  test.setTimeout(570_000)
  const { home, workspace } = scratch('smoke')
  // Editor packages kept from an earlier run are put back; the first run downloads them all.
  const kept = path.join(cache, 'smoke-home')
  fs.mkdirSync(path.join(kept, 'kits'), { recursive: true })
  fs.cpSync(path.join(kept, 'kits'), path.join(home, 'kits'), { recursive: true })
  const rows: Row[] = []
  for (const kit of kits) {
    const found = sample(kit)
    for (const [source, target] of found?.copies ?? []) {
      fs.mkdirSync(path.dirname(path.join(workspace, target)), { recursive: true })
      fs.copyFileSync(source, path.join(workspace, target))
    }
    if (kit === 'html') fs.writeFileSync(path.join(workspace, 'Sample.html'), '<!doctype html><html><head><title>Sample</title></head><body><h1>Sample page</h1><p>Edited in Kition.</p></body></html>\n')
  }
  const gateway = await startGateway(home, workspace)
  const proxy = await startProxy(gateway.url, gateway.token)
  try {
    for (const kit of kits) {
      const found = sample(kit)
      if (!found) {
        rows.push({ kit, version: null, file: null, status: 'no sample', firstMs: null, warmMs: null, errors: [] })
        continue
      }
      const address = `${proxy.url}page/?path=${encodeURIComponent(found.file)}`
      const first = await openAndWait(page, address)
      const warm = first.status === 'open' ? await openAndWait(page, address) : null
      const editors = (await (await fetch(`${proxy.url}api/v1/kits/editors`)).json()) as { data: { editors: Record<string, { version: string | null }> } }
      await page.screenshot({ path: path.join(cache, 'shots', `smoke-${kit}.png`) })
      if (fs.existsSync(path.join(home, 'kits', kit))) fs.cpSync(path.join(home, 'kits', kit), path.join(kept, 'kits', kit), { recursive: true })
      rows.push({ kit, version: editors.data.editors[`kit.${kit}`]?.version ?? null, file: found.file, status: first.status, firstMs: first.ms, warmMs: warm?.ms ?? null, errors: [...first.errors, ...(warm?.errors ?? [])] })
    }
  } finally {
    proxy.stop()
    await gateway.stop()
  }
  fs.writeFileSync(path.join(cache, 'smoke.json'), `${JSON.stringify(rows, null, 2)}\n`)
  console.log('| kit | version | sample | status | first open ms | warm open ms | console errors |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) console.log(`| ${row.kit} | ${row.version ?? '-'} | ${row.file ?? '-'} | ${row.status} | ${row.firstMs ?? '-'} | ${row.warmMs ?? '-'} | ${row.errors.length ? `${row.errors.length}: ${row.errors[0].replace(/\|/g, '/')}` : '0'} |`)
  for (const kit of ['table', 'note'].filter((kit) => kits.includes(kit))) expect(rows.find((row) => row.kit === kit)?.status, kit).toBe('open')
})

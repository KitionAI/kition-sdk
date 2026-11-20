// The kition-kits DeepSeek Harness plugin's host module (plugins/deepseek-harness/kition-kits/lib):
// where it finds kition, its gateways (one per workspace, reused, started again, stopped with the
// host), and the proxy in front of them (DeepSeek Harness's own login first, a workspace the host
// knows, the token added, the browser's credentials dropped, streams, ranges and bodies as they
// are). A stand-in gateway (test/fake-kition.mjs) answers; the real one is in the plugin's e2e.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { findKition, kitOptions, wellKnownKition } from '../plugins/deepseek-harness/kition-kits/lib/kition.mjs'
import { GatewayError, Gateways, workspaceKey } from '../plugins/deepseek-harness/kition-kits/lib/gateways.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const plugin = path.join(root, 'plugins/deepseek-harness/kition-kits')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kits-host-')))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

/** A folder holding an executable `kition` that is the stand-in gateway. */
function fakeBin(name = 'bin') {
  const bin = path.join(scratch, name)
  fs.mkdirSync(bin, { recursive: true })
  const file = path.join(bin, 'kition')
  fs.writeFileSync(file, `#!${process.execPath}\nimport(${JSON.stringify(path.join(plugin, 'test/fake-kition.mjs'))})\n`, { mode: 0o755 })
  return file
}

/** A fresh workspace folder and Kition home. */
function fresh(name) {
  const base = path.join(scratch, `${name}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(path.join(base, 'workspace'), { recursive: true })
  fs.mkdirSync(path.join(base, 'home'), { recursive: true })
  return { workspace: path.join(base, 'workspace'), home: path.join(base, 'kition-home'), fakeHome: path.join(base, 'home'), log: path.join(base, 'starts.log') }
}

const get = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })

describe('finding kition', () => {
  const kition = fakeBin('find')
  const empty = path.join(scratch, 'empty-home')
  fs.mkdirSync(empty, { recursive: true })

  it('takes KITION_BIN first, then a kition KITION_KITS_MCP, then the PATH', () => {
    expect(findKition({ KITION_BIN: kition, PATH: '', HOME: empty })).toEqual({ file: kition })
    expect(findKition({ KITION_KITS_MCP: kition, PATH: '', HOME: empty })).toEqual({ file: kition })
    expect(findKition({ PATH: path.dirname(kition), HOME: empty })).toEqual({ file: kition })
    expect(findKition({ KITION_BIN: path.join(scratch, 'nothing'), PATH: path.dirname(kition), HOME: empty }).error).toContain('KITION_BIN is')
  })

  it('looks in the places kition installs to when the PATH lacks it (DeepSeek Harness Desktop)', () => {
    const home = path.join(scratch, 'installed-home')
    fs.mkdirSync(path.join(home, '.kition/bin'), { recursive: true })
    fs.copyFileSync(kition, path.join(home, '.kition/bin/kition'))
    fs.chmodSync(path.join(home, '.kition/bin/kition'), 0o755)
    expect(wellKnownKition({ HOME: home }).slice(0, 2)).toEqual([path.join(home, '.kition/bin/kition'), path.join(home, '.cargo/bin/kition')])
    expect(findKition({ PATH: '/usr/bin:/bin', HOME: home })).toEqual({ file: path.join(home, '.kition/bin/kition') })
  })

  it('says so when there is none', () => {
    const found = findKition({ PATH: path.join(scratch, 'empty'), HOME: empty })
    // A machine may have kition in a system folder; then it is found there.
    if (!found.missing) expect(['/usr/local/bin/kition', '/opt/homebrew/bin/kition']).toContain(found.file)
    else expect(found).toEqual({ missing: true })
  })

  it('passes the kit options to the gateway as to kition mcp', () => {
    expect(kitOptions({})).toEqual(['--unified'])
    expect(kitOptions({ KITION_KITS_DIR: '/kits', KITION_KITS_UNIFIED: 'false' })).toEqual(['--kits-dir', '/kits'])
  })
})

describe('the gateways', () => {
  const kition = fakeBin()

  it('starts one gateway per workspace on first need and reuses it', async () => {
    const dirs = fresh('reuse')
    const gateways = new Gateways({ env: { PATH: '/usr/bin:/bin', HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home, FAKE_KITION_LOG: dirs.log } })
    try {
      const [a, b] = await Promise.all([gateways.get(dirs.workspace), gateways.get(dirs.workspace)])
      expect(a).toBe(b)
      expect(a.owned).toBe(true)
      expect(a.lockfile).toBe(path.join(dirs.home, 'run', `${workspaceKey(dirs.workspace)}.json`))
      expect(await gateways.get(dirs.workspace)).toBe(a)
      const starts = fs.readFileSync(dirs.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(starts).toEqual([['gateway', '--workspace', dirs.workspace, '--stdin-lifetime', '--unified']])
      expect((await get(`${a.url}/echo`, { 'kition-token': a.token })).status).toBe(200)
    } finally {
      await gateways.stop()
    }
  })

  it('reuses a gateway another process already runs for the folder (its lockfile, exit 3)', async () => {
    const dirs = fresh('running')
    const other = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
    const theirs = await other.get(dirs.workspace)
    const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
    try {
      const ours = await gateways.get(dirs.workspace)
      expect(ours.owned).toBe(false)
      expect(ours.port).toBe(theirs.port)
      expect(ours.token).toBe(theirs.token)
      // It stops: the next request starts one of our own, with a new token.
      await other.stop()
      const next = await gateways.get(dirs.workspace)
      expect(next.owned).toBe(true)
      expect(next.token).not.toBe(theirs.token)
    } finally {
      await gateways.stop()
      await other.stop()
    }
  })

  it('starts the gateway again after it dies, with the new token', async () => {
    const dirs = fresh('restart')
    const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
    try {
      const first = await gateways.get(dirs.workspace)
      process.kill(first.pid, 'SIGKILL')
      await expect.poll(() => gateways.entries.get(dirs.workspace)?.child).toBeUndefined()
      const second = await gateways.get(dirs.workspace)
      expect(second.pid).not.toBe(first.pid)
      expect(second.token).not.toBe(first.token)
      expect((await get(`${second.url}/echo`, { 'kition-token': second.token })).status).toBe(200)
    } finally {
      await gateways.stop()
    }
  })

  it('stops the gateways it started when the host stops, and they remove their lockfiles', async () => {
    const dirs = fresh('stop')
    const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
    const gateway = await gateways.get(dirs.workspace)
    await gateways.stop()
    expect(fs.existsSync(gateway.lockfile)).toBe(false)
    expect(() => process.kill(gateway.pid, 0)).toThrow()
    await expect(gateways.get(dirs.workspace)).rejects.toThrow(GatewayError)
  })

  it('answers at once that kition is missing, with how to install it', async () => {
    const dirs = fresh('missing')
    const gateways = new Gateways({ env: { PATH: path.join(scratch, 'empty'), HOME: dirs.fakeHome, KITION_HOME: dirs.home } })
    const found = findKition({ PATH: path.join(scratch, 'empty'), HOME: dirs.fakeHome })
    if (!found.missing) return // a system folder of this machine has kition
    const error = await gateways.get(dirs.workspace).catch((caught) => caught)
    expect(error).toBeInstanceOf(GatewayError)
    expect(error.code).toBe('kition-missing')
    expect(error.message).toContain('npm install -g @kition/cli')
  })

  it('says why when the gateway cannot start', async () => {
    const dirs = fresh('failing')
    const failing = path.join(scratch, 'failing-kition')
    fs.writeFileSync(failing, '#!/bin/sh\necho "kition gateway: no such folder" >&2\nexit 1\n', { mode: 0o755 })
    const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: failing, KITION_HOME: dirs.home } })
    const error = await gateways.get(dirs.workspace).catch((caught) => caught)
    expect(error.code).toBe('gateway-failed')
    expect(error.message).toContain('no such folder')
  })
})

it('the stand-in gateway is runnable', () => {
  expect(spawnSync(process.execPath, ['--check', path.join(plugin, 'test/fake-kition.mjs')]).status).toBe(0)
})

describe('the proxy', async () => {
  const { createRoutes, relativeInside } = await import('../plugins/deepseek-harness/kition-kits/lib/routes.mjs')
  const { Workspaces } = await import('../plugins/deepseek-harness/kition-kits/lib/workspaces.mjs')
  const kition = fakeBin('proxy')
  const dirs = fresh('proxy')
  const elsewhere = fresh('elsewhere')
  fs.writeFileSync(path.join(dirs.workspace, 'a.md'), '# A\n')
  const sessions = { s1: dirs.workspace, s2: path.join(dirs.workspace, '.') }
  const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
  const workspaces = new Workspaces({ cwdOf: (id) => sessions[id], list: () => Object.values(sessions) })
  // DeepSeek Harness's login, as its connection service answers: a request without the cookie is refused.
  const rejection = (req) => (req.headers.cookie === 'dsh-auth=ok' ? undefined : 401)
  const handle = createRoutes({ gateways, workspaces, rejection })
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/kition/') && req.url !== '/kition') return res.writeHead(404).end()
    handle(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const auth = { cookie: 'dsh-auth=ok' }
  afterAll(async () => {
    server.close()
    await gateways.stop()
  })
  const key = workspaceKey(dirs.workspace)
  const json = (answer) => JSON.parse(answer.body.toString('utf8'))

  it('refuses every request DeepSeek Harness’s login refuses, before starting anything', async () => {
    for (const address of ['/kition/api/open?session=s1&path=a.md', `/kition/w/${key}/echo`, '/kition/nothing']) {
      const answer = await get(`${base}${address}`)
      expect(answer.status, address).toBe(401)
      expect(json(answer).error).toBe('unauthenticated')
    }
    expect(gateways.entries.size).toBe(0)
  })

  it('opens a session’s file: its gateway started and the page’s address under the workspace’s key', async () => {
    const answer = await get(`${base}/kition/api/open?session=s1&path=a.md`, auth)
    expect(answer.status).toBe(200)
    expect(json(answer)).toEqual({ key, workspace: dirs.workspace, path: 'a.md', page: `/kition/w/${key}/page/?path=a.md` })
    const absolute = json(await get(`${base}/kition/api/open?session=s2&path=${encodeURIComponent(path.join(dirs.workspace, 'a.md'))}`, auth))
    expect(absolute.path).toBe('a.md')
  })

  it('refuses a session it does not know and a file outside the session’s workspace', async () => {
    expect(json(await get(`${base}/kition/api/open?session=nope&path=a.md`, auth)).error).toBe('session-unknown')
    for (const file of ['../x.md', path.join(elsewhere.workspace, 'x.md'), '', '.']) {
      const answer = await get(`${base}/kition/api/open?session=s1&path=${encodeURIComponent(file)}`, auth)
      expect(answer.status, file).toBe(403)
    }
    expect(relativeInside('/w', 'sub/../b.md')).toBe('b.md')
    expect(relativeInside('/w', '/w2/b.md')).toBeNull()
  })

  it('answers 404 for a workspace key no session works in, and never climbs out of the key', async () => {
    const unknown = workspaceKey(elsewhere.workspace)
    expect((await get(`${base}/kition/w/${unknown}/echo`, auth)).status).toBe(404)
    expect(json(await get(`${base}/kition/w/${unknown}/echo`, auth)).error).toBe('workspace-unknown')
    expect(gateways.entries.has(elsewhere.workspace)).toBe(false)
    for (const address of [`/kition/w/${key}/../${unknown}/echo`, `/kition/w/${key}/%2e%2e/${unknown}/echo`, `/kition/w/${key}/%2E%2E/%2E%2E/api/open`, '/kition/w/../../etc/passwd']) {
      const answer = await get(`${base}${address}`, auth)
      expect([404, 400], address).toContain(answer.status)
    }
  })

  it('forwards to the gateway with its Host and token, and without the browser’s credentials', async () => {
    const answer = await get(`${base}/kition/w/${key}/echo/x?y=1`, { ...auth, origin: 'http://evil.example', referer: 'http://evil.example/', 'kition-token': 'forged', 'x-kept': 'yes' })
    expect(answer.status).toBe(200)
    const seen = json(answer)
    const gateway = await gateways.get(dirs.workspace)
    expect(seen.url).toBe('/echo/x?y=1')
    expect(seen.headers.host).toBe(`127.0.0.1:${gateway.port}`)
    expect(seen.headers['kition-token']).toBe(gateway.token)
    expect(seen.headers['x-kept']).toBe('yes')
    for (const name of ['origin', 'cookie', 'referer']) expect(seen.headers[name], name).toBeUndefined()
    expect(answer.headers.etag).toBe('"echo"')
  })

  it('streams an event stream as it comes, without buffering', async () => {
    const times = await new Promise((resolve, reject) => {
      http.get(`${base}/kition/w/${key}/events`, { headers: auth }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream')
        expect(res.headers['cache-control']).toContain('no-transform')
        const arrived = []
        res.on('data', () => arrived.push(Date.now()))
        res.on('end', () => resolve(arrived))
      }).on('error', reject)
    })
    expect(times.length).toBe(3)
    expect(times[2] - times[0]).toBeGreaterThan(450)
  })

  it('passes ranges and large bodies through as they are', async () => {
    const ranged = await get(`${base}/kition/w/${key}/bytes`, { ...auth, range: 'bytes=10-19' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers['content-range']).toBe('bytes 10-19/1000')
    expect([...ranged.body]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    const body = crypto.randomBytes(8 * 1024 * 1024)
    const put = await new Promise((resolve, reject) => {
      const request = http.request(`${base}/kition/w/${key}/echo`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream' } }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      })
      request.on('error', reject)
      request.end(body)
    })
    expect(put.method).toBe('PUT')
    expect(put.length).toBe(body.length)
    expect(put.sha256).toBe(crypto.createHash('sha256').update(body).digest('hex'))
  })

  it('answers 502 with a reason when the gateway does not answer, and starts another on the next request', async () => {
    const gateway = await gateways.get(dirs.workspace)
    // Killed: its lockfile stays. Taken as another process's gateway, which the host cannot watch.
    process.kill(gateway.pid, 'SIGKILL')
    await expect.poll(() => gateways.entries.get(dirs.workspace).child).toBeUndefined()
    expect(fs.existsSync(gateway.lockfile)).toBe(true)
    gateways.entries.get(dirs.workspace).gateway = { ...gateway, owned: false }
    const down = await get(`${base}/kition/w/${key}/echo`, auth)
    expect(down.status).toBe(502)
    expect(json(down).error).toBe('gateway-unreachable')
    const up = await get(`${base}/kition/w/${key}/echo`, auth)
    expect(up.status).toBe(200)
    expect(json(up).pid).not.toBe(gateway.pid)
  })

  it('finds a workspace by its key among the sessions’ folders after a restart', async () => {
    const fresh = new Workspaces({ cwdOf: () => undefined, list: () => [dirs.workspace] })
    expect(await fresh.ofKey(key)).toBe(dirs.workspace)
    expect(await fresh.ofKey(workspaceKey(elsewhere.workspace))).toBeNull()
  })
})

describe('the kit tools (regressions/issue-dsh-session-workspace)', async () => {
  const YAML = (await import('yaml')).default
  const { KitTools, TOOL_PREFIX, projectContent } = await import('../plugins/deepseek-harness/kition-kits/lib/tools.mjs')
  const { GatewayMcp } = await import('../plugins/deepseek-harness/kition-kits/lib/mcp.mjs')
  const kition = fakeBin('tools')
  const dirs = fresh('tools')
  const other = fresh('tools-other')
  const gateways = new Gateways({ env: { HOME: dirs.fakeHome, KITION_BIN: kition, KITION_HOME: dirs.home } })
  afterAll(() => gateways.stop())
  const registered = new Map()
  const tools = new KitTools({ ctx: { get: () => undefined }, register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)), gateways, mcp: new GatewayMcp() })
  tools.update({ tools: [{ name: 'kit_inspect', description: 'Inspect', inputSchema: { type: 'object' } }], instructions: 'Kition kits edit files.' })
  const exec = (cwd, agent = {}) => ({ agent: Object.assign(agent, { session: { header: { cwd } } }), signal: new AbortController().signal })
  const answered = (value) => JSON.parse(value.content[0].text)

  it('no longer runs one server on one folder for the whole host: the patch has no MCP row bound to a folder', () => {
    const js = { tag: 'tag:yaml.org,2002:js', resolve: (source) => ({ js: source }) }
    const [{ insert }] = YAML.parse(fs.readFileSync(path.join(plugin, 'cordis.patch.yml'), 'utf8'), { customTags: [js] })
    expect(insert.filter((row) => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(JSON.stringify(insert)).not.toContain('process.cwd()')
    expect(JSON.stringify(insert)).not.toContain('KITION_WORKSPACE')
  })

  it('registers each tool of the kits’ server as mcp__kition__<tool>', () => {
    expect([...registered.keys()]).toEqual([`${TOOL_PREFIX}kit_inspect`])
    const definition = registered.get('mcp__kition__kit_inspect')
    expect(definition.parameters).toEqual({ type: 'object' })
    expect(definition.output.schema.required).toEqual(['content'])
  })

  it('runs each call on the gateway of the calling session’s own workspace, never the host’s folder', async () => {
    const definition = registered.get('mcp__kition__kit_inspect')
    expect(process.cwd()).not.toBe(dirs.workspace)
    const first = answered(await definition.execute({ path: 'a.md' }, exec(dirs.workspace)))
    const second = answered(await definition.execute({ path: 'b.md' }, exec(other.workspace)))
    expect(first).toEqual({ workspace: dirs.workspace, tool: 'kit_inspect', arguments: { path: 'a.md' } })
    expect(second.workspace).toBe(other.workspace)
    expect(gateways.entries.size).toBe(2)
  })

  it('says so when the session has no workspace folder, and when kition is missing', async () => {
    const definition = registered.get('mcp__kition__kit_inspect')
    await expect(definition.execute({}, exec(undefined))).rejects.toThrow(/no workspace folder/)
    const missing = new KitTools({ ctx: { get: () => undefined }, register: () => () => {}, gateways: new Gateways({ env: { PATH: path.join(scratch, 'empty'), HOME: dirs.fakeHome, KITION_HOME: dirs.home } }), mcp: new GatewayMcp() })
    if (findKition({ PATH: path.join(scratch, 'empty'), HOME: dirs.fakeHome }).missing)
      await expect(missing.definition('mcp__kition__kit_inspect', { name: 'kit_inspect' }).execute({}, exec(dirs.workspace))).rejects.toThrow(/kition is not installed/)
  })

  it('turns an MCP error result into a failed call, and keeps images where they were', () => {
    expect(projectContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw==' }, { type: 'text', text: 'c' }], null, 'no images')).toEqual([{ type: 'text', text: 'a\nb\n[image unavailable: image/png; no images]\nc' }])
    expect(projectContent([{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'x' }], () => ({ type: 'image', attachment: 'ref' }))).toEqual([{ type: 'text', text: 'a' }, { type: 'image', attachment: 'ref' }])
  })

  it('removes a tool the server no longer lists, and replaces one that changed', () => {
    tools.update({ tools: [{ name: 'kit_inspect', description: 'Inspect, changed', inputSchema: { type: 'object' } }, { name: 'kit_run', inputSchema: { type: 'object' } }] })
    expect(registered.get('mcp__kition__kit_inspect').description).toBe('Inspect, changed')
    tools.update({ tools: [{ name: 'kit_run', inputSchema: { type: 'object' } }] })
    expect([...registered.keys()]).toEqual(['mcp__kition__kit_run'])
    expect(tools.instructions).toBe('Kition kits edit files.')
  })
})

describe('keeping the kit tools current, without a restart', async () => {
  const { KitTools, SETUP_TOOL, presentation } = await import('../plugins/deepseek-harness/kition-kits/lib/tools.mjs')
  const { GatewayMcp, catalog } = await import('../plugins/deepseek-harness/kition-kits/lib/mcp.mjs')
  const { Freshness } = await import('../plugins/deepseek-harness/kition-kits/lib/freshness.mjs')
  const dirs = fresh('freshness')
  const bin = path.join(dirs.fakeHome, '.kition/bin')
  const env = { PATH: path.join(scratch, 'empty'), HOME: dirs.fakeHome, KITION_HOME: dirs.home }
  const gateways = new Gateways({ env })
  afterAll(() => gateways.stop())
  const registered = new Map()
  const tools = new KitTools({ ctx: { get: () => undefined }, register: (definition) => (registered.set(definition.name, definition), () => registered.delete(definition.name)), gateways, mcp: new GatewayMcp() })
  const freshness = new Freshness({ env, tools, gateways, catalog, intervalMs: 60_000 })
  const missing = findKition(env).missing

  it('gives the agent one tool that says how to install kition while there is none', async () => {
    if (!missing) return // a system folder of this machine has kition
    await freshness.refresh()
    expect([...registered.keys()]).toEqual([SETUP_TOOL])
    const answer = await registered.get(SETUP_TOOL).execute({}, {})
    expect(answer.content[0].text).toContain('npm install -g @kition/cli')
  })

  it('lists the kits’ tools once kition is installed, and drops the setup tool', async () => {
    if (!missing) return
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'kition'), `#!${process.execPath}\nimport(${JSON.stringify(path.join(plugin, 'test/fake-kition.mjs'))})\n`, { mode: 0o755 })
    await freshness.check()
    expect([...registered.keys()]).toEqual(['mcp__kition__kit_inspect'])
    expect(tools.instructions).toBe('Stand-in kits.')
  })

  it('lists them again when kition changes (an upgrade), and stops the gateways of the old one', async () => {
    if (!missing) return
    const before = await gateways.get(dirs.workspace)
    env.FAKE_KITION_TOOLS = 'kit_inspect,kit_run'
    // An upgrade replaces the executable: another size and time.
    fs.appendFileSync(path.join(bin, 'kition'), '// 0.6.0\n')
    fs.utimesSync(path.join(bin, 'kition'), new Date(), new Date(Date.now() + 5000))
    await freshness.check()
    expect([...registered.keys()].sort()).toEqual(['mcp__kition__kit_inspect', 'mcp__kition__kit_run'])
    await expect.poll(() => fs.existsSync(before.lockfile)).toBe(false)
    expect((await gateways.get(dirs.workspace)).pid).not.toBe(before.pid)
  })

  it('reads the kits’ resources from the gateway of the calling session’s folder', async () => {
    if (!missing) return
    const provider = tools.resourceProvider()
    const exec = { agent: { session: { header: { cwd: dirs.workspace } } }, signal: new AbortController().signal }
    expect(await provider.request({ method: 'resources/list' }, exec)).toEqual({ resources: [{ uri: 'khp://kits/kit.note/kit.json', name: 'Note kit manifest' }] })
    const read = await provider.request({ method: 'resources/read', uri: 'khp://kits/kit.note/kit.json' }, exec)
    expect(JSON.parse(read.contents[0].text).workspace).toBe(dirs.workspace)
  })

  it('keeps what each call did in the session log, for the review cards', () => {
    expect(presentation('kit_run', { path: 'a.md' }, { structuredContent: { live: true, saved: true, document: { kit: 'kit.note', path: 'a.md' } } })).toEqual({ kition: 1, tool: 'kit_run', path: 'a.md', kit: 'kit.note', live: true, draft: false, saved: true, created: false })
    expect(presentation('kit_run', { path: 'b.ktable', draft: true }, { structuredContent: { draft: true, saved: false } })).toMatchObject({ path: 'b.ktable', kit: null, live: false, draft: true })
    expect(presentation('kit_create', { path: 'c.md' }, {})).toMatchObject({ path: 'c.md', created: true })
    expect(registered.get('mcp__kition__kit_inspect').output.presentationMeta({ path: 'a.md' }, { content: [] })).toMatchObject({ kition: 1, path: 'a.md' })
  })
})

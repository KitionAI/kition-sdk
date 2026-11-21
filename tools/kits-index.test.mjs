import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY, PLATFORMS, REGISTRY, compareVersions, gatherIndex, kitsOfModules, main, registryNet, reportLines, schemaProblems, serialize } from './kits-index.mjs'
import { integrityOf, kitionField, packageName, tarballPath } from './kit-npm.mjs'

const scratch = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kits-index-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A kit.json of `kit` at `version`. */
const kitJson = (kit, version, { protocol = 'kition-kit/1', name = kit[0].toUpperCase() + kit.slice(1), extensions = [kit === 'note' ? 'md' : `k${kit}`], views = [] } = {}) => ({
  id: `kit.${kit}`,
  name,
  version,
  formats: [{ id: kit, extensions, role: 'edit' }, ...(views.length ? [{ id: `${kit}-view`, extensions: views, role: 'view' }] : [])],
  headless: { executable: `kition-${kit}`, protocol },
})

/**
 * A fake npm registry: `kits` maps a kit to its versions, each `{ platforms, ui, ...kit.json
 * options }`. `net` answers each package's metadata (all its versions, with the `kition` field
 * and npm's dist.integrity), null for a package never published, and each tarball's size to a
 * HEAD (null, as registryNet answers a 404, for a tarball npm does not serve yet); it records
 * every URL asked. `tamper(name, version, manifest)` changes a manifest; `fail` names URLs that
 * answer an error; `notReady` names tarballs whose metadata is listed but that answer 404.
 */
function fakeRegistry(kits, { registry = REGISTRY, tamper = () => {}, fail = [], notReady = [] } = {}) {
  const packuments = new Map()
  const sizes = new Map()
  for (const [kit, versions] of Object.entries(kits)) {
    for (const [version, { platforms = PLATFORMS, ui = true, ...options }] of Object.entries(versions)) {
      const manifestOf = (part) => {
        const name = packageName(kit, part)
        const kition = kitionField(kitJson(kit, version, options), part === 'ui' ? 'ui' : 'headless', { platform: part === 'ui' ? undefined : part })
        const bytes = Buffer.from(`${name}@${version}`)
        const manifest = { name, version, kition, dist: { integrity: integrityOf(bytes), tarball: `${registry}${tarballPath(name, version)}` } }
        tamper(name, version, manifest)
        sizes.set(`${registry}${tarballPath(name, version)}`, 1000 + bytes.length)
        const packument = packuments.get(name) ?? { name, versions: {} }
        packument.versions[version] = manifest
        packuments.set(name, packument)
      }
      for (const platform of platforms) manifestOf(platform)
      if (ui) manifestOf('ui')
    }
  }
  const seen = []
  const net = async (url, { as = 'json' } = {}) => {
    seen.push(`${as} ${url}`)
    if (fail.includes(url)) throw new Error(`${url}: HTTP 500`)
    if (as === 'size') {
      if (!sizes.has(url) || notReady.includes(url)) return null
      return sizes.get(url)
    }
    const name = decodeURIComponent(url.slice(registry.length))
    return packuments.has(name) ? structuredClone(packuments.get(name)) : null
  }
  return { net, seen, registry }
}

describe('kits-index: the kit index gathered from the npm registry', () => {
  it('leaves out npm\'s placeholder of a first publish (0.0.0-stage), and refuses any other version without a kition field', async () => {
    // What registry.npmjs.org shows of a package first published on 2026-11-20: the version
    // published and, beside it, npm's own "Temporary package placeholder for staged publishing".
    const placeholder = (name) => ({ name, version: '0.0.0-stage', description: 'Temporary package placeholder for staged publishing', dist: { integrity: integrityOf(Buffer.from('placeholder')) } })
    const staged = (kits) => {
      const registry = fakeRegistry(kits)
      return { ...registry, net: async (url, options) => {
        const answer = await registry.net(url, options)
        if (answer && typeof answer === 'object' && answer.versions) answer.versions['0.0.0-stage'] = placeholder(answer.name)
        return answer
      } }
    }
    const { net } = staged({ board: { '0.1.4': {} } })
    const { index, report } = await gatherIndex({ kits: ["board"], registry: REGISTRY, net })
    expect(Object.keys(index.kits.board.versions)).toEqual(['0.1.4'])
    expect(report).toEqual([{ kit: 'board', versions: ['0.1.4'], editors: ['0.1.4'], uiOnly: [] }])
    const bare = fakeRegistry({ board: { '0.1.4': {} } }, { tamper: (name, version, manifest) => { if (name === '@kition/kit-board-ui') delete manifest.kition } })
    await expect(gatherIndex({ kits: ["board"], registry: REGISTRY, net: bare.net })).rejects.toThrow('@kition/kit-board-ui@0.1.4 has no kition field')
  })

  it('lists each kit’s versions with every platform’s package and its editor, sizes and integrity from the registry, valid against the schema', async () => {
    const { net, seen } = fakeRegistry({
      note: { '0.1.0': {}, '0.1.2': { views: ['txt'] } },
      table: { '0.5.6': { platforms: ['darwin-arm64', 'linux-x64'], ui: false } },
    })
    const { index, report } = await gatherIndex({ kits: ['note', 'table'], net })
    expect(schemaProblems(index)).toEqual([])
    expect(index.schemaVersion).toBe(1)
    expect(Object.keys(index.kits.note.versions)).toEqual(['0.1.0', '0.1.2'])
    const darwin = index.kits.note.versions['0.1.2'].platforms['darwin-arm64']
    expect(darwin).toEqual({ package: '@kition/kit-note-darwin-arm64', size: 1000 + Buffer.from('@kition/kit-note-darwin-arm64@0.1.2').length, integrity: integrityOf(Buffer.from('@kition/kit-note-darwin-arm64@0.1.2')) })
    expect(Object.keys(index.kits.note.versions['0.1.2'].platforms)).toEqual([...PLATFORMS].sort())
    expect(index.kits.note.versions['0.1.2'].ui.package).toBe('@kition/kit-note-ui')
    expect(index.kits.note.views).toEqual(['txt'])
    expect(index.kits.note.extensions).toEqual(['md'])
    expect(index.kits.table.versions['0.5.6'].ui).toBeUndefined()
    expect(Object.keys(index.kits.table.versions['0.5.6'].platforms)).toEqual(['darwin-arm64', 'linux-x64'])
    expect(report.find(({ kit }) => kit === 'table')).toEqual({ kit: 'table', versions: ['0.5.6'], editors: [], uiOnly: [] })
    // Metadata and HEADs of the tarballs only: no tarball is downloaded.
    expect(seen.every((line) => line.startsWith('json ') || line.startsWith('size '))).toBe(true)
    expect(seen.filter((line) => line.startsWith('size ')).every((line) => line.endsWith('.tgz'))).toBe(true)
  })

  it('keeps a size the previous index gives for the same integrity, and asks the registry for the rest', async () => {
    const { net } = fakeRegistry({ note: { '0.1.0': {} } })
    const { index } = await gatherIndex({ kits: ['note'], net })
    const second = fakeRegistry({ note: { '0.1.0': {}, '0.2.0': {} } })
    const { index: next } = await gatherIndex({ kits: ['note'], net: second.net, previous: index })
    expect(second.seen.filter((line) => line.startsWith('size ') && line.includes('0.1.0'))).toEqual([])
    expect(second.seen.filter((line) => line.startsWith('size ') && line.includes('0.2.0'))).toHaveLength(PLATFORMS.length + 1)
    expect(next.kits.note.versions['0.1.0']).toEqual(index.kits.note.versions['0.1.0'])
  })

  it('gives the same bytes whatever order the registry lists versions in', async () => {
    const forward = fakeRegistry({ note: { '0.1.0': {}, '0.10.0': {}, '0.2.0': {} } })
    const backward = fakeRegistry({ note: { '0.2.0': {}, '0.10.0': {}, '0.1.0': {} } })
    const a = serialize((await gatherIndex({ kits: ['note'], net: forward.net })).index)
    const b = serialize((await gatherIndex({ kits: ['note'], net: backward.net })).index)
    expect(a).toBe(b)
    expect(Object.keys(JSON.parse(a).kits.note.versions)).toEqual(['0.1.0', '0.2.0', '0.10.0'])
  })

  it('takes the kit’s name, extensions and views from its newest version and each version’s own protocol', async () => {
    const { net } = fakeRegistry({ note: { '0.1.0': { name: 'Old', protocol: 'kition-kit/2' }, '0.2.0': { name: 'Note', extensions: ['md', 'markdown'], views: ['txt'] } } })
    const { index } = await gatherIndex({ kits: ['note'], net })
    expect(index.kits.note.name).toBe('Note')
    expect(index.kits.note.extensions).toEqual(['md', 'markdown'])
    expect(index.kits.note.views).toEqual(['txt'])
    expect(index.kits.note.versions['0.1.0'].protocol).toBe('kition-kit/2')
    expect(index.kits.note.versions['0.2.0'].protocol).toBe('kition-kit/1')
  })

  it('leaves out an editor package without a headless one, and a kit with no package at all, and names them', async () => {
    const { net } = fakeRegistry({ note: { '0.1.0': {}, '0.2.0': { platforms: [] } } })
    const gathered = await gatherIndex({ kits: ['board', 'note'], net })
    expect(Object.keys(gathered.index.kits)).toEqual(['note'])
    expect(Object.keys(gathered.index.kits.note.versions)).toEqual(['0.1.0'])
    const lines = reportLines(gathered)
    expect(lines).toContain('board: no version')
    expect(lines).toContain('  an editor package without a headless one, left out: 0.2.0')
  })

  it('holds back a version still being published: one that lacks a package the highest listed lower version has', async () => {
    // What npm showed on 2026-11-21: Layout 0.1.4's five platform packages, not yet its editor.
    const unfinished = fakeRegistry({ layout: { '0.1.3': {}, '0.1.4': { ui: false, name: 'Layout 4' } } })
    const gathered = await gatherIndex({ kits: ['layout'], net: unfinished.net })
    expect(Object.keys(gathered.index.kits.layout.versions)).toEqual(['0.1.3'])
    expect(gathered.index.kits.layout.versions['0.1.3'].ui.package).toBe('@kition/kit-layout-ui')
    expect(gathered.index.kits.layout.name).toBe('Layout')
    expect(gathered.held).toEqual([{ kit: 'layout', version: '0.1.4', preceding: '0.1.3', missing: ['ui'] }])
    expect(reportLines(gathered)).toContain('  held layout 0.1.4: still being published (no ui package; 0.1.3 has one)')
    expect(reportLines(gathered)).toContain('layout: 0.1.3')
    // The editor arrives: the version is listed with it.
    const finished = fakeRegistry({ layout: { '0.1.3': {}, '0.1.4': {} } })
    const done = await gatherIndex({ kits: ['layout'], net: finished.net })
    expect(Object.keys(done.index.kits.layout.versions)).toEqual(['0.1.3', '0.1.4'])
    expect(done.held).toEqual([])
    expect(reportLines(done).some((line) => line.includes('held'))).toBe(false)

    // Some platforms only; the next version is compared with the same listed one (0.1.3), not
    // with the held 0.1.4; one with more packages than the one before is listed.
    const partial = fakeRegistry({
      layout: {
        '0.1.3': {},
        '0.1.4': { platforms: ['darwin-arm64', 'linux-x64'] },
        '0.1.5': { platforms: PLATFORMS.filter((platform) => platform !== 'win32-x64') },
        '0.1.6': {},
      },
      table: {
        '0.5.6': { platforms: ['linux-x64'], ui: false },
        '0.5.7': { platforms: ['linux-x64', 'darwin-arm64'], ui: false },
        '0.5.8': {},
        '0.5.9': { ui: false, platforms: ['linux-x64'] },
      },
    })
    const held = await gatherIndex({ kits: ['layout', 'table'], net: partial.net })
    expect(Object.keys(held.index.kits.layout.versions)).toEqual(['0.1.3', '0.1.6'])
    expect(Object.keys(held.index.kits.table.versions)).toEqual(['0.5.6', '0.5.7', '0.5.8'])
    const missing = PLATFORMS.filter((platform) => !['darwin-arm64', 'linux-x64'].includes(platform)).sort()
    expect(held.held).toEqual([
      { kit: 'layout', version: '0.1.4', preceding: '0.1.3', missing },
      { kit: 'layout', version: '0.1.5', preceding: '0.1.3', missing: ['win32-x64'] },
      { kit: 'table', version: '0.5.9', preceding: '0.5.8', missing: [...PLATFORMS.filter((platform) => platform !== 'linux-x64').sort(), 'ui'] },
    ])
    const lines = reportLines(held)
    expect(lines).toContain(`  held layout 0.1.4: still being published (no ${missing.join(', ')} packages; 0.1.3 has them)`)
    expect(lines).toContain('  held layout 0.1.5: still being published (no win32-x64 package; 0.1.3 has one)')
    expect(lines).toContain('  no editor package: 0.5.6, 0.5.7')
    expect(held.report.find(({ kit }) => kit === 'table').versions).toEqual(['0.5.6', '0.5.7', '0.5.8'])
  })

  it('holds back a version still being published without failing the command line, and names what leaves the previous index', async () => {
    const dir = tempDir()
    const modules = path.join(dir, 'modules.json')
    fs.writeFileSync(modules, JSON.stringify({ layout: { repository: 'KitionAI/kition-layout' } }))
    // The index published on 2026-11-21 (0.1.3) listed Layout 0.1.4 without an editor.
    const previous = path.join(dir, 'previous.json')
    const before = await gatherIndex({ kits: ['layout'], net: fakeRegistry({ layout: { '0.1.4': { ui: false } } }).net })
    const early = await gatherIndex({ kits: ['layout'], net: fakeRegistry({ layout: { '0.1.3': {} } }).net })
    fs.writeFileSync(previous, serialize({ ...early.index, kits: { layout: { ...early.index.kits.layout, versions: { ...early.index.kits.layout.versions, ...before.index.kits.layout.versions } } } }))
    const { net } = fakeRegistry({ layout: { '0.1.3': {}, '0.1.4': { ui: false } } })
    const out = path.join(dir, 'kits-index.json')
    const lines = { out: '', err: '' }
    expect(await main(['--modules', modules, '--out', out, '--previous', previous], { net, out: (text) => (lines.out += text), err: (text) => (lines.err += text) })).toBe(0)
    expect(lines.err).toBe('')
    expect(lines.out).toContain('  held layout 0.1.4: still being published (no ui package; 0.1.3 has one)')
    expect(lines.out).toContain(`compared with the previous index: 0 packages enter, ${PLATFORMS.length} leave`)
    expect(lines.out).toContain('  - layout 0.1.4 linux-x64')
    expect(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).kits.layout.versions)).toEqual(['0.1.3'])
  })

  it('leaves out a package whose tarball is not downloadable yet (npm answers 404), holding its version back like one still being published', async () => {
    // What npm showed on 2026-11-21: Doc 0.1.4 listed in the metadata, its darwin-arm64 tarball 404.
    const tarball = (kit, part, version) => `${REGISTRY}${tarballPath(packageName(kit, part), version)}`
    const notReady = [
      tarball('doc', 'darwin-arm64', '0.1.4'),
      tarball('table', 'ui', '0.5.8'),
      ...[...PLATFORMS, 'ui'].map((part) => tarball('note', part, '0.2.0')),
    ]
    const { net } = fakeRegistry({ doc: { '0.1.3': {}, '0.1.4': {} }, note: { '0.1.0': {}, '0.2.0': {} }, table: { '0.5.8': {} } }, { notReady })
    const gathered = await gatherIndex({ kits: ['doc', 'note', 'table'], net })
    expect(Object.keys(gathered.index.kits.doc.versions)).toEqual(['0.1.3'])
    expect(gathered.held).toEqual([{ kit: 'doc', version: '0.1.4', preceding: '0.1.3', missing: ['darwin-arm64'] }])
    // A kit's first version is listed without the package, until npm serves it.
    expect(gathered.index.kits.table.versions['0.5.8'].ui).toBeUndefined()
    expect(Object.keys(gathered.index.kits.table.versions['0.5.8'].platforms)).toEqual([...PLATFORMS].sort())
    // A version none of whose tarballs npm serves yet is in no list of the index or the report.
    expect(Object.keys(gathered.index.kits.note.versions)).toEqual(['0.1.0'])
    expect(gathered.report.find(({ kit }) => kit === 'note')).toEqual({ kit: 'note', versions: ['0.1.0'], editors: ['0.1.0'], uiOnly: [] })
    expect(gathered.notReady).toEqual([
      { kit: 'doc', version: '0.1.4', part: 'darwin-arm64' },
      ...[...PLATFORMS, 'ui'].map((part) => ({ kit: 'note', version: '0.2.0', part })),
      { kit: 'table', version: '0.5.8', part: 'ui' },
    ])
    const lines = reportLines(gathered)
    expect(lines).toContain('  held doc 0.1.4: still being published (no darwin-arm64 package; 0.1.3 has one; the darwin-arm64 tarball is not downloadable yet)')
    expect(lines).toContain(`  a tarball not downloadable yet, left out for now: ${[...PLATFORMS, 'ui'].map((part) => `0.2.0 ${part}`).join(', ')}`)
    expect(lines).toContain('  a tarball not downloadable yet, left out for now: 0.5.8 ui')
    expect(lines.filter((line) => line.includes('0.1.4') && line.includes('left out for now'))).toEqual([])

    // A size the previous index gives for the same integrity needs no request.
    const previous = (await gatherIndex({ kits: ['doc'], net: fakeRegistry({ doc: { '0.1.3': {}, '0.1.4': {} } }).net })).index
    const known = fakeRegistry({ doc: { '0.1.3': {}, '0.1.4': {} } }, { notReady })
    const kept = await gatherIndex({ kits: ['doc'], net: known.net, previous })
    expect(Object.keys(kept.index.kits.doc.versions)).toEqual(['0.1.3', '0.1.4'])
    expect(kept.notReady).toEqual([])
    expect(known.seen.filter((line) => line.startsWith('size '))).toEqual([])

    // The command line succeeds and says why.
    const dir = tempDir()
    const modules = path.join(dir, 'modules.json')
    fs.writeFileSync(modules, JSON.stringify({ doc: { repository: 'KitionAI/kition-doc' } }))
    const io = { out: '', err: '' }
    expect(await main(['--modules', modules, '--out', path.join(dir, 'kits-index.json')], { net, out: (text) => (io.out += text), err: (text) => (io.err += text) })).toBe(0)
    expect(io.err).toBe('')
    expect(io.out).toContain('held doc 0.1.4: still being published (no darwin-arm64 package; 0.1.3 has one; the darwin-arm64 tarball is not downloadable yet)')
  })

  it('stops on a package whose kition field disagrees with its name or with the other packages of its version, or has no sha512 integrity', async () => {
    const cases = [
      [(name, version, manifest) => name.endsWith('linux-x64') && (manifest.kition.protocol = 'kition-kit/9'), /says protocol/],
      [(name, version, manifest) => name.endsWith('ui') && (manifest.kition.extensions = ['other']), /other extensions/],
      [(name, version, manifest) => name.endsWith('darwin-arm64') && (manifest.kition.platform = 'linux-x64'), /role headless linux-x64, not headless darwin-arm64/],
      [(name, version, manifest) => name.endsWith('ui') && (manifest.kition.kit = 'table'), /is the kit table/],
      [(name, version, manifest) => name.endsWith('win32-x64') && delete manifest.kition, /has no kition field/],
      [(name, version, manifest) => name.endsWith('ui') && (manifest.dist.integrity = `sha1-${'a'.repeat(27)}=`), /no sha512 integrity/],
      [(name, version, manifest) => name.endsWith('ui') && (manifest.version = '9.9.9'), /its package.json is/],
    ]
    for (const [tamper, error] of cases) {
      const { net } = fakeRegistry({ note: { '0.1.0': {} } }, { tamper })
      await expect(gatherIndex({ kits: ['note'], net }), String(error)).rejects.toThrow(error)
    }
  })

  it('stops when the registry answers an error or a tarball has no size, instead of writing a smaller index', async () => {
    const metadata = `${REGISTRY}${packageName('note', 'linux-arm64').replace('/', '%2f')}`
    const failing = fakeRegistry({ note: { '0.1.0': {} } }, { fail: [metadata] })
    await expect(gatherIndex({ kits: ['note'], net: failing.net })).rejects.toThrow(/the metadata of @kition\/kit-note-linux-arm64 cannot be read/)
    const tarball = `${REGISTRY}${tarballPath(packageName('note', 'ui'), '0.1.0')}`
    const sizeless = fakeRegistry({ note: { '0.1.0': {} } }, { fail: [tarball] })
    await expect(gatherIndex({ kits: ['note'], net: sizeless.net })).rejects.toThrow(/the size of @kition\/kit-note-ui@0.1.0 cannot be read/)
  })

  it('reads the kits of Kition’s modules.json', () => {
    expect(kitsOfModules({ $comment: 'x', table: { repository: 'KitionAI/kition-table' }, note: {} })).toEqual(['note', 'table'])
    expect(() => kitsOfModules({ $comment: 'x' })).toThrow(/names no kit/)
    expect(() => kitsOfModules({ Note: {} })).toThrow(/not a kit name/)
  })

  it('reads a tarball’s size from a one-byte range when the HEAD has no Content-Length, as registry.npmjs.org answers', async () => {
    const asked = []
    const fetchImpl = async (url, { method, headers }) => {
      asked.push(`${method} ${url}${headers.Range ? ` ${headers.Range}` : ''}`)
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'accept-ranges': 'bytes' } })
      if (String(url).endsWith('whole.tgz')) return new Response('all of it', { status: 200 })
      return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/10138522' } })
    }
    const net = registryNet({ fetchImpl })
    expect(await net(`${REGISTRY}x/-/x-1.0.0.tgz`, { as: 'size' })).toBe(10138522)
    expect(asked).toEqual([`HEAD ${REGISTRY}x/-/x-1.0.0.tgz`, `GET ${REGISTRY}x/-/x-1.0.0.tgz bytes=0-0`])
    await expect(net(`${REGISTRY}x/-/whole.tgz`, { as: 'size' })).rejects.toThrow('no size')
  })

  it('answers null for a tarball not downloadable yet: a 404 to its HEAD or to its one-byte range; any other answer is an error', async () => {
    const asked = []
    const fetchImpl = async (url, { method, headers }) => {
      asked.push(`${method} ${url}${headers.Range ? ` ${headers.Range}` : ''}`)
      if (url.endsWith('head-404.tgz')) return new Response(null, { status: 404 })
      if (url.endsWith('head-503.tgz')) return new Response(null, { status: 503 })
      if (method === 'HEAD') return new Response(null, { status: 200 })
      if (url.endsWith('range-404.tgz')) return new Response('{"error":"Not found"}', { status: 404 })
      return new Response('down', { status: 502 })
    }
    const net = registryNet({ fetchImpl })
    expect(await net(`${REGISTRY}x/-/head-404.tgz`, { as: 'size' })).toBeNull()
    expect(await net(`${REGISTRY}x/-/range-404.tgz`, { as: 'size' })).toBeNull()
    await expect(net(`${REGISTRY}x/-/head-503.tgz`, { as: 'size' })).rejects.toThrow(/HTTP 503/)
    await expect(net(`${REGISTRY}x/-/range-502.tgz`, { as: 'size' })).rejects.toThrow('no size')
    expect(asked).toEqual([
      `HEAD ${REGISTRY}x/-/head-404.tgz`,
      `HEAD ${REGISTRY}x/-/range-404.tgz`,
      `GET ${REGISTRY}x/-/range-404.tgz bytes=0-0`,
      `HEAD ${REGISTRY}x/-/head-503.tgz`,
      `HEAD ${REGISTRY}x/-/range-502.tgz`,
      `GET ${REGISTRY}x/-/range-502.tgz bytes=0-0`,
    ])
  })

  it('asks the registry over HTTP: metadata, a 404 as no package, a tarball’s size by HEAD, an error otherwise', async () => {
    const asked = []
    const fetchImpl = async (url, { method }) => {
      asked.push(`${method} ${url}`)
      if (url.endsWith('/missing')) return new Response('{}', { status: 404 })
      if (url.endsWith('/broken')) return new Response('down', { status: 503 })
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '1234' } })
      return new Response(JSON.stringify({ name: 'x' }), { status: 200 })
    }
    const net = registryNet({ fetchImpl })
    expect(await net(`${REGISTRY}x`)).toEqual({ name: 'x' })
    expect(await net(`${REGISTRY}missing`)).toBeNull()
    expect(await net(`${REGISTRY}x/-/x-1.0.0.tgz`, { as: 'size' })).toBe(1234)
    await expect(net(`${REGISTRY}broken`)).rejects.toThrow(/HTTP 503 down/)
    expect(asked).toEqual([`GET ${REGISTRY}x`, `GET ${REGISTRY}missing`, `HEAD ${REGISTRY}x/-/x-1.0.0.tgz`, `GET ${REGISTRY}broken`])
  })
})

describe('kits-index: the command line', () => {
  const modulesFile = (kits) => {
    const file = path.join(tempDir(), 'modules.json')
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(kits.map((kit) => [kit, { repository: `KitionAI/kition-${kit}` }]))))
    return file
  }
  const capture = () => {
    const lines = { out: '', err: '' }
    return { lines, out: (text) => (lines.out += text), err: (text) => (lines.err += text) }
  }

  it('writes the index with --out and its package with --package and --version, compares it with --previous, and writes nothing with --dry-run', async () => {
    const dir = tempDir()
    const { net } = fakeRegistry({ note: { '0.1.0': {}, '0.2.0': {} } })
    const modules = modulesFile(['note'])
    const previous = path.join(dir, 'previous.json')
    fs.writeFileSync(previous, serialize((await gatherIndex({ kits: ['note'], net: fakeRegistry({ note: { '0.1.0': {} } }).net })).index))
    const out = path.join(dir, 'kits-index.json')
    const io = capture()
    expect(await main(['--modules', modules, '--out', out, '--previous', previous, '--package', path.join(dir, 'pkg'), '--version', '0.1.4'], { net, ...io })).toBe(0)
    expect(io.lines.out).toContain(`compared with the previous index: ${PLATFORMS.length + 1} packages enter, 0 leave`)
    expect(io.lines.out).toContain('  + note 0.2.0 ui')
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).kits.note.versions['0.2.0']).toBeDefined()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'pkg/package.json'), 'utf8'))).toMatchObject({ name: '@kition/kits-index', version: '0.1.4', files: ['kits-index.json'] })
    expect(fs.readFileSync(path.join(dir, 'pkg/kits-index.json'), 'utf8')).toBe(fs.readFileSync(out, 'utf8'))
    const dry = capture()
    expect(await main(['--modules', modules, '--dry-run'], { net, ...dry })).toBe(0)
    expect(dry.lines.out).toContain('kits-index.json: 1 of 1 kits (note 0.1.0 0.2.0)')
  })

  it('writes no index that would be empty, and says so with its own exit status', async () => {
    const dir = tempDir()
    const out = path.join(dir, 'kits-index.json')
    const io = capture()
    expect(await main(['--modules', modulesFile(['note']), '--out', out], { net: fakeRegistry({}).net, ...io })).toBe(EMPTY)
    expect(fs.existsSync(out)).toBe(false)
    expect(io.lines.out).toContain('would be empty')
  })

  it('fails without writing when the registry fails, and refuses a wrong command line', async () => {
    const dir = tempDir()
    const out = path.join(dir, 'kits-index.json')
    const io = capture()
    const metadata = `${REGISTRY}${packageName('note', 'ui').replace('/', '%2f')}`
    expect(await main(['--modules', modulesFile(['note']), '--out', out], { net: fakeRegistry({ note: { '0.1.0': {} } }, { fail: [metadata] }).net, ...io })).toBe(1)
    expect(fs.existsSync(out)).toBe(false)
    expect(io.lines.err).toContain('cannot be read')
    for (const args of [[], ['--out', out], ['--modules', 'm.json'], ['--modules', 'm.json', '--out', out, '--dry-run'], ['--modules', 'm.json', '--out', out, '--package', dir], ['--modules', 'm.json', '--dry-run', '--frobnicate']]) {
      expect(await main(args, { net: fakeRegistry({}).net, ...capture() }), JSON.stringify(args)).toBe(2)
    }
  })
})

describe('compareVersions and schemaProblems', () => {
  it('orders semver', () => {
    expect(['0.10.0', '0.2.0', '0.2.0-rc.1', '0.2.0-beta', '1.0.0', '0.2.0-rc.10'].sort(compareVersions)).toEqual(['0.2.0-beta', '0.2.0-rc.1', '0.2.0-rc.10', '0.2.0', '0.10.0', '1.0.0'])
  })

  it('checks every rule of the index schema and refuses a keyword it does not know', () => {
    expect(schemaProblems({ schemaVersion: 1, kits: { Note: { id: 'note', name: '', extensions: [], versions: { v1: {} } } } })).toEqual(expect.arrayContaining([
      expect.stringMatching(/Note \(name\).*does not match/),
      expect.stringMatching(/\/kits\/Note\/id.*does not match/),
      expect.stringMatching(/\/kits\/Note\/name: shorter than 1/),
      expect.stringMatching(/\/kits\/Note\/extensions: fewer than 1 items/),
      expect.stringMatching(/v1 \(name\).*does not match/),
      expect.stringMatching(/\/kits\/Note\/versions\/v1: has no protocol/),
    ]))
    expect(schemaProblems({ schemaVersion: 2 })).toEqual(['/: has no kits', '/schemaVersion: is not 1'])
    const archive = { schemaVersion: 1, kits: { note: { id: 'kit.note', name: 'Note', extensions: ['md'], versions: { '0.1.0': { protocol: 'kition-kit/1', platforms: { 'darwin-arm64': { url: 'x', size: 1, sha256: 'a'.repeat(64) } } } } } } }
    expect(schemaProblems(archive)).toEqual(expect.arrayContaining([expect.stringMatching(/url is not allowed/), expect.stringMatching(/has no package/), expect.stringMatching(/has no integrity/)]))
    expect(() => schemaProblems('x', { maxLength: 3 })).toThrow(/keyword maxLength is not checked/)
  })
})

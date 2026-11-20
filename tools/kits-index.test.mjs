import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY, MODULES_URL, compareVersions, gatherIndex, githubNet, kitsOfModules, main, reportLines, schemaProblems, serialize } from './kits-index.mjs'

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const scratch = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kits-index-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const API = 'https://api.github.com'
const download = (repository, tag, name) => `https://github.com/${repository}/releases/download/${tag}/${name}`

/**
 * A fake GitHub: kit repositories with `package-v<version>` Releases. Each release is
 * `{ version, platforms, fragment: platforms listed | false, kitJson overrides, noDigest }`. `net`
 * answers the API's release lists (in pages), each asset's bytes and each fragment, and counts
 * the requests; `fail` names URLs that answer an error.
 */
function fakeGithub(repos, { fail = [] } = {}) {
  const files = new Map()
  const lists = new Map()
  for (const [repository, { kit, releases, name = kit[0].toUpperCase() + kit.slice(1), extensions = [kit === 'note' ? 'md' : `k${kit}`] }] of Object.entries(repos)) {
    const listed = []
    for (const release of releases) {
      const tag = release.tag ?? `package-v${release.version}`
      const assets = []
      const add = (assetName, bytes, digest = true) => {
        const url = download(repository, tag, assetName)
        files.set(url, bytes)
        assets.push({ name: assetName, size: bytes.length, digest: digest ? `sha256:${sha256(bytes)}` : null, browser_download_url: url })
      }
      // The editor package and its entry, as the kit's Package workflow publishes them;
      // `editor: false` publishes none, `editor: { entry: false, noDigest, edit }` changes them.
      if (release.editor !== false) {
        const editor = release.editor ?? {}
        const bytes = Buffer.from(`${kit} package ${release.version}`)
        const asset = `kition-${kit}-${release.version}.tgz`
        add(asset, bytes, !editor.noDigest)
        if (editor.entry !== false) {
          const entry = { repository, version: release.version, tag, asset, size: bytes.length, sha256: sha256(bytes), commit: 'c'.repeat(40) }
          editor.edit?.(entry)
          add(`kition-${kit}-${release.version}.json`, Buffer.from(JSON.stringify(entry)))
        }
      }
      // The kit.json at the Release's tag, as the GitHub contents API answers it (`manifest`).
      if (release.manifest) files.set(`https://api.github.com/repos/${repository}/contents/kit.json?ref=${encodeURIComponent(tag)}`, Buffer.from(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(release.manifest)).toString('base64') })))
      const archives = {}
      for (const platform of release.platforms ?? []) {
        const bytes = Buffer.from(`${kit} ${release.version} ${platform}`)
        add(`kition-${kit}-${release.version}-${platform}.tar.gz`, bytes, !release.noDigest)
        archives[platform] = { url: download(repository, tag, `kition-${kit}-${release.version}-${platform}.tar.gz`), size: bytes.length, sha256: sha256(bytes) }
      }
      if (release.fragment !== false) {
        const listedPlatforms = release.fragment ?? release.platforms ?? []
        const fragment = {
          schemaVersion: 1,
          kits: {
            [kit]: {
              id: `kit.${kit}`,
              name: release.name ?? name,
              extensions: release.extensions ?? extensions,
              versions: { [release.version]: { protocol: release.protocol ?? 'kition-kit/2', platforms: Object.fromEntries(listedPlatforms.map((p) => [p, archives[p]])) } },
            },
          },
        }
        release.edit?.(fragment)
        add(`kits-index-${kit}-${release.version}.json`, Buffer.from(JSON.stringify(fragment)))
      }
      listed.push({ tag_name: tag, draft: Boolean(release.draft), prerelease: false, assets })
      release.remove?.(assets)
    }
    // Newest first, as the API lists them.
    lists.set(repository, listed.reverse())
  }
  const seen = []
  const net = async (url, { as = 'json' } = {}) => {
    seen.push(url)
    if (fail.some((pattern) => url.includes(pattern))) throw new Error(`${url}: HTTP 500`)
    const page = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\?per_page=(\d+)&page=(\d+)$/)
    if (page) {
      const all = lists.get(page[1])
      if (!all) throw new Error(`${url}: HTTP 404 Not Found`)
      const perPage = Number(page[2])
      const start = (Number(page[3]) - 1) * perPage
      return all.slice(start, start + perPage)
    }
    const bytes = files.get(url)
    if (!bytes) throw new Error(`${url}: HTTP 404`)
    return as === 'bytes' ? bytes : JSON.parse(bytes.toString('utf8'))
  }
  return { net, seen }
}

const ALL = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
const kitsOf = (repos) => Object.entries(repos).map(([repository, { kit }]) => ({ kit, repository })).sort((a, b) => a.kit.localeCompare(b.kit))

describe('kits-index: the kit index gathered from the kit repositories', () => {
  it('merges each kit’s fragments into one index valid against the schema, at the kit repositories’ addresses', async () => {
    const repos = {
      'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.4.0', platforms: ALL }, { version: '0.5.4', platforms: ALL, extensions: ['ktable', 'csv'] }] },
      'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ['linux-x64', 'darwin-arm64'] }] },
    }
    const { net } = fakeGithub(repos)
    const { index, report } = await gatherIndex({ kits: kitsOf(repos), net })
    expect(schemaProblems(index)).toEqual([])
    expect(Object.keys(index.kits)).toEqual(['note', 'table'])
    expect(Object.keys(index.kits.table.versions)).toEqual(['0.4.0', '0.5.4'])
    // The newest version's fragment names the kit.
    expect(index.kits.table).toMatchObject({ id: 'kit.table', name: 'Table', extensions: ['ktable', 'csv'] })
    expect(index.kits.note.versions['0.1.0']).toEqual({
      protocol: 'kition-kit/2',
      platforms: {
        'darwin-arm64': { url: 'https://github.com/KitionAI/kition-note/releases/download/package-v0.1.0/kition-note-0.1.0-darwin-arm64.tar.gz', size: Buffer.from('note 0.1.0 darwin-arm64').length, sha256: sha256(Buffer.from('note 0.1.0 darwin-arm64')) },
        'linux-x64': expect.objectContaining({ url: 'https://github.com/KitionAI/kition-note/releases/download/package-v0.1.0/kition-note-0.1.0-linux-x64.tar.gz' }),
      },
      ui: { url: 'https://github.com/KitionAI/kition-note/releases/download/package-v0.1.0/kition-note-0.1.0.tgz', size: Buffer.from('note package 0.1.0').length, sha256: sha256(Buffer.from('note package 0.1.0')) },
    })
    expect(report.map(({ kit, versions, skipped }) => [kit, versions, skipped])).toEqual([['note', ['0.1.0'], []], ['table', ['0.4.0', '0.5.4'], []]])
  })

  it('lists the extensions a kit only views, from the kit.json at its newest version’s tag, and none when it cannot be read', async () => {
    const formats = [
      { id: 'xlsx', extensions: ['xlsx'], role: 'edit' },
      { id: 'csv', extensions: ['csv', '.ODS', 'xlsx'], role: 'view' },
    ]
    const repos = {
      'KitionAI/kition-sheet': { kit: 'sheet', extensions: ['xlsx'], releases: [{ version: '0.1.0', platforms: ALL, manifest: { formats: [] } }, { version: '0.1.1', platforms: ALL, manifest: { formats } }] },
      'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ALL }] },
    }
    const { net, seen } = fakeGithub(repos)
    const gathered = await gatherIndex({ kits: kitsOf(repos), net })
    const { index, report } = gathered
    expect(schemaProblems(index)).toEqual([])
    expect(index.kits.sheet.views).toEqual(['csv', 'ods'])
    expect(seen).toContain('https://api.github.com/repos/KitionAI/kition-sheet/contents/kit.json?ref=package-v0.1.1')
    // No kit.json to read: no views, and the report says so.
    expect(index.kits.note.views).toBeUndefined()
    expect(report.find((entry) => entry.kit === 'note').viewsUnread).toBe(true)
    expect(reportLines(gathered)).toContain("  no views: its kit.json at the newest version's tag cannot be read")
    expect(reportLines(gathered).filter((line) => line.includes('no views'))).toHaveLength(1)
  })

  it('gives the same bytes for the same Releases, whatever order they are listed in', async () => {
    const repos = (order) => ({ 'KitionAI/kition-table': { kit: 'table', releases: order.map((version) => ({ version, platforms: [...ALL].reverse() })) } })
    const a = await gatherIndex({ kits: kitsOf(repos(['0.4.0', '0.10.0', '0.5.1'])), net: fakeGithub(repos(['0.4.0', '0.10.0', '0.5.1'])).net })
    const b = await gatherIndex({ kits: kitsOf(repos(['0.10.0', '0.5.1', '0.4.0'])), net: fakeGithub(repos(['0.10.0', '0.5.1', '0.4.0'])).net })
    expect(serialize(a.index)).toBe(serialize(b.index))
    expect(Object.keys(a.index.kits.table.versions)).toEqual(['0.4.0', '0.5.1', '0.10.0'])
    expect(Object.keys(a.index.kits.table.versions['0.4.0'].platforms)).toEqual(ALL)
    expect(serialize(a.index).endsWith('}\n')).toBe(true)
  })

  it('takes the kit’s name from its newest version and each version’s own protocol', async () => {
    const repos = { 'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.2.0', platforms: ['linux-x64'], name: 'Old', protocol: 'kition-kit/1' }, { version: '0.1.0', platforms: ['linux-x64'], name: 'Older' }, { version: '1.0.0', platforms: ['linux-x64'], name: 'Note' }] } }
    const { index } = await gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })
    expect(index.kits.note.name).toBe('Note')
    expect(index.kits.note.versions['0.2.0'].protocol).toBe('kition-kit/1')
    expect(index.kits.note.versions['1.0.0'].protocol).toBe('kition-kit/2')
  })

  it('skips and names a Release without a fragment, drafts, and other tags; a kit with no fragment stays out', async () => {
    const repos = {
      'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.4.0', platforms: ALL, fragment: false }, { version: '0.5.0', platforms: ALL }, { version: '0.6.0', platforms: ALL, draft: true }, { tag: 'v9', version: '9.0.0', platforms: [] }] },
      'KitionAI/kition-cad': { kit: 'cad', releases: [{ version: '0.1.0', platforms: [], fragment: false }] },
    }
    const { index, report } = await gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })
    expect(Object.keys(index.kits)).toEqual(['table'])
    expect(Object.keys(index.kits.table.versions)).toEqual(['0.5.0'])
    expect(report.find((entry) => entry.kit === 'table').skipped).toEqual([{ tag: 'package-v0.4.0', why: 'no kits-index-table-0.4.0.json' }])
    expect(report.find((entry) => entry.kit === 'cad')).toMatchObject({ versions: [], skipped: [{ tag: 'package-v0.1.0', why: 'no kits-index-cad-0.1.0.json' }] })
  })

  it('adds an archive the Release holds and its fragment does not list, from the asset’s digest or, without one, by hashing it', async () => {
    const repos = {
      'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ALL, fragment: ['linux-x64'] }] },
      'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ['linux-x64', 'win32-x64'], fragment: ['linux-x64'], noDigest: true }] },
    }
    const { net, seen } = fakeGithub(repos)
    const { index, report } = await gatherIndex({ kits: kitsOf(repos), net })
    expect(Object.keys(index.kits.table.versions['0.5.4'].platforms)).toEqual(ALL)
    const added = Buffer.from('table 0.5.4 win32-x64')
    expect(index.kits.table.versions['0.5.4'].platforms['win32-x64']).toEqual({ url: download('KitionAI/kition-table', 'package-v0.5.4', 'kition-table-0.5.4-win32-x64.tar.gz'), size: added.length, sha256: sha256(added) })
    expect(report.find((entry) => entry.kit === 'table').added.map(({ platform }) => platform)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'win32-x64'])
    // Table's digests are used; Note's archives have none, so they are downloaded and hashed.
    expect(seen.filter((url) => url.endsWith('.tar.gz'))).toEqual([download('KitionAI/kition-note', 'package-v0.1.0', 'kition-note-0.1.0-linux-x64.tar.gz'), download('KitionAI/kition-note', 'package-v0.1.0', 'kition-note-0.1.0-win32-x64.tar.gz')])
    expect(index.kits.note.versions['0.1.0'].platforms['win32-x64'].sha256).toBe(sha256(Buffer.from('note 0.1.0 win32-x64')))
  })

  it('stops when a fragment names an archive the Release no longer holds, or one whose size or SHA-256 differs', async () => {
    const run = (release) => {
      const repos = { 'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64', 'win32-x64'], ...release }] } }
      return gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })
    }
    await expect(run({ remove: (assets) => assets.splice(assets.findIndex((a) => a.name.endsWith('win32-x64.tar.gz')), 1) })).rejects.toThrow(/lists kition-table-0\.5\.4-win32-x64\.tar\.gz, which the Release does not hold/)
    await expect(run({ edit: (f) => { f.kits.table.versions['0.5.4'].platforms['linux-x64'].size += 1 } })).rejects.toThrow(/says kition-table-0\.5\.4-linux-x64\.tar\.gz is \d+ bytes; the Release's is/)
    await expect(run({ edit: (f) => { f.kits.table.versions['0.5.4'].platforms['linux-x64'].sha256 = 'a'.repeat(64) } })).rejects.toThrow(/SHA-256 a{64}; the Release's is/)
    await expect(run({ noDigest: true, edit: (f) => { f.kits.table.versions['0.5.4'].platforms['linux-x64'].sha256 = 'a'.repeat(64) } })).rejects.toThrow(/the Release's is/)
    await expect(run({ edit: (f) => { f.kits.table.versions['0.5.4'].platforms['linux-x64'].url = 'https://example.com/x.tar.gz' } })).rejects.toThrow(/gives linux-x64 the address https:\/\/example\.com/)
  })

  it('adds each version’s editor package from the Release, its SHA-256 from its entry checked against the asset and GitHub’s digest', async () => {
    const repos = {
      'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'] }, { version: '0.5.5', platforms: ['linux-x64'], editor: false }] },
      'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ['linux-x64'], editor: { entry: false } }, { version: '0.2.0', platforms: ['linux-x64'], editor: { entry: false, noDigest: true } }] },
    }
    const { net, seen } = fakeGithub(repos)
    const gathered = await gatherIndex({ kits: kitsOf(repos), net })
    const { index } = gathered
    expect(schemaProblems(index)).toEqual([])
    const bytes = (kit, version) => Buffer.from(`${kit} package ${version}`)
    expect(index.kits.table.versions['0.5.4'].ui).toEqual({ url: download('KitionAI/kition-table', 'package-v0.5.4', 'kition-table-0.5.4.tgz'), size: bytes('table', '0.5.4').length, sha256: sha256(bytes('table', '0.5.4')) })
    // A Release without the package lists the version without it, and the report names it.
    expect('ui' in index.kits.table.versions['0.5.5']).toBe(false)
    expect(reportLines(gathered)).toContain('  no editor package: 0.5.5')
    // Without an entry: GitHub's digest; without either: the package downloaded and hashed.
    expect(index.kits.note.versions['0.1.0'].ui.sha256).toBe(sha256(bytes('note', '0.1.0')))
    expect(index.kits.note.versions['0.2.0'].ui.sha256).toBe(sha256(bytes('note', '0.2.0')))
    expect(seen.filter((url) => url.endsWith('.tgz'))).toEqual([download('KitionAI/kition-note', 'package-v0.2.0', 'kition-note-0.2.0.tgz')])
    // The serialized index keeps it, in its place after the platforms.
    expect(Object.keys(JSON.parse(serialize(index)).kits.table.versions['0.5.4'])).toEqual(['protocol', 'platforms', 'ui'])
  })

  it('stops when an editor package’s entry disagrees with the Release: another asset, another size, another SHA-256 than GitHub’s digest', async () => {
    const run = (edit) => {
      const repos = { 'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'], editor: { edit } }] } }
      return gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })
    }
    await expect(run((entry) => { entry.asset = 'kition-table-0.5.3.tgz' })).rejects.toThrow(/is the entry of "kition-table-0\.5\.3\.tgz", not kition-table-0\.5\.4\.tgz/)
    await expect(run((entry) => { entry.size += 1 })).rejects.toThrow(/says kition-table-0\.5\.4\.tgz is \d+ bytes; the Release's is/)
    await expect(run((entry) => { entry.sha256 = 'a'.repeat(64) })).rejects.toThrow(/gives kition-table-0\.5\.4\.tgz the SHA-256 a{64}; GitHub's digest is/)
    await expect(run((entry) => { delete entry.sha256 })).rejects.toThrow(/gives no SHA-256/)
    // A fragment that names an editor package must name the Release's.
    const repos = { 'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'], edit: (f) => { f.kits.table.versions['0.5.4'].ui = { url: 'https://example.com/x.tgz', size: 1, sha256: 'a'.repeat(64) } } }] } }
    await expect(gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })).rejects.toThrow(/gives the editor package .*example\.com.*; the Release's is/)
  })

  it('stops on a fragment that is not a kit index of that one kit version', async () => {
    const run = (edit) => {
      const repos = { 'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'], edit }] } }
      return gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos).net })
    }
    await expect(run((f) => { f.schemaVersion = 2 })).rejects.toThrow(/is not a kit index:\n.*schemaVersion/)
    await expect(run((f) => { f.kits.note = structuredClone(f.kits.table); f.kits.note.id = 'kit.note' })).rejects.toThrow(/holds table, note, not table alone/)
    await expect(run((f) => { f.kits.table.versions['0.5.5'] = f.kits.table.versions['0.5.4'] })).rejects.toThrow(/holds table 0\.5\.4, 0\.5\.5, not 0\.5\.4 alone/)
    await expect(run((f) => { f.kits.table.id = 'kit.tables' })).rejects.toThrow(/does not match|not kit\.table/)
  })

  it('stops when a repository cannot be listed or a fragment cannot be read, instead of writing a smaller index', async () => {
    const repos = {
      'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'] }] },
      'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ['linux-x64'] }] },
    }
    await expect(gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos, { fail: ['repos/KitionAI/kition-note/releases'] }).net })).rejects.toThrow(/the Releases of KitionAI\/kition-note cannot be listed: .*HTTP 500/)
    await expect(gatherIndex({ kits: [...kitsOf(repos), { kit: 'cad', repository: 'KitionAI/kition-cad' }], net: fakeGithub(repos).net })).rejects.toThrow(/KitionAI\/kition-cad cannot be listed: .*404/)
    await expect(gatherIndex({ kits: kitsOf(repos), net: fakeGithub(repos, { fail: ['kits-index-note-0.1.0.json'] }).net })).rejects.toThrow(/kits-index-note-0\.1\.0\.json cannot be read/)
  })

  it('reads every page of a repository’s Releases', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ version: `1.${i}.0`, platforms: ['linux-x64'] }))
    const repos = { 'KitionAI/kition-table': { kit: 'table', releases: many } }
    const { net, seen } = fakeGithub(repos)
    const { index } = await gatherIndex({ kits: kitsOf(repos), net })
    expect(seen.filter((url) => url.includes('/releases?'))).toEqual([`${API}/repos/KitionAI/kition-table/releases?per_page=100&page=1`, `${API}/repos/KitionAI/kition-table/releases?per_page=100&page=2`])
    expect(Object.keys(index.kits.table.versions).length).toBe(101)
  })

  it('reads the kits and repositories of Kition’s modules.json', () => {
    expect(kitsOfModules({ $comment: 'x', table: { repository: 'KitionAI/kition-table' }, html: { repository: 'KitionAI/kition-html', optional: true } })).toEqual([
      { kit: 'html', repository: 'KitionAI/kition-html' },
      { kit: 'table', repository: 'KitionAI/kition-table' },
    ])
    expect(() => kitsOfModules({ table: {} })).toThrow(/names no repository/)
    expect(() => kitsOfModules({ $comment: 'x' })).toThrow(/names no kit/)
  })

  it('sends a token to the GitHub API only, and fails on an error answer', async () => {
    const calls = []
    const fetchImpl = async (url, { headers }) => {
      calls.push({ url, auth: headers.Authorization })
      if (url.includes('missing')) return new Response('Not Found', { status: 404 })
      return new Response(url.endsWith('.tar.gz') ? 'bytes' : '[]', { status: 200 })
    }
    const net = githubNet({ token: 't0ken', fetchImpl })
    expect(await net(`${API}/repos/a/b/releases?per_page=100&page=1`)).toEqual([])
    expect((await net('https://github.com/a/b/releases/download/t/x.tar.gz', { as: 'bytes' })).toString()).toBe('bytes')
    expect(calls.map(({ auth }) => auth)).toEqual(['Bearer t0ken', undefined])
    await expect(net(`${API}/repos/a/missing/releases`)).rejects.toThrow(/HTTP 404 Not Found/)
    const anonymous = githubNet({ token: '', fetchImpl })
    await anonymous(`${API}/repos/a/b/releases?per_page=100&page=1`)
    expect(calls.at(-1).auth).toBeUndefined()
  })
})

describe('kits-index: the command line', () => {
  const modules = { note: { repository: 'KitionAI/kition-note' }, table: { repository: 'KitionAI/kition-table' } }
  const repos = {
    'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: ['linux-x64'] }] },
    'KitionAI/kition-note': { kit: 'note', releases: [{ version: '0.1.0', platforms: ['linux-x64'] }] },
  }
  const withModules = (net) => async (url, options) => (url === MODULES_URL ? modules : net(url, options))
  const capture = () => {
    const text = { out: '', err: '' }
    return { text, out: (t) => { text.out += t }, err: (t) => { text.err += t } }
  }

  it('writes the index with --out, compares it with --previous, and writes nothing with --dry-run', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'kits-index.json')
    const io = capture()
    expect(await main(['--out', file], { net: withModules(fakeGithub(repos).net), ...io })).toBe(0)
    const written = fs.readFileSync(file, 'utf8')
    expect(Object.keys(JSON.parse(written).kits)).toEqual(['note', 'table'])
    expect(io.text.out).toMatch(/kits-index\.json: 2 of 2 kits \(note 0\.1\.0; table 0\.5\.4\); 0 Releases skipped/)

    const previous = path.join(dir, 'previous.json')
    const old = JSON.parse(written)
    old.kits.note.versions['0.3.0'] = old.kits.note.versions['0.1.0']
    fs.writeFileSync(previous, JSON.stringify(old))
    const dry = capture()
    expect(await main(['--dry-run', '--previous', previous], { net: withModules(fakeGithub(repos).net), ...dry })).toBe(0)
    expect(dry.text.out).toContain('0 archives enter, 2 leave')
    expect(dry.text.out).toContain('  - note 0.3.0 linux-x64')
    expect(dry.text.out).toContain('  - note 0.3.0 ui')
    expect(fs.readdirSync(dir).sort()).toEqual(['kits-index.json', 'previous.json'])
  })

  it('writes no index that would be empty, and says so with its own exit status', async () => {
    const dir = tempDir()
    const empty = { 'KitionAI/kition-table': { kit: 'table', releases: [{ version: '0.5.4', platforms: [], fragment: false }] }, 'KitionAI/kition-note': { kit: 'note', releases: [] } }
    const io = capture()
    expect(await main(['--out', path.join(dir, 'kits-index.json')], { net: withModules(fakeGithub(empty).net), ...io })).toBe(EMPTY)
    expect(io.text.out).toMatch(/skipped package-v0\.5\.4: no kits-index-table-0\.5\.4\.json/)
    expect(io.text.out).toMatch(/kits-index\.json would be empty: none of the 2 kits has a Release with a fragment \(1 Releases skipped\); nothing is written/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('fails without writing when a repository cannot be listed, and refuses a wrong command line', async () => {
    const dir = tempDir()
    const io = capture()
    expect(await main(['--out', path.join(dir, 'x.json')], { net: withModules(fakeGithub(repos, { fail: ['kition-note/releases'] }).net), ...io })).toBe(1)
    expect(io.text.err).toMatch(/^kits-index: the Releases of KitionAI\/kition-note cannot be listed/)
    expect(fs.readdirSync(dir)).toEqual([])
    expect(await main([], capture())).toBe(2)
    expect(await main(['--out', 'x', '--dry-run'], capture())).toBe(2)
    expect(await main(['--dry-run', '--bogus'], capture())).toBe(2)
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
    expect(() => schemaProblems('x', { maxLength: 3 })).toThrow(/keyword maxLength is not checked/)
  })
})

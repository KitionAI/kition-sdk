// tools/readme-shots/shots.mjs: the parts that need no browser. Which shots a command line takes,
// the size report and its 400 KB flag, the development host's address, and how Playwright and
// Vite are found in the kit's web/ rather than in kition-sdk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PICTURE_BYTES, VIEWPORT, hostUrl, kilobytes, moduleEntry, selectShots, sizeLines, sizeReport, takeShots } from './shots.mjs'

const dirs = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A project folder (a package.json) with `packages` installed in its node_modules: name -> { package.json fields, files }. */
function project(packages = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "web", "private": true, "type": "module" }\n')
  for (const [name, { files = {}, ...manifest }] of Object.entries(packages)) {
    const root = path.join(dir, 'node_modules', name)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), text)
    }
  }
  return dir
}

const SHOTS = [{ name: 'hero' }, { name: 'comments' }, { name: 'find-outline' }]

describe('selectShots', () => {
  it('takes every shot with no names, and only the named ones, in the shots\' order, with names', () => {
    expect(selectShots(SHOTS, []).map((shot) => shot.name)).toEqual(['hero', 'comments', 'find-outline'])
    expect(selectShots(SHOTS, ['find-outline', 'hero']).map((shot) => shot.name)).toEqual(['hero', 'find-outline'])
  })

  it('refuses a name no shot has, saying which there are', () => {
    expect(() => selectShots(SHOTS, ['hero', 'heros'])).toThrow('no shot named heros; the shots are hero, comments, find-outline')
  })

  it('refuses a shot name that cannot name its file, and two shots with one name', () => {
    expect(() => selectShots([{ name: 'Hero shot' }], [])).toThrow("a shot's name is lower case letters, digits and dashes")
    expect(() => selectShots([{ name: 'hero.png' }], [])).toThrow('"hero.png"')
    expect(() => selectShots([{}], [])).toThrow('undefined')
    expect(() => selectShots([{ name: 'hero' }, { name: 'hero' }], [])).toThrow('two shots are named hero')
  })
})

describe('the size report', () => {
  it('gives each file its size and flags one over 400 KB, not one at exactly 400 KB', () => {
    expect(MAX_PICTURE_BYTES).toBe(400 * 1024)
    const report = sizeReport([
      { file: 'assets/readme/hero.png', bytes: 400 * 1024 },
      { file: 'assets/readme/comments.png', bytes: 400 * 1024 + 1 },
      { file: 'assets/readme/table.png', bytes: 1 },
    ])
    expect(report.map(({ file, over }) => [file, over])).toEqual([
      ['assets/readme/hero.png', false],
      ['assets/readme/comments.png', true],
      ['assets/readme/table.png', false],
    ])
    expect(sizeLines(report)).toEqual([
      'assets/readme/hero.png       400 KB',
      'assets/readme/comments.png   401 KB  OVER 400 KB',
      'assets/readme/table.png        1 KB',
      '1 picture is over 400 KB; shrink with pngquant --quality 70-90 (a README picture is at most 400 KB)',
    ])
    expect(sizeLines(sizeReport([{ file: 'a.png', bytes: 10 }, { file: 'b.png', bytes: 11 }], 10), 10).at(-1)).toBe(
      '1 picture is over 1 KB; shrink with pngquant --quality 70-90 (a README picture is at most 1 KB)',
    )
    expect(sizeLines([])).toEqual([])
    expect(kilobytes(0)).toBe('0 KB')
    expect(kilobytes(1025)).toBe('2 KB')
  })
})

describe('the development host', () => {
  it('is opened in English at 1440 × 900 unless the kit says otherwise', () => {
    expect(VIEWPORT).toEqual({ width: 1440, height: 900 })
    expect(hostUrl('http://127.0.0.1:5173', 'dev.html')).toBe('http://127.0.0.1:5173/dev.html?locale=en-US')
    expect(hostUrl('http://127.0.0.1:5173', 'dev.html', { files: '1' })).toBe('http://127.0.0.1:5173/dev.html?locale=en-US&files=1')
  })
})

describe('moduleEntry', () => {
  it("finds a package's ES module entry in the kit's node_modules: exports conditions, an exports string, module, main", () => {
    const web = project({
      playwright: { exports: { '.': { types: './index.d.ts', import: './index.mjs', require: './index.js', default: './index.js' }, './package.json': './package.json' } },
      vite: { exports: { '.': './dist/node/index.js', './package.json': './package.json' } },
      nested: { exports: { '.': { node: { import: './node.mjs' }, default: './browser.js' } } },
      flat: { exports: { import: './flat.mjs', require: './flat.cjs' } },
      old: { module: './esm/index.js', main: './cjs/index.js' },
      plain: {},
    })
    const at = (name, file) => path.join(fs.realpathSync(web), 'node_modules', name, file)
    expect(fs.realpathSync(path.dirname(moduleEntry(web, 'playwright')))).toBe(path.dirname(at('playwright', 'index.mjs')))
    expect(path.basename(moduleEntry(web, 'playwright'))).toBe('index.mjs')
    expect(moduleEntry(web, 'vite').endsWith(path.join('vite', 'dist', 'node', 'index.js'))).toBe(true)
    expect(path.basename(moduleEntry(web, 'nested'))).toBe('node.mjs')
    expect(path.basename(moduleEntry(web, 'flat'))).toBe('flat.mjs')
    expect(moduleEntry(web, 'old').endsWith(path.join('old', 'esm', 'index.js'))).toBe(true)
    expect(moduleEntry(web, 'plain').endsWith(path.join('plain', 'index.js'))).toBe(true)
  })

  it('does not fall back to kition-sdk\'s own packages: a package the kit has not installed is an error', () => {
    // kition-sdk's root has vite installed, and vitest's pnpm bin puts kition-sdk's store on NODE_PATH;
    // the kit's web/ here has none.
    expect(() => moduleEntry(project(), 'vite')).toThrow('vite is not installed in')
  })
})

describe('takeShots', () => {
  it('refuses a web/ without a package.json and a sample that is neither a file nor a function, before starting anything', async () => {
    const web = project()
    await expect(takeShots({ web: path.join(web, 'missing'), sample: 'x', shots: SHOTS, names: [] })).rejects.toThrow("web must be the kit's web/ directory")
    await expect(takeShots({ web, sample: path.join(web, 'none.md'), shots: SHOTS, names: [] })).rejects.toThrow('sample must be a file or a function')
    await expect(takeShots({ web, sample: path.join(web, 'package.json'), shots: SHOTS, names: ['nope'] })).rejects.toThrow('no shot named nope')
  })
})

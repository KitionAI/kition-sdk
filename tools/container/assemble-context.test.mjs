import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { KIT_NAMES } from '../kit-naming.mjs'
import { assemble, checkElf } from './assemble-context.mjs'

const temporary = []
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-container-'))
  temporary.push(dir)
  const sdkRoot = path.join(dir, 'sdk')
  function write(relative, bytes, mode = 0o644) {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes, { mode })
    return file
  }
  for (const file of ['Cargo.toml', 'Cargo.lock', 'crates/demo/src/lib.rs', 'examples/grid-kit/Cargo.toml', 'examples/grid-kit-headless/Cargo.toml', 'tools/container/Dockerfile', 'tools/container/entrypoint.sh']) write(`sdk/${file}`, file)
  write('sdk/.env', 'must not ship')
  write('sdk/crates/demo/target/private', 'must not ship')
  const target = 'x86_64-unknown-linux-gnu'
  const elf = Buffer.alloc(20)
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
  elf.writeUInt16LE(62, 18)
  for (const name of Object.keys(KIT_NAMES)) {
    write(`repos/kition-${name}/kit.json`, JSON.stringify({ id: `kit.${name}`, headless: { executable: `kition-${name}` } }))
    write(`repos/kition-${name}/target/${target}/release/kition-${name}`, elf, 0o755)
  }
  return { dir, write, options: { sdkRoot, repos: path.join(dir, 'repos'), out: path.join(dir, 'context'), target } }
}

it('assembles every canonical kit and selected SDK sources, preserving asset paths and executable modes', () => {
  const { dir, write, options } = fixture()
  write('assets/doc/resources/font.dat', 'font')
  const result = assemble({ ...options, assets: path.join(dir, 'assets') })
  expect(result).toEqual({ kits: Object.keys(KIT_NAMES).sort(), platform: 'linux/amd64' })
  expect(fs.readdirSync(path.join(options.out, 'bundles')).sort()).toEqual(Object.keys(KIT_NAMES).sort())
  for (const name of result.kits) {
    const from = path.join(options.repos, `kition-${name}`)
    const to = path.join(options.out, 'bundles', name)
    expect(fs.readFileSync(path.join(to, 'kit.json'))).toEqual(fs.readFileSync(path.join(from, 'kit.json')))
    expect(fs.readFileSync(path.join(to, `kition-${name}`))).toEqual(fs.readFileSync(path.join(from, 'target', options.target, 'release', `kition-${name}`)))
    expect(fs.statSync(path.join(to, `kition-${name}`)).mode & 0o111).toBe(0o111)
  }
  expect(fs.readFileSync(path.join(options.out, 'bundles/doc/resources/font.dat'), 'utf8')).toBe('font')
  expect(fs.existsSync(path.join(options.out, 'sdk/.env'))).toBe(false)
  expect(fs.existsSync(path.join(options.out, 'sdk/crates/demo/target'))).toBe(false)
  expect(() => assemble(options)).toThrow('output already exists')
})

it('refuses a missing kit or wrong architecture before making a context', () => {
  const { options } = fixture()
  const binary = path.join(options.repos, 'kition-doc', 'target', options.target, 'release/kition-doc')
  expect(() => checkElf(binary, 'aarch64-unknown-linux-gnu')).toThrow('expected a 64-bit')
  fs.writeFileSync(binary, 'Mach-O is not Linux')
  expect(() => assemble(options)).toThrow('expected a 64-bit')
  expect(fs.existsSync(options.out)).toBe(false)
  fs.unlinkSync(binary)
  expect(() => assemble(options)).toThrow()
  expect(fs.existsSync(options.out)).toBe(false)
})

it('refuses assets that replace bundle identity or link outside the bundle', () => {
  const { dir, write, options } = fixture()
  const assets = path.join(dir, 'assets')
  const manifest = write('assets/board/kit.json', '{}')
  expect(() => assemble({ ...options, assets })).toThrow('assets must not replace')
  fs.unlinkSync(manifest)
  fs.rmSync(options.out, { recursive: true })
  const secret = write('outside', 'private')
  fs.symlinkSync(secret, path.join(assets, 'board/leak'))
  expect(() => assemble({ ...options, assets })).toThrow('symlink is not allowed')
})

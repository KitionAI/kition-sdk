#!/usr/bin/env node
// Copies existing outputs only. Never builds or launches a kit.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KIT_NAMES } from '../kit-naming.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const targets = Object.freeze({
  'x86_64-unknown-linux-gnu': { machine: 62, platform: 'linux/amd64' },
  'aarch64-unknown-linux-gnu': { machine: 183, platform: 'linux/arm64' },
})

export function checkElf(file, target) {
  const header = Buffer.alloc(20)
  const fd = fs.openSync(file, 'r')
  try {
    if (fs.readSync(fd, header, 0, 20, 0) !== 20
      || header.subarray(0, 4).toString('hex') !== '7f454c46'
      || header[4] !== 2 || header[5] !== 1
      || header.readUInt16LE(18) !== targets[target]?.machine) {
      throw new Error(`${path.basename(file)}: expected a 64-bit little-endian ELF for ${target}`)
    }
  } finally { fs.closeSync(fd) }
}

// Symlinks are rejected so a bundle cannot pull private files from outside it.
function copyTree(from, to) {
  const stat = fs.lstatSync(from)
  if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${path.basename(from)}`)
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true })
    for (const name of fs.readdirSync(from).sort()) {
      if (['.git', 'target', 'node_modules'].includes(name)) continue
      copyTree(path.join(from, name), path.join(to, name))
    }
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to)
    fs.chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644)
  } else throw new Error(`not a regular file: ${path.basename(from)}`)
}

export function assemble({ sdkRoot = root, repos = path.dirname(sdkRoot), out, target, assets }) {
  if (!Object.hasOwn(targets, target)) throw new Error('give --target x86_64-unknown-linux-gnu or aarch64-unknown-linux-gnu')
  if (!out) throw new Error('give --out <new-directory>')
  const destination = path.resolve(out)
  if (fs.existsSync(destination)) throw new Error('output already exists; choose a new directory')
  // Validate every kit before creating output: a missing kit is never silently omitted.
  const kits = Object.keys(KIT_NAMES).sort().map((name) => {
    const repo = path.join(repos, `kition-${name}`)
    const manifest = path.join(repo, 'kit.json')
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (json.id !== `kit.${name}` || json.headless?.executable !== `kition-${name}`) {
      throw new Error(`${name}: kit.json must declare kit.${name} and headless.executable kition-${name}`)
    }
    const binary = path.join(repo, 'target', target, 'release', json.headless.executable)
    checkElf(binary, target)
    if (!(fs.statSync(binary).mode & 0o111)) throw new Error(`${name}: binary is not executable`)
    return { name, manifest, binary }
  })
  fs.mkdirSync(destination, { recursive: true })
  for (const item of ['Cargo.toml', 'Cargo.lock', 'crates', 'examples/grid-kit', 'examples/grid-kit-headless']) {
    const to = path.join(destination, 'sdk', item)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    copyTree(path.join(sdkRoot, item), to)
  }
  for (const kit of kits) {
    const to = path.join(destination, 'bundles', kit.name)
    fs.mkdirSync(to, { recursive: true })
    // Optional already-staged runtime assets retain their relative bundle paths.
    if (assets && fs.existsSync(path.join(assets, kit.name))) {
      const supplied = path.join(assets, kit.name)
      if (fs.existsSync(path.join(supplied, 'kit.json')) || fs.existsSync(path.join(supplied, `kition-${kit.name}`))) {
        throw new Error(`${kit.name}: assets must not replace kit.json or the executable`)
      }
      copyTree(supplied, to)
    }
    copyTree(kit.manifest, path.join(to, 'kit.json'))
    copyTree(kit.binary, path.join(to, `kition-${kit.name}`))
  }
  for (const item of ['Dockerfile', 'entrypoint.sh']) copyTree(path.join(sdkRoot, 'tools', 'container', item), path.join(destination, item))
  return { kits: kits.map((kit) => kit.name), platform: targets[target].platform }
}

function main(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = { '--repos': 'repos', '--out': 'out', '--target': 'target', '--assets': 'assets' }[argv[i]]
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`unknown or incomplete option: ${argv[i]}`)
    options[key] = argv[++i]
  }
  const result = assemble(options)
  console.error(`Context ready: ${result.kits.length} kits; build with --platform ${result.platform}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}

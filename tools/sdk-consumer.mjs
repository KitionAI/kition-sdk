// @kition/sdk as a consumer installs it, for the checks that use it from outside the workspace
// (tools/smoke-sdk-package.mjs, tools/smoke-sdk-worker.mjs): its packed archive unpacked into
// <consumer>/node_modules/@kition/sdk, offline. Its dependency and peers are linked from the
// workspace (loro-crdt, React, their types), and its Tessera peer @kition/tessera from the folder
// `tessera` names (the built package in the kition-tessera checkout beside this one, or a folder npm
// installed it in), as npm serves it (its publishConfig exports, when it has them).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK, TESSERA } from './sdk-package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The arguments both smokes take: --archive <sdk.tgz> and --tessera <folder>; exits 2 when either is missing. */
export function consumerInputs(tool, args) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const archive = path.resolve(flag('--archive') ?? path.join(root, 'target/npm-pack/sdk.tgz'))
  if (!fs.existsSync(archive)) {
    console.error(`${tool}: ${path.relative(root, archive)} is missing; run node tools/pack-public-packages.mjs sdk first`)
    process.exit(2)
  }
  const tessera = path.resolve(flag('--tessera') ?? path.join(root, '..', 'kition-tessera/packages/tessera'))
  if (!fs.existsSync(path.join(tessera, 'package.json')) || !fs.existsSync(path.join(tessera, 'dist'))) {
    console.error(`${tool}: ${tessera} is not a built ${TESSERA} (no package.json or dist/); run pnpm build:packages in kition-tessera, or pass --tessera <folder>`)
    process.exit(2)
  }
  return { archive, tessera }
}

/** Installs the archive and its dependency and peers in `consumer`; answers { installed, manifest, ownTessera }. */
export function installSdk({ consumer, archive, tessera }) {
  const modules = path.join(consumer, 'node_modules')
  const installed = path.join(modules, SDK)
  // The package, as npm unpacks it.
  fs.mkdirSync(path.dirname(installed), { recursive: true })
  const unpack = fs.mkdtempSync(path.join(consumer, 'unpack-'))
  execFileSync('tar', ['-xzf', archive, '-C', unpack])
  fs.renameSync(path.join(unpack, 'package'), installed)
  fs.rmSync(unpack, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, SDK)

  // Its dependency and peers, linked: nothing is downloaded.
  const link = (target, name) => {
    const at = path.join(modules, name)
    fs.mkdirSync(path.dirname(at), { recursive: true })
    fs.symlinkSync(fs.realpathSync(target), at, 'dir')
  }
  link(path.join(root, 'packages/kdm/node_modules/loro-crdt'), 'loro-crdt')
  for (const name of ['react', 'react-dom', '@types/react', '@types/react-dom', '@types/node']) link(path.join(root, 'node_modules', name), name)
  // @kition/tessera as npm serves it: its files, and its publishConfig exports when it has them. A
  // rehearsal package (<scope>/tessera) is installed under the name @kition/tessera, as a consumer
  // aliases it; its own dependencies resolve from where it is.
  const ownTessera = JSON.parse(fs.readFileSync(path.join(tessera, 'package.json'), 'utf8'))
  const tesseraAt = path.join(modules, TESSERA)
  fs.mkdirSync(tesseraAt, { recursive: true })
  fs.writeFileSync(path.join(tesseraAt, 'package.json'), JSON.stringify({ ...ownTessera, exports: ownTessera.publishConfig?.exports ?? ownTessera.exports }, null, 2))
  for (const file of ownTessera.files) if (fs.existsSync(path.join(tessera, file))) fs.symlinkSync(path.join(tessera, file), path.join(tesseraAt, file))
  assert.ok(Object.keys(manifest.peerDependencies ?? {}).includes(TESSERA), `${SDK} names ${TESSERA} as a peer`)
  fs.writeFileSync(path.join(consumer, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n')
  return { installed, manifest, ownTessera }
}

/**
 * A kit editor's Vite configuration for `consumer`, as the kits that moved to @kition/sdk have it
 * (kition-html's web/vite.config.ts): relative base, one React, loro-crdt's browser entry for the
 * page, @kition/sdk and loro-crdt not pre-bundled, workers as modules.
 */
export const kitViteConfig = (consumer) => ({
  root: consumer,
  base: './',
  configFile: false,
  logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom'], alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/browser' }] },
  optimizeDeps: { exclude: [SDK, 'loro-crdt'] },
  worker: { format: 'es' },
  build: { outDir: path.join(consumer, 'dist'), emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 8192 },
})

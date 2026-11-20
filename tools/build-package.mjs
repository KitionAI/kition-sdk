#!/usr/bin/env node
// Shared public-package build; checkout exports remain useful to kit development.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import ts from 'typescript'
import { packageNoticeSection } from './bundled-notices.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = process.cwd()
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
const exports = manifest.exports
const entries = Object.fromEntries(Object.entries(exports).flatMap(([name, target]) => {
  if (typeof target !== 'string' || !target.endsWith('.ts')) return []
  return [[name === '.' ? 'index' : name.slice(2), path.resolve(directory, target)]]
}))
const hasConfig = fs.existsSync(path.join(directory, 'vite.config.ts'))
/** The directories of the npm packages whose code the bundles (workers included) contain. */
const bundled = new Set()
const recordBundled = () => ({
  name: 'kition-bundled-packages',
  generateBundle(_, bundle) {
    for (const chunk of Object.values(bundle)) {
      for (const id of Object.keys(chunk.modules ?? {})) {
        const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replace(/^\0/, ''))
        if (match) bundled.add(match[1])
      }
    }
  },
})
await build({
  root: directory,
  base: './',
  configFile: hasConfig ? path.join(directory, 'vite.config.ts') : false,
  plugins: [recordBundled()],
  worker: { format: 'es', plugins: () => [recordBundled()], rollupOptions: { output: { inlineDynamicImports: true } } },
  build: {
    sourcemap: false,
    ...(!hasConfig ? {
      target: 'es2022',
      lib: { entry: entries, formats: ['es'] },
      rollupOptions: { external: [/^@kition\//, /^node:/, /^react(?:-dom)?(?:\/|$)/, /^loro-crdt(?:\/|$)/], output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
    } : {}),
  },
})

for (const [name, target] of Object.entries(exports)) {
  if (typeof target !== 'string' || !/\.(?:css|html|mjs)$/.test(target)) continue
  const published = manifest.publishConfig.exports[name]
  const output = path.resolve(directory, typeof published === 'string' ? published : published.import)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.copyFileSync(path.resolve(directory, target), output)
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'dist/LICENSE'))
// @kition/cli carries the installers, so they are fetched from npm (or a CDN serving its files),
// as what they install is: dist/install.sh and dist/install.ps1 (docs/sdk/cli.md).
if (manifest.name === '@kition/cli') {
  for (const script of ['install.sh', 'install.ps1']) fs.copyFileSync(path.join(root, 'install', script), path.join(directory, 'dist', script))
}

// Bundled third-party code ships with its license: dist/THIRD_PARTY_NOTICES, one section per package.
// Each package's LICENSE, LICENSE-*, NOTICE and THIRD_PARTY_NOTICES files (tools/bundled-notices.mjs).
const notices = new Map()
for (const dir of bundled) {
  let section
  try {
    section = packageNoticeSection(dir)
  } catch (error) {
    throw new Error(`${manifest.name} bundles ${path.basename(dir)}: ${error.message}`)
  }
  notices.set(section.key, section.text)
}
if (notices.size) {
  const sections = [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => `${'-'.repeat(72)}\n${text}\n`)
  fs.writeFileSync(path.join(directory, 'dist/THIRD_PARTY_NOTICES'), `Third-party notices for ${manifest.name}\n\nThe files in dist/ include code from the packages below, each under its own license.\n\n${sections.join('\n')}`)
}

if (manifest.name === '@kition/embed') {
  execFileSync(process.execPath, ['scripts/build-types.mjs'], { stdio: 'inherit' })
} else if (fs.existsSync(path.join(directory, 'tsconfig.build.json'))) {
  execFileSync(process.execPath, [path.join(root, 'tools/package-types.mjs')], { stdio: 'inherit' })
} else {
  const paths = {}
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const dependency = JSON.parse(fs.readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8'))
    if (!dependency.types || dependency.name === manifest.name) continue
    paths[dependency.name] = [path.resolve(root, 'packages', name, dependency.types)]
    for (const [key, target] of Object.entries(dependency.publishConfig?.exports ?? {})) {
      if (key !== '.' && typeof target === 'object') paths[`${dependency.name}/${key.slice(2)}`] = [path.resolve(root, 'packages', name, target.types)]
    }
  }
  const config = ts.parseJsonConfigFileContent({
    extends: path.join(root, 'tsconfig.json'),
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, allowJs: true, checkJs: false, outDir: 'dist/types', rootDir: '.', paths, types: ['node', 'vite/client'] },
    include: ['src', 'kits'],
    exclude: ['**/*.test.*', '**/test/**', '**/fixtures/**'],
  }, ts.sys, directory)
  const program = ts.createProgram(config.fileNames, config.options)
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => directory, getNewLine: () => '\n' }))
    process.exit(1)
  }
  const emitted = program.emit()
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('declaration emission failed')
  // Declarations must also resolve in Node's module mode.
  for (const file of fs.readdirSync(path.join(directory, 'dist/types'), { recursive: true }).filter((file) => file.endsWith('.d.ts'))) {
    const output = path.join(directory, 'dist/types', file)
    const source = fs.readFileSync(output, 'utf8')
    const next = source.replace(/((?:from |import\()['"])(\.{1,2}\/[^'"]*)(['"])/g, (whole, lead, specifier, close) => {
      if (/\.(?:js|mjs)$/.test(specifier)) return whole
      const target = path.resolve(path.dirname(output), specifier)
      if (fs.existsSync(`${target}.d.ts`)) return `${lead}${specifier}.js${close}`
      if (fs.existsSync(path.join(target, 'index.d.ts'))) return `${lead}${specifier}/index.js${close}`
      throw new Error(`${output}: unresolved declaration ${specifier}`)
    })
    fs.writeFileSync(output, next)
  }
}

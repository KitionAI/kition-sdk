#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * The packages a module imports by a bare specifier (imports, re-exports, dynamic imports and
 * declaration imports; not relative, `#` imports, `node:`-style schemes or Node builtins), sorted.
 */
export function importedPackages(source) {
  const names = new Set()
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    if (/^(?:[./#]|[a-z]+:)/i.test(specifier) || isBuiltin(specifier)) continue
    names.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
  }
  return [...names].sort()
}

/** Check imports, re-exports, dynamic imports and declaration imports against a manifest. */
export function undeclaredImports(manifest, source, includeDevDependencies = false) {
  const declared = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
    ...(includeDevDependencies ? manifest.devDependencies : {}),
  }
  return importedPackages(source).filter((name) => name !== manifest.name && !Object.hasOwn(declared, name))
}

/**
 * An installed or unpacked package's own modules (`.js`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts` under
 * `dir`, its node_modules aside) against its package.json: { imported, undeclared }, every package
 * they import and each one neither a dependency, a peer, an optional dependency nor a Node builtin,
 * as `<file>: <package>`.
 */
export function packageFolderImports(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const imported = new Set()
  const undeclared = []
  for (const file of readdirSync(dir, { recursive: true })) {
    const relative = String(file).split(path.sep).join('/')
    if (relative.split('/').includes('node_modules') || !/\.(?:[cm]?js|d\.[cm]?ts)$/.test(relative)) continue
    const source = readFileSync(path.join(dir, file), 'utf8')
    for (const name of importedPackages(source)) if (name !== manifest.name) imported.add(name)
    for (const name of undeclaredImports(manifest, source)) undeclared.push(`${relative}: ${name}`)
  }
  return { imported: [...imported].sort(), undeclared: undeclared.sort() }
}

/** Source builds may bundle dev dependencies; emitted imports must be installed by consumers. */
export function auditPublicPackageImports(built = false) {
  const problems = []
  let packages = 0
  for (const directory of readdirSync(path.join(root, 'packages'))) {
    const base = path.join(root, 'packages', directory)
    const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'))
    if (manifest.private) continue
    packages++
    for (const area of built ? ['dist'] : ['src', 'kits', 'sandbox']) {
      const folder = path.join(base, area)
      if (!existsSync(folder)) {
        if (built) problems.push(`${manifest.name}: missing dist; build packages first`)
        continue
      }
      for (const file of readdirSync(folder, { recursive: true })) {
        if (!/\.(?:[cm]?js|tsx?)$/.test(file) || /(?:^|\/)(?:test|tests|fixtures)\/|\.test\./.test(file)) continue
        const source = readFileSync(path.join(folder, file), 'utf8')
        for (const dependency of undeclaredImports(manifest, source, !built)) {
          problems.push(`${manifest.name}: ${area}/${file} imports undeclared ${dependency}`)
        }
      }
    }
  }
  return { packages, problems }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { packages, problems } = auditPublicPackageImports(process.argv.includes('--built'))
  for (const problem of problems) console.error(problem)
  console.log(`Checked ${packages} public packages: ${problems.length} undeclared imports`)
  process.exitCode = problems.length ? 1 : 0
}

#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))

/** Check imports, re-exports, dynamic imports and declaration imports against a manifest. */
export function undeclaredImports(manifest, source, includeDevDependencies = false) {
  const declared = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
    ...(includeDevDependencies ? manifest.devDependencies : {}),
  }
  const missing = new Set()
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    if (/^(?:[./#]|[a-z]+:)/i.test(specifier) || isBuiltin(specifier)) continue
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
    if (name !== manifest.name && !Object.hasOwn(declared, name)) missing.add(name)
  }
  return [...missing].sort()
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

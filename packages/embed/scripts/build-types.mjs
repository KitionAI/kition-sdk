#!/usr/bin/env node
// Emits the package's declarations, and those of the workspace packages they name, into
// dist/types, then points those packages' names at their emitted files, so dist needs nothing
// from the workspace. dist/index.d.ts is the entry. tsconfig.build.json maps those names to their
// sources (`paths`), so tsc emits them rather than treating them as libraries.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'dist')
const types = path.join(dist, 'types')
fs.rmSync(types, { recursive: true, force: true })
const tsc = createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

/** `@kition/<package>` and `@kition/<package>/<module>` → the emitted file, relative to `file`. */
const workspaceImport = /(from |import\()'@kition\/([a-z-]+)(?:\/([A-Za-z]+))?'/g
function rewrite(file) {
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(workspaceImport, (_, lead, name, module) => {
    const target = path.join(types, name, 'src', module ?? 'index')
    if (!fs.existsSync(`${target}.d.ts`)) throw new Error(`${path.relative(root, file)} names @kition/${name}${module ? `/${module}` : ''}, which was not emitted`)
    let relative = path.relative(path.dirname(file), target).split(path.sep).join('/')
    if (!relative.startsWith('.')) relative = `./${relative}`
    return `${lead}'${relative}'`
  })
  if (next !== text) fs.writeFileSync(file, next)
}
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const declarations = walk(types).filter((name) => name.endsWith('.d.ts'))
for (const file of declarations) rewrite(file)

fs.writeFileSync(path.join(dist, 'index.d.ts'), "export * from './types/embed/src/index'\n")
console.log('wrote dist/index.d.ts and dist/types')

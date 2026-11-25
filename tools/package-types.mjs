#!/usr/bin/env node
// Emits a package's declarations into its dist/ (tsconfig.build.json) for the shipped package, so
// its types do not point at TypeScript sources:
//
//   node ../../tools/package-types.mjs        (from the package's folder; its `build` script)
//
// - Relative imports get their `.js` (or `/index.js`), so the declarations resolve under
//   `moduleResolution: nodenext` as well as `bundler`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = process.cwd()
const dist = path.join(root, 'dist')
const tsc = createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc')
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')], { stdio: 'inherit' })

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))
const declarations = walk(dist).filter((name) => name.endsWith('.d.ts'))
const relativeImport = /((?:from |import\()['"])(\.{1,2}\/[^'"]*)(['"])/g

for (const file of declarations) {
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(relativeImport, (whole, lead, specifier, close) => {
    if (/\.js$/.test(specifier)) return whole
    const target = path.resolve(path.dirname(file), specifier)
    if (fs.existsSync(`${target}.d.ts`)) return `${lead}${specifier}.js${close}`
    if (fs.existsSync(path.join(target, 'index.d.ts'))) return `${lead}${specifier}/index.js${close}`
    throw new Error(`${path.relative(root, file)} imports ${specifier}, which was not emitted`)
  })
  if (next !== text) fs.writeFileSync(file, next)
}
console.log(`wrote ${declarations.length} declarations in dist/`)

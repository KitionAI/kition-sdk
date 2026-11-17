#!/usr/bin/env node
// Emits a package's declarations into its dist/ (tsconfig.build.json) for the shipped package, so
// its types do not point at TypeScript sources:
//
//   node ../../tools/package-types.mjs        (from the package's folder; its `build` script)
//
// - Relative imports get their `.js` (or `/index.js`), so the declarations resolve under
//   `moduleResolution: nodenext` as well as `bundler`.
// - Loro's types point at dist/loro-crdt.d.ts: loro-crdt 1.16.4's own declarations do not pass
//   `skipLibCheck: false`, so a package naming them would fail every such project. Its classes are
//   declared empty there, so a real Loro object is still accepted where one is asked for.
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
const relativeTo = (file, target) => {
  const relative = path.relative(path.dirname(file), target).split(path.sep).join('/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

/** Loro's string aliases keep their shape; everything else it names is an empty class. */
const LORO_ALIASES = { PeerID: '`${number}`', TreeID: '`${number}@${number}`', ContainerID: 'string' }
const loroImport = /import (type )?\{([^}]*)\} from 'loro-crdt';?/g
const relativeImport = /((?:from |import\()['"])(\.{1,2}\/[^'"]*)(['"])/g
const loroNames = new Set()

for (const file of declarations) {
  const text = fs.readFileSync(file, 'utf8')
  let next = text.replace(relativeImport, (whole, lead, specifier, close) => {
    if (/\.js$/.test(specifier)) return whole
    const target = path.resolve(path.dirname(file), specifier)
    if (fs.existsSync(`${target}.d.ts`)) return `${lead}${specifier}.js${close}`
    if (fs.existsSync(path.join(target, 'index.d.ts'))) return `${lead}${specifier}/index.js${close}`
    throw new Error(`${path.relative(root, file)} imports ${specifier}, which was not emitted`)
  })
  next = next.replace(loroImport, (_, lead, names) => {
    for (const name of names.split(',')) if (name.trim()) loroNames.add(name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
    return `import type {${names.replace(/\btype\s+/g, '')}} from '${relativeTo(file, path.join(dist, 'loro-crdt.js'))}';`
  })
  if (next.includes("'loro-crdt'")) throw new Error(`${path.relative(root, file)} names loro-crdt in a way this script does not rewrite`)
  if (next !== text) fs.writeFileSync(file, next)
}
if (loroNames.size) {
  const declared = [...loroNames].sort().map((name) => (LORO_ALIASES[name] ? `export type ${name} = ${LORO_ALIASES[name]}\n` : `export declare class ${name} {}\n`))
  fs.writeFileSync(path.join(dist, 'loro-crdt.d.ts'), `/** The Loro (loro-crdt) types these declarations name, without Loro's own declarations. */\n${declared.join('')}`)
}
console.log(`wrote ${declarations.length} declarations in dist/`)

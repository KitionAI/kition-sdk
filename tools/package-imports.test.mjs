import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it as test } from 'vitest'
import { auditPublicPackageImports, importedPackages, packageFolderImports, undeclaredImports } from './check-public-package-imports.mjs'

test('all public package source imports have declarations', () => {
  const result = auditPublicPackageImports()
  assert.ok(result.packages > 0)
  assert.deepEqual(result.problems, [])
})

test('published imports require runtime declarations, including types and subpaths', () => {
  const manifest = { name: '@kit/editor', dependencies: { react: '*' }, devDependencies: { '@kit/engine': '*' } }
  const source = `
    import 'react/jsx-runtime'
    import 'node:fs'
    import 'path'
    import './local.js'
    import '@kit/editor/own'
    export { engine } from '@kit/engine'
    export type Host = import('@kit/host/types').Host
    const load = () => import('loader/subpath')
  `
  assert.deepEqual(undeclaredImports(manifest, source), ['@kit/engine', '@kit/host', 'loader'])
  assert.deepEqual(undeclaredImports(manifest, source, true), ['@kit/host', 'loader'])
})

test('a built package folder: every package its minified code and declarations import is declared', () => {
  // As a bundler leaves it: no spaces, a CommonJS shim imported from an ES module, a dynamic import.
  assert.deepEqual(importedPackages('import{a as b}from"use-sync-external-store/shim";import"node:fs";export*from"./c.js";const d=()=>import("loro-crdt")'), ['loro-crdt', 'use-sync-external-store'])
  const dir = mkdtempSync(path.join(os.tmpdir(), 'package-imports-'))
  try {
    mkdirSync(path.join(dir, 'dist', 'chunks'), { recursive: true })
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@kition/sdk', dependencies: { 'loro-crdt': '1' }, peerDependencies: { react: '>=19' }, devDependencies: { 'use-sync-external-store': '1' } }))
    writeFileSync(path.join(dir, 'dist', 'chunks', 'a.js'), 'import{useSyncExternalStore as u}from"use-sync-external-store/shim";import"react/jsx-runtime";import"@kition/sdk/kdm";import"path"')
    writeFileSync(path.join(dir, 'dist', 'b.d.ts'), "export type L = import('loro-crdt').LoroDoc\nexport { x } from 'undeclared-types'\n")
    writeFileSync(path.join(dir, 'dist', 'c.css'), "@import 'not-code';\n")
    writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), "import 'their-own'\n")
    assert.deepEqual(packageFolderImports(dir), {
      imported: ['loro-crdt', 'react', 'undeclared-types', 'use-sync-external-store'],
      // A dev dependency is not installed for a consumer.
      undeclared: ['dist/b.d.ts: undeclared-types', 'dist/chunks/a.js: use-sync-external-store'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

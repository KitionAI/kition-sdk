import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it as test } from 'vitest'
import { auditPublicPackageImports, undeclaredImports } from './check-public-package-imports.mjs'

test('all public package source imports have declarations', () => {
  const result = auditPublicPackageImports()
  assert.ok(result.packages > 0)
  assert.deepEqual(result.problems, [])
})

test('editor declares the engine as a runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/kit-editor/package.json', import.meta.url), 'utf8'))
  const sdk = JSON.parse(readFileSync(new URL('../sdk.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies['@kition/kit-engine'], `^${sdk.version}`)
  assert.equal(manifest.devDependencies?.['@kition/kit-engine'], undefined)
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

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { it as test } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'))
const sdk = read('sdk.json')

for (const directory of readdirSync(new URL('packages/', root))) {
  test(`${directory} publishes built modules and portable dependencies`, () => {
    const manifest = read(`packages/${directory}/package.json`)
    assert.equal(manifest.private, undefined)
    assert.equal(manifest.license, 'Apache-2.0')
    assert.equal(manifest.version, sdk.version)
    assert.equal(manifest.publishConfig.access, 'public')
    assert.equal(manifest.repository.directory, `packages/${directory}`)
    assert.deepEqual(manifest.files, ['dist'])
    assert.ok(manifest.scripts.build)
    assert.ok(manifest.types.startsWith('./dist/'))
    const exports = manifest.publishConfig.exports ?? manifest.exports
    for (const target of Object.values(exports)) {
      for (const file of typeof target === 'string' ? [target] : Object.values(target)) assert.ok(file.startsWith('./dist/'), file)
    }
    for (const version of Object.values(manifest.dependencies ?? {})) assert.doesNotMatch(version, /^(?:link:|file:)/)
  })
}

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { it as test } from 'vitest'
import { FAMILY_BEGIN, generated } from './kition-family.mjs'

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
    // A package without a root module (@kition/sdk: import a subpath) has no top-level types.
    if (Object.hasOwn(manifest.exports, '.')) assert.ok(manifest.types.startsWith('./dist/'))
    else assert.equal(manifest.types, undefined)
    const exports = manifest.publishConfig.exports ?? manifest.exports
    for (const target of Object.values(exports)) {
      for (const file of typeof target === 'string' ? [target] : Object.values(target)) assert.ok(file.startsWith('./dist/'), file)
    }
    for (const version of Object.values(manifest.dependencies ?? {})) assert.doesNotMatch(version, /^(?:link:|file:)/)
  })

  test(`${directory} introduces itself on npm: README, description, repository, homepage, bugs, keywords`, () => {
    const manifest = read(`packages/${directory}/package.json`)
    assert.ok(typeof manifest.description === 'string' && manifest.description.length > 20, 'description')
    assert.deepEqual(manifest.repository, { type: 'git', url: 'git+https://github.com/KitionAI/kition-sdk.git', directory: `packages/${directory}` })
    assert.equal(manifest.homepage, `https://github.com/KitionAI/kition-sdk/tree/main/packages/${directory}#readme`)
    assert.deepEqual(manifest.bugs, { url: 'https://github.com/KitionAI/kition-sdk/issues' })
    assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('kition') && manifest.keywords.length >= 4, 'keywords')
    const file = new URL(`packages/${directory}/README.md`, root)
    assert.ok(existsSync(file), 'README.md')
    const readme = readFileSync(file, 'utf8')
    assert.ok(readme.startsWith(`# ${manifest.name}\n\n`), 'the README starts with the package name, then what it is')
    assert.ok(readme.includes(`\n${FAMILY_BEGIN}\n## Part of the Kition SDK\n`), 'the README ends with the generated tail')
    // npm shows the README away from GitHub: every link is absolute.
    for (const [, target] of readme.matchAll(/\]\(([^)\s]+)\)/g)) assert.match(target, /^(?:https:\/\/|#)/, target)
    for (const [, target] of readme.matchAll(/\s(?:src|href)="([^"]+)"/g)) assert.match(target, /^https:\/\//, target)
    assert.doesNotMatch(readme, /licence/i)
  })
}

test('the packages\' READMEs and the org profile are as tools/kition-family.mjs generates them (node tools/kition-family.mjs)', () => {
  for (const file of generated()) {
    assert.notEqual(file.text, null, `${file.path}: ${file.missing}`)
    assert.equal(readFileSync(new URL(file.path, root), 'utf8'), file.text, `${file.path} differs; run node tools/kition-family.mjs`)
  }
})

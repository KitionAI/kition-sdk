import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

describe('published kit boundary', () => {
  it('ships copied kit artifacts only for explicitly published kits', () => {
    const published = read('published-kits.json')
    expect(published).toEqual(['board', 'cad', 'design', 'doc', 'film', 'html', 'layout', 'motion', 'note', 'pdf', 'photo', 'scene', 'sheet', 'slide', 'table', 'vector'])
    const entries = (dir, suffix) => fs.readdirSync(path.join(root, dir))
      .filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, -suffix.length)).sort()
    expect(entries('plugins/claude-code/kition-kits/skills', '-editing')).toEqual(published)
    expect(entries('plugins/deepseek-harness/kition-kits/skills', '-editing')).toEqual(published)
    expect(entries('crates/kition-kits/tests/fixtures/kits', '.json')).toEqual(published)
    expect(entries('packages/script/kits', '.ts').filter((name) => name !== 'index')).toEqual(published)
    expect(read('sdk.json').kits).toEqual(published)
    const pkg = read('packages/script/package.json')
    for (const exports of [pkg.exports, pkg.publishConfig.exports]) {
      expect(Object.keys(exports).filter((name) => name.startsWith('./kits/')).sort())
        .toEqual(published.map((kit) => `./kits/${kit}`))
    }
  })
})

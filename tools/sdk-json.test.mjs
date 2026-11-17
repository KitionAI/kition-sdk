import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KIT_NAMES } from './kit-naming.mjs'
import { PUBLISHED_KITS } from './published-kits.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sdk = JSON.parse(fs.readFileSync(path.join(root, 'sdk.json'), 'utf8'))
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

describe('sdk.json, the bundle surface', () => {
  it('names only current Kition kits, the keys of kits.lock.json that sdk-bundle looks up', () => {
    expect(sdk.kits.filter((kit) => !(kit in KIT_NAMES))).toEqual([])
  })
  it('offers exactly the published kits to hosts', () => {
    expect(sdk.kits).toEqual(PUBLISHED_KITS)
  })
  it('is the kit list of the getting-the-sdk guide', () => {
    const guide = read('docs/platform/getting-the-sdk.md')
    const section = guide.slice(guide.indexOf('## 4. The kits'), guide.indexOf('\n## ', guide.indexOf('## 4. The kits') + 1))
    expect(section).toContain(`The kits in SDK ${sdk.version} (its \`sdk.json\`)`)
    const listed = [...section.matchAll(/^\| `kit\.([a-z]+)` \|/gm)].map((match) => match[1])
    expect(listed.sort()).toEqual([...sdk.kits].sort())
  })
  it('is the version the SDK guide states', () => {
    expect(read('docs/sdk/README.md')).toContain(`Version **${sdk.version}** (\`sdk.json\``)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brokenLinks, shippedFiles } from './bundle-docs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = []
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** The bundle's documents, laid out as tools/sdk-bundle.mjs lays them out. */
function bundleDocs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kition-bundle-docs-'))
  scratch.push(dir)
  for (const file of shippedFiles(root)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.copyFileSync(path.join(root, file), path.join(dir, file))
  }
  return dir
}

describe('the documents an SDK bundle carries', () => {
  it('include the Kit Process Protocol, the host and engine contracts, and the schemas', () => {
    const files = shippedFiles(root)
    for (const needed of [
      'docs/platform/reference/kit-process-protocol.md',
      'docs/platform/kits/host.md',
      'docs/platform/kits/engine.md',
      'docs/platform/sets/agent.md',
      'docs/platform/sets/files.md',
      'docs/sdk/hosts.md',
      'schemas/kit-process-protocol.schema.json',
      'schemas/kit.schema.json',
      'schemas/kits-service.schema.json',
      'examples/hosts/go/main.go',
    ]) {
      expect(files).toContain(needed)
    }
  })

  it('link only to files the bundle has', () => {
    expect(brokenLinks(bundleDocs())).toEqual([])
  })

  it('finds a link to a file the bundle lacks', () => {
    const dir = bundleDocs()
    fs.writeFileSync(path.join(dir, 'docs/sdk/extra.md'), '[gone](../standard/kits/host.md) [outside](../../../etc/passwd) [web](https://kition.ai) [here](hosts.md#errors) `^[a-z](?:[a-z0-9_]*[a-z0-9])?$`\n')
    expect(brokenLinks(dir)).toEqual(['docs/sdk/extra.md -> ../standard/kits/host.md', 'docs/sdk/extra.md -> ../../../etc/passwd'])
  })
})

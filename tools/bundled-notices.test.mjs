import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packageNoticeFiles, packageNoticeSection } from './bundled-notices.mjs'

const dirs = []

function npmPackage(name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-notices-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'Apache-2.0', repository: 'git+https://github.com/example/icons.git' }))
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('bundled package notices', () => {
  it('takes every LICENSE, LICENSE-*, NOTICE and THIRD_PARTY_NOTICES file, from the root and dist/', () => {
    const dir = npmPackage('icons', { LICENSE: 'Apache terms', 'LICENSE-lucide': 'ISC terms', NOTICE: 'Lucide notice', 'dist/THIRD_PARTY_NOTICES': 'Loro terms', 'README.md': 'readme' })
    expect(packageNoticeFiles(dir).map((file) => path.relative(dir, file))).toEqual(['LICENSE', 'LICENSE-lucide', 'NOTICE', 'dist/THIRD_PARTY_NOTICES'])
    const { key, text } = packageNoticeSection(dir)
    expect(key).toBe('icons@1.0.0')
    expect(text).toBe('icons 1.0.0 (Apache-2.0)\nhttps://github.com/example/icons\n\nApache terms\n\nISC terms\n\nLucide notice\n\nLoro terms')
  })

  it('refuses a package with notices but no license file', () => {
    expect(() => packageNoticeFiles(npmPackage('bare', { NOTICE: 'notice only' }))).toThrow('bare ships no license file')
  })
})

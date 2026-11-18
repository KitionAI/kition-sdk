import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compareGlibc, glibcNeeds } from './glibc-floor.mjs'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), 'glibc-floor.mjs')

/** A 64-bit little-endian ELF file whose only content is a string table and the version needs `needs` ({ file: [version names] }). */
function elf(needs) {
  let strings = '\0'
  const name = (text) => { const at = strings.length; strings += `${text}\0`; return at }
  const entries = Object.entries(needs).map(([file, versions]) => ({ file: name(file), versions: versions.map(name) }))
  const verneed = []
  entries.forEach((entry, i) => {
    const head = Buffer.alloc(16)
    head.writeUInt16LE(1, 0)
    head.writeUInt16LE(entry.versions.length, 2)
    head.writeUInt32LE(entry.file, 4)
    head.writeUInt32LE(16, 8)
    head.writeUInt32LE(i === entries.length - 1 ? 0 : 16 + 16 * entry.versions.length, 12)
    verneed.push(head)
    entry.versions.forEach((version, k) => {
      const aux = Buffer.alloc(16)
      aux.writeUInt32LE(version, 8)
      aux.writeUInt32LE(k === entry.versions.length - 1 ? 0 : 16, 12)
      verneed.push(aux)
    })
  })
  const stringBytes = Buffer.from(strings, 'latin1')
  const verneedBytes = Buffer.concat(verneed)
  const stringsAt = 64
  const verneedAt = stringsAt + stringBytes.length
  const shoff = verneedAt + verneedBytes.length
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header[4] = 2
  header[5] = 1
  header.writeBigUInt64LE(BigInt(shoff), 0x28)
  header.writeUInt16LE(64, 0x3a)
  header.writeUInt16LE(3, 0x3c)
  const sections = [Buffer.alloc(64), Buffer.alloc(64), Buffer.alloc(64)]
  sections[1].writeUInt32LE(3, 4)
  sections[1].writeBigUInt64LE(BigInt(stringsAt), 24)
  sections[1].writeBigUInt64LE(BigInt(stringBytes.length), 32)
  sections[2].writeUInt32LE(0x6ffffffe, 4)
  sections[2].writeBigUInt64LE(BigInt(verneedAt), 24)
  sections[2].writeBigUInt64LE(BigInt(verneedBytes.length), 32)
  sections[2].writeUInt32LE(1, 40)
  sections[2].writeUInt32LE(entries.length, 44)
  return Buffer.concat([header, stringBytes, verneedBytes, ...sections])
}

describe('the glibc floor of the Linux executables', () => {
  it('orders versions numerically', () => {
    expect(['2.28', '2.3.4', '2.17', '2.2.5', '2.100'].sort(compareGlibc)).toEqual(['2.2.5', '2.3.4', '2.17', '2.28', '2.100'])
  })

  it('reads every GLIBC version an executable needs, from every library, and nothing else', () => {
    const bytes = elf({ 'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.17', 'GLIBC_2.14'], 'libgcc_s.so.1': ['GCC_3.0'], 'libm.so.6': ['GLIBC_2.29'] })
    expect(glibcNeeds(bytes)).toEqual(['2.2.5', '2.14', '2.17', '2.29'])
    expect(glibcNeeds(elf({}))).toEqual([])
    expect(() => glibcNeeds(Buffer.from('#!/bin/sh\n'.padEnd(80)))).toThrow(/not an ELF file/)
  })

  it('fails the files above the floor and passes those at or below it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-floor-'))
    const old = path.join(dir, 'kition')
    const recent = path.join(dir, 'kition-note')
    fs.writeFileSync(old, elf({ 'libc.so.6': ['GLIBC_2.2.5', 'GLIBC_2.17'] }))
    fs.writeFileSync(recent, elf({ 'libc.so.6': ['GLIBC_2.17', 'GLIBC_2.34', 'GLIBC_2.39'] }))
    const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
    const pass = run('--max', '2.17', old)
    expect(pass.status).toBe(0)
    expect(pass.stdout).toContain('GLIBC_2.17')
    const fail = run('--max', '2.17', old, recent)
    expect(fail.status).toBe(1)
    expect(fail.stderr).toContain(`${recent} needs GLIBC_2.39 (2.34, 2.39)`)
    expect(run('--max', '2.39', old, recent).status).toBe(0)
    expect(run(old).status).toBe(2)
  })
})

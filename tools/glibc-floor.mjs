#!/usr/bin/env node
// The glibc floor of the Linux executables a release ships: the newest GLIBC_<version> symbol
// version each one needs (its ELF version needs, .gnu.version_r), which is the oldest glibc it runs
// on. The release workflow fails a Linux build whose executables need a newer glibc than the
// floor (docs/sdk/distribution.md, "Linux: the glibc floor").
//
//   node tools/glibc-floor.mjs --max <version> <file>...   print each file's newest need; exit 1 when one is above <version>
//
// Reads the file itself, so it needs no objdump or readelf, and runs on any platform.
import fs from 'node:fs'

const SHT_GNU_VERNEED = 0x6ffffffe

/** Compares two dotted versions (2.17 < 2.28 < 2.100). */
export function compareGlibc(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Every GLIBC_<version> a 64-bit little-endian ELF file needs, oldest first; [] when it needs none. */
export function glibcNeeds(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file')
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('not a 64-bit little-endian ELF file')
  const shoff = Number(buf.readBigUInt64LE(0x28))
  const shentsize = buf.readUInt16LE(0x3a)
  const shnum = buf.readUInt16LE(0x3c)
  const section = (i) => {
    const at = shoff + i * shentsize
    return { type: buf.readUInt32LE(at + 4), offset: Number(buf.readBigUInt64LE(at + 24)), link: buf.readUInt32LE(at + 40), info: buf.readUInt32LE(at + 44) }
  }
  const cString = (at) => buf.toString('latin1', at, buf.indexOf(0, at))
  const versions = new Set()
  for (let i = 0; i < shnum; i++) {
    const verneed = section(i)
    if (verneed.type !== SHT_GNU_VERNEED) continue
    const strings = section(verneed.link).offset
    let entry = verneed.offset
    for (let n = 0; n < verneed.info; n++) {
      let aux = entry + buf.readUInt32LE(entry + 8)
      for (let k = buf.readUInt16LE(entry + 2); k > 0; k--) {
        const match = /^GLIBC_(\d+(?:\.\d+)*)$/.exec(cString(strings + buf.readUInt32LE(aux + 8)))
        if (match) versions.add(match[1])
        const next = buf.readUInt32LE(aux + 12)
        if (!next) break
        aux += next
      }
      const next = buf.readUInt32LE(entry + 12)
      if (!next) break
      entry += next
    }
  }
  return [...versions].sort(compareGlibc)
}

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--max')
  if (at < 0 || !args[at + 1]) {
    console.error('usage: node tools/glibc-floor.mjs --max <version> <file>...')
    process.exit(2)
  }
  const max = args[at + 1]
  const files = args.filter((_, i) => i !== at && i !== at + 1)
  if (!files.length) {
    console.error('glibc-floor: no files given')
    process.exit(2)
  }
  const above = []
  for (const file of files) {
    const needs = glibcNeeds(fs.readFileSync(file))
    const newest = needs.at(-1)
    console.log(`${file}: ${newest ? `GLIBC_${newest}` : 'no GLIBC symbol versions'}`)
    if (newest && compareGlibc(newest, max) > 0) above.push(`${file} needs GLIBC_${newest} (${needs.filter((v) => compareGlibc(v, max) > 0).join(', ')})`)
  }
  if (above.length) {
    console.error(`glibc-floor: above the floor, glibc ${max}:\n  ${above.join('\n  ')}`)
    process.exit(1)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()

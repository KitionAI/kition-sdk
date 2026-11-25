#!/usr/bin/env node
// One-off sample conversion for the plain model (plan 2026-11-24, plain model design, section
// 8.2 "工具" and decision 10): reads a kit sample's old content snapshot (the Loro bytes the
// kits wrote before kition-sdk 91cf510) with the OLD npm package's `@kition/sdk/kdm`, and writes
// a `content.json` the new `Replica::load` takes (data model section 7.4): valid, not
// necessarily canonical. The kit's own Rust save then writes the canonical bytes. Document ids
// and object ids are kept. Delete this folder once every kit has landed its converted samples.
//
//   cd tools/convert-content && npm install
//   node convert.mjs <schema.json> <input> <output.json> [--entry <name>]
//
// <input> is the old snapshot itself, or with --entry a ZIP container holding it under <name>
// (`content.bin` for .kboard and .klayout, `content.kdm` for scene, `kdm/content.bin` for
// design, `kdm.bin` for a zipped .kphoto). Several files: repeat the call per file.
//
// What it writes, from the old `stateJson()`: the header `kdm`, `kit`, `docId`, `schemaVersion`
// (C2, no version: content, C10); one line per object, ids and keys in UTF-8 byte order (C3,
// C4); fields holding null, an empty text, list, map or tree left out (C5); map entries holding
// null left out; list items and tree nodes naming no object of the document left out, a tree node
// with its subtree (C13); trees flat as [depth, id] pairs in pre-order (C8a). Texts stay as the
// old state wrote them (runs, also without marks; C15 reads them), numbers as JSON.stringify
// writes them (C15 reads any JSON form).

import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { parseSchema, Replica } from '@kition/sdk/kdm'

function usage(message) {
  if (message) console.error(message)
  console.error('usage: node convert.mjs <schema.json> <input> <output.json> [--entry <name>]')
  process.exit(2)
}

const args = process.argv.slice(2)
let entry = null
const positional = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--entry') entry = args[++i] ?? usage('--entry needs a name')
  else positional.push(args[i])
}
if (positional.length !== 3) usage()
const [schemaPath, inputPath, outputPath] = positional

/** The bytes of entry `name` of the ZIP `zip` (stored or deflated, no ZIP64). */
function zipEntry(zip, name) {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a ZIP archive (no end of central directory)')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged central directory')
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const entryName = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    if (entryName === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + compressed)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      throw new Error(`${name}: compression method ${method}`)
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`no entry ${name}`)
}

const schema = parseSchema(JSON.parse(readFileSync(schemaPath, 'utf8')))
const input = readFileSync(inputPath)
const bytes = entry === null ? input : zipEntry(input, entry)
const replica = Replica.load(schema, new Uint8Array(bytes), 1n)
const state = replica.stateJson()
const objects = state.objects ?? {}
const exists = (id) => typeof id === 'string' && Object.hasOwn(objects, id)

const utf8 = (text) => Buffer.from(text, 'utf8')
const byBytes = (a, b) => Buffer.compare(utf8(a), utf8(b))

/** `value` with the keys of every object in UTF-8 byte order (C4). */
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(byBytes).map((key) => [key, sorted(value[key])]))
  }
  return value
}

/** An old nested tree (`[{object, children}]`) flat as [depth, id] pairs, dropping nodes (with
 *  their subtrees) that name no object of the document. Iterative: a tree may be deep. */
function flatTree(nodes) {
  const out = []
  const stack = [...nodes].reverse().map((node) => [0, node])
  while (stack.length > 0) {
    const [depth, node] = stack.pop()
    if (!exists(node?.object)) continue
    out.push([depth, node.object])
    const children = Array.isArray(node.children) ? node.children : []
    for (let i = children.length - 1; i >= 0; i--) stack.push([depth + 1, children[i]])
  }
  return out
}

const isEmptyText = (value) => value === '' || (Array.isArray(value) && value.every((run) => !run?.insert))

/** One object's fields as content.json holds them (C5, C8, C8a, C13). */
function convertObject(object) {
  const type = object.$type
  const fields = schema.types?.[type]?.fields ?? {}
  const out = { $type: type }
  for (const [name, value] of Object.entries(object)) {
    if (name === '$type' || value === null || value === undefined) continue
    const kind = fields[name]?.kind
    let converted = value
    if (kind === 'list') {
      converted = Array.isArray(value) ? value.filter(exists) : value
      if (Array.isArray(converted) && converted.length === 0) continue
    } else if (kind === 'tree') {
      converted = Array.isArray(value) ? flatTree(value) : value
      if (Array.isArray(converted) && converted.length === 0) continue
    } else if (kind === 'map') {
      converted = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null))
      if (Object.keys(converted).length === 0) continue
    } else if (kind === 'text') {
      if (isEmptyText(value)) continue
    }
    out[name] = converted
  }
  return sorted(out)
}

const meta = state.meta ?? {}
for (const key of ['kdm', 'kit', 'docId', 'schemaVersion']) {
  if (meta[key] === undefined) throw new Error(`the old state has no meta.${key}`)
}
const header = `{"kdm":${JSON.stringify(meta.kdm)},"kit":${JSON.stringify(meta.kit)},"docId":${JSON.stringify(meta.docId)},"schemaVersion":${JSON.stringify(meta.schemaVersion)},"objects":{`
const ids = Object.keys(objects).sort(byBytes)
const lines = ids.map((id, i) => `${JSON.stringify(id)}:${JSON.stringify(convertObject(objects[id]))}${i + 1 < ids.length ? ',' : ''}`)
writeFileSync(outputPath, [header, ...lines, '}}', ''].join('\n'))
console.log(`${outputPath}: ${ids.length} objects, ${bytes.length} bytes before (old snapshot)`)

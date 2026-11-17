#!/usr/bin/env node
// The WebAssembly half of the convergence suite's native/WebAssembly parity check
// (crates/kition-convergence, wasm.rs, which embeds this file): opens a kit engine's replica from a
// trace's snapshot in Node, imports the trace's changes in order through the engine's own
// contract 2 members, and writes the engine's snapshot for the native side to compare.
//
//   node tools/convergence-wasm.mjs <engine dir> <module> <class> <file name> <trace.json> <out.bin>
//
// The trace is JSON with hex strings: { snapshot, blobs, changes: [...] }. `blobs` is the encoded
// blob list openWithReplica takes.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, moduleName, className, fileName, tracePath, outPath] = process.argv.slice(2)
if (!outPath) {
  console.error('usage: convergence-wasm.mjs <engine dir> <module> <class> <file name> <trace.json> <out.bin>')
  process.exit(2)
}
const sdk = await import(pathToFileURL(path.join(dir, `${moduleName}.js`)).href)
await sdk.default({ module_or_path: fs.readFileSync(path.join(dir, `${moduleName}_bg.wasm`)) })
const Document = sdk[className]
if (typeof Document?.openWithReplica !== 'function') {
  console.error(`${moduleName} has no ${className}.openWithReplica`)
  process.exit(1)
}
const hex = (text) => Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8'))
const blobs = hex(trace.blobs)
const doc = Document.openWithReplica(fileName, new Uint8Array(0), hex(trace.snapshot), blobs)
trace.changes.forEach((change, index) => {
  try {
    // As a native host does: a change's blobs arrive before it (engines drop blobs their
    // snapshot does not reference, so openWithReplica's alone are not enough).
    doc.addBlobs?.(blobs)
    doc.importChanges(hex(change))
  } catch (error) {
    console.error(`change ${index}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
})
fs.writeFileSync(outPath, doc.snapshot())
console.log(`imported ${trace.changes.length} changes`)

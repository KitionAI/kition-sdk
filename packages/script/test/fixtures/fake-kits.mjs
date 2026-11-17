#!/usr/bin/env node
// A stand-in `kition-kits` for `KitsService.launch`: checks its arguments the way `kition-kits
// serve` takes them, answers `kits.initialize`, `documents.create` and `model.describe` on its
// standard input and output, and exits when its input closes.
import { createInterface } from 'node:readline'

if (process.env.FAKE_KITS_EXIT) process.exit(Number(process.env.FAKE_KITS_EXIT))
const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
if (args[0] !== 'serve' || !flag('--workspace')) {
  process.stderr.write('fake-kits: usage: serve --workspace <folder>\n')
  process.exit(2)
}
const kits = args.flatMap((arg, index) => (arg === '--kit' ? [args[index + 1]] : []))

const reply = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)
const state = (path) => ({ kitId: 'kit.fake', documentId: '1', path, title: path, format: 'fake', readOnly: false, dirty: false, canUndo: false, canRedo: false, conflict: false, version: 0, summary: '', details: {} })
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const { id, method, params } = JSON.parse(line)
    if (method === 'kits.initialize') {
      reply(id, { result: { serviceVersion: 1, protocolVersion: 2, workspace: flag('--workspace'), kits: [{ id: 'kit.fake', name: 'Fake', extensions: ['fake'], creates: ['fake'], installed: true, from: kits }] } })
    } else if (method === 'documents.create' || method === 'documents.open') {
      reply(id, { result: state(params.path) })
    } else if (method === 'model.describe') {
      reply(id, { result: { capability: 'KitObjectModel 1.0', kit: 'kit.fake', schemaVersion: 1, root: 'Presentation', rootId: 'slide', types: { Presentation: { fields: { title: { kind: 'string' } } } }, commands: [] } })
    } else reply(id, { error: { code: -32601, message: `method not found: ${method}` } })
  })
  .on('close', () => process.exit(0))

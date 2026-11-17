#!/usr/bin/env node
// Lists a built kit engine's commands by menu path (with `*` on those that need values), its
// tools, and its inspect() keys; `--schema <id>...` prints parameter schemas, and `--run '<id>
// <json>'` runs a command and prints its answer. For laying out a kit editor's ribbon.
//
//   node tools/kit-commands.mjs <engine dir> <module> <class> [--file <doc>] [--schema id...] [--run 'id {...}'...]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [dir, module, cls, ...rest] = process.argv.slice(2)
if (!dir || !module || !cls) {
  console.error('usage: kit-commands.mjs <engine dir> <module> <class> [--file <doc>] [--schema id...] [--run "id {json}"...]')
  process.exit(2)
}
const options = { file: null, schema: [], run: [] }
for (let index = 0, mode = null; index < rest.length; index += 1) {
  if (rest[index].startsWith('--')) mode = rest[index].slice(2)
  else if (mode === 'file') options.file = rest[index]
  else if (mode) options[mode].push(rest[index])
}
const sdk = await import(pathToFileURL(path.resolve(dir, `${module}.js`)).href)
sdk.initSync({ module: readFileSync(path.resolve(dir, `${module}_bg.wasm`)) })
const Class = sdk[cls]
const doc = options.file ? Class.open(path.basename(options.file), readFileSync(options.file)) : Class.create('Untitled', 612, 792)
const commands = JSON.parse(doc.commands())
const required = (command) => Object.values(command.schema ?? {}).some((node) => node?.required)

if (!options.schema.length && !options.run.length) {
  const menus = new Map()
  for (const command of commands) {
    const key = (command.menu ?? ['(none)']).join(' > ') || '(none)'
    menus.set(key, [...(menus.get(key) ?? []), `${command.id}${required(command) ? '*' : ''}`])
  }
  for (const [menu, ids] of menus) console.log(`${menu}: ${ids.join(' ')}`)
  console.log(`commands: ${commands.length}`)
  if (doc.tools) console.log(`tools: ${JSON.parse(doc.tools()).map((tool) => tool.id).join(' ')}`)
  console.log(`inspect: ${Object.keys(JSON.parse(doc.inspect())).join(' ')}`)
  console.log(`module functions: ${Object.keys(sdk).filter((name) => typeof sdk[name] === 'function' && name[0] === name[0].toLowerCase()).join(' ')}`)
}
for (const id of options.schema) {
  const command = commands.find((candidate) => candidate.id === id)
  console.log(id, command ? `"${command.title}" ${command.shortcut ?? ''} ${JSON.stringify(command.schema ?? command.params ?? null)}` : 'MISSING')
}
for (const call of options.run) {
  const [, id, params] = call.match(/^(\S+)\s*(.*)$/)
  try {
    console.log(id, '=>', String(doc.execute(id, params || '{}')).slice(0, 800))
  } catch (error) {
    console.log(id, 'ERROR', String(error))
  }
}

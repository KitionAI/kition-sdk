// Runs a wasm32-wasip1 program under Node's WASI: node run-wasi.mjs <program.wasm> [args...]
import { readFile } from 'node:fs/promises'
import { WASI } from 'node:wasi'
const [program, ...args] = process.argv.slice(2)
const wasi = new WASI({ version: 'preview1', args: [program, ...args], env: {}, preopens: {} })
const module = await WebAssembly.compile(await readFile(program))
const instance = await WebAssembly.instantiate(module, wasi.getImportObject())
wasi.start(instance)

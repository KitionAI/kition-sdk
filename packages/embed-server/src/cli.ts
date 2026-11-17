/**
 * `kition-embed-server <config>`: runs the embed server (docs/sdk/url.md) from a config
 * file, the options of `startEmbedServer`: a `.json` file, or a JavaScript module whose default
 * export they are (so secrets can come from `process.env`). Stops on SIGINT and SIGTERM.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startEmbedServer } from './index'

const USAGE = `Usage: kition-embed-server <config.json | config.mjs>

Runs the embed server for URL embedding (https://developer.kition.ai/url).
The config holds startEmbedServer's options: id, secret, integrators, kits,
kitsUrl (or kitsDir and kitsPort), and optionally port, host, embedDir.`

const arg = process.argv[2]
if (!arg || arg === '--help' || arg === '-h') {
  console.log(USAGE)
  process.exit(arg ? 0 : 1)
}

const file = resolve(arg)
const config = file.endsWith('.json') ? JSON.parse(await readFile(file, 'utf8')) : (await import(pathToFileURL(file).href)).default
const missing = ['id', 'secret', 'integrators', 'kits'].filter((key) => !config?.[key])
if (missing.length) {
  console.error(`${arg} names no ${missing.join(', ')}\n\n${USAGE}`)
  process.exit(1)
}

const service = await startEmbedServer(config)
console.log(`embed server:      ${service.url}`)
console.log(`kit packages:      ${service.kitsUrl}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void service.close().then(() => process.exit(0)))

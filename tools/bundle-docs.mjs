// What documents the SDK bundle carries (tools/sdk-bundle.mjs) and whether their links hold: a
// bundle holder has only the bundle, so every relative link in it must name a file in it.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** The examples the guide links to, as the repository tracks them (no builds, no node_modules). */
export const SHIPPED_EXAMPLES = ['agent-mcp', 'embed-app', 'hosts', 'sdk-scripts']

/**
 * The repository's files the bundle carries as they are, by their path in the repository, which is
 * also their path in the bundle: the SDK guide, the platform documents it links to (the Kit Process
 * Protocol, the host and engine contracts, the capability sets), the schemas, the examples, the
 * changelog and the licence. (The KHP, from a KHP specification checkout, goes to `docs/khp/`.)
 */
export function shippedFiles(root) {
  const tree = (dir) =>
    fs
      .readdirSync(path.join(root, dir), { recursive: true })
      .map((file) => path.join(dir, file))
      .filter((file) => fs.statSync(path.join(root, file)).isFile())
  const schemas = fs
    .readdirSync(path.join(root, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .map((file) => path.join('schemas', file))
  const examples = execFileSync('git', ['ls-files', ...SHIPPED_EXAMPLES.map((name) => `examples/${name}`)], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  return [...tree('docs/sdk'), ...tree('docs/platform'), ...schemas, ...examples, 'CHANGELOG.md', 'LICENSE']
}

/** Every relative link of `dir`'s Markdown that names no file in `dir`: `file -> target`. */
export function brokenLinks(dir) {
  const broken = []
  for (const file of fs.readdirSync(dir, { recursive: true }).filter((file) => file.endsWith('.md'))) {
    // Code is never a link: fenced blocks, and inline spans (a regex such as `^[a-z](?:x)?$`).
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
      const target = match[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      const resolved = path.resolve(dir, path.dirname(file), decodeURI(target))
      if (!resolved.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(resolved)) broken.push(`${file} -> ${target}`)
    }
  }
  return broken
}

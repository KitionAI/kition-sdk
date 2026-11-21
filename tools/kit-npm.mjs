// The npm packages a kit version is published as, and how they are named and read: the contract
// between the kit repositories' Package workflow (KitionAI/kition .github/workflows/kit-package.yml,
// which writes them with tools/kit-npm-package.mjs), the kit index (tools/kits-index.mjs, which
// reads their registry metadata) and `kition`, which installs them (crates/kition-cli).
//
// Per kit version `<version>` (the kit.json `version`), in the npm scope `KITION_NPM_SCOPE` names
// (default `@kition`; see `npmScope`), named by the scope's layout (see `LEGACY_LAYOUT_SCOPES`):
//
//   legacy layout (@kition)        layout 1 (any other scope)
//   <scope>/kit-<kit>-<platform>   <scope>/<kit>-<platform>   its headless kit for one platform (npm
//                                                             `os`, `cpu`, and `libc` on Linux):
//                                                             kit.json and the executable
//                                                             `kition-<kit>` (.exe on Windows) at
//                                                             the package's top
//   <scope>/kit-<kit>-ui           <scope>/<kit>              its editor package: the folder
//                                                             `<kit>-ui/` (index.html, the engine,
//                                                             fonts, the kit's kit.json)
//   <scope>/kits-index             <scope>/kits               the kit index (tools/kits-index.mjs)
//
// The files are those of the kit's archives before (the same names, the same bytes); only the
// container is npm's, a .tgz with everything under `package/` and a `package.json` beside them.
// Each package.json carries a `kition` field with what the kit index needs, so the index is
// built from the registry's metadata without downloading a package:
//
//   { kit, id, name, version, role: "headless" | "ui", platform (headless), protocol,
//     extensions (edited), views (only viewed), build: { commit, sdkCommit?, tesseraCommit?, fontsCommit? } }
//
// The rest of package.json introduces the kit on npm: its `description` is the kit's one-sentence
// description and `repository`, `homepage` and `bugs` its GitHub repository, both from
// templates/community/repositories.json (tools/kition-family.mjs); a kit not there is refused. The
// package's README (tools/kit-npm-package.mjs) is a README.md file in a headless package and the
// `readme` field in an editor package, whose top holds only `<kit>-ui/` (kition and Kition read it so).
//
// A package's integrity is npm's own `dist.integrity` (SHA-512 of the .tgz, `sha512-<base64>`),
// which the index copies and `kition` checks whatever registry or mirror it downloads from.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { kitOf } from './kition-family.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The platforms kits and kition are built for (packages/kition/src/platforms.json). */
export const PLATFORM_TARGETS = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'packages/kition/src/platforms.json'), 'utf8'))).filter(([key]) => !key.startsWith('$')))
export const PLATFORMS = Object.keys(PLATFORM_TARGETS)

/** The variable naming the npm scope kit packages and the kit index are published to and read from. */
export const SCOPE_VARIABLE = 'KITION_NPM_SCOPE'
/** The scope when `KITION_NPM_SCOPE` is not set (or empty). */
export const DEFAULT_SCOPE = '@kition'
const SCOPE_FORM = /^@[a-z0-9][a-z0-9-]*$/

// The scopes whose packages keep the legacy names (kit-<kit>-ui, kit-<kit>-<platform>,
// kits-index); every other scope uses layout 1 (<kit>, <kit>-<platform>, kits). On cutover day,
// when @kition moves to layout 1: empty this list, then delete the legacy branches of packageName
// and indexPackage below. The same list is in crates/kition-cli/src/registry.rs
// (LEGACY_LAYOUT_SCOPES) and in KitionAI/kition scripts/lib/kitNpm.mjs.
export const LEGACY_LAYOUT_SCOPES = ['@kition']
/** Whether `scope` names its packages by the legacy layout. */
export const isLegacyLayout = (scope) => LEGACY_LAYOUT_SCOPES.includes(scope)

/**
 * Names that are no kit's in layout 1: there a kit's packages are `<scope>/<kit>` and
 * `<scope>/<kit>-<platform>`, so a kit of one of these names would be taken for the scope's other
 * packages (`<scope>/cli`, `<scope>/cli-<platform>`, `<scope>/kits`, `<scope>/kit-editor`, ...).
 */
export const NOT_KIT_NAMES = ['cli', 'convergence', 'embed', 'extensions', 'gateway', 'kdm', 'kit', 'kition', 'kits', 'script', 'sdk', 'sync', 'tessera']

/** `scope`, when it is an npm scope (`@`, then lowercase letters, digits and dashes); else throws, naming `what`. */
export function checkScope(scope, what = 'the scope') {
  if (typeof scope !== 'string' || !SCOPE_FORM.test(scope)) throw new Error(`${what} is ${JSON.stringify(scope)}, not an npm scope (@ then lowercase letters, digits and dashes, such as @kition)`)
  return scope
}

/** The npm scope of `env`: `KITION_NPM_SCOPE`, else (unset or empty) `@kition`; one of another form throws. */
export function npmScope(env = process.env) {
  const value = env[SCOPE_VARIABLE]
  return value === undefined || value === '' ? DEFAULT_SCOPE : checkScope(value, SCOPE_VARIABLE)
}

/** The package of the kit index of `scope` (tools/kits-index.mjs writes it; `kition` reads its `latest`). */
export function indexPackage(scope = npmScope()) {
  checkScope(scope)
  return isLegacyLayout(scope) ? `${scope}/kits-index` : `${scope}/kits`
}

/** The registries `kition` falls back to after the ones configured, in this order. */
export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

const KIT = /^[a-z][a-z0-9]*$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/** The package of `kit`'s headless kit for `platform`, or of its editor (`ui`), in `scope`. */
export function packageName(kit, part, scope = npmScope()) {
  if (!KIT.test(kit)) throw new Error(`${JSON.stringify(kit)} is not a kit name`)
  if (part !== 'ui' && !PLATFORMS.includes(part)) throw new Error(`no platform ${part} (${PLATFORMS.join(', ')}), nor ui`)
  checkScope(scope)
  if (isLegacyLayout(scope)) return `${scope}/kit-${kit}-${part}`
  if (NOT_KIT_NAMES.includes(kit)) throw new Error(`${kit} is not a kit name in ${scope}: ${scope}/${kit} is another package there`)
  return part === 'ui' ? `${scope}/${kit}` : `${scope}/${kit}-${part}`
}

/** A package's tarball, relative to a registry's address: `@kition/kit-note-ui/-/kit-note-ui-0.1.3.tgz`, `@kitionstage/note/-/note-0.1.3.tgz`. */
export function tarballPath(name, version) {
  const bare = name.includes('/') ? name.split('/')[1] : name
  return `${name}/-/${bare}-${version}.tgz`
}

/** npm's integrity of `bytes`: `sha512-<base64>`. */
export const integrityOf = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`

/** The extensions a kit.json's formats of `role` list, lowercase, without the dot. */
function formatExtensions(kitJson, role) {
  const found = []
  for (const format of Array.isArray(kitJson?.formats) ? kitJson.formats : []) {
    if (format?.role !== role || !Array.isArray(format.extensions)) continue
    for (const raw of format.extensions) {
      const extension = String(raw).replace(/^\./, '').toLowerCase()
      if (KIT.test(extension) && !found.includes(extension)) found.push(extension)
    }
  }
  return found
}

/** The extensions a kit edits (its `edit` formats). */
export const editExtensions = (kitJson) => formatExtensions(kitJson, 'edit')

/** The extensions a kit only views (its `view` formats that no `edit` format covers). */
export function viewExtensions(kitJson) {
  const edited = new Set(editExtensions(kitJson))
  return formatExtensions(kitJson, 'view').filter((extension) => !edited.has(extension))
}

/**
 * The `kition` field of a package of `kitJson`'s kit: `role` `headless` (with its `platform`) or
 * `ui`; `build`, the commits it was built from.
 */
export function kitionField(kitJson, role, { platform, build = {} } = {}) {
  const kit = String(kitJson?.id ?? '').replace(/^kit\./, '')
  if (!KIT.test(kit) || kitJson.id !== `kit.${kit}`) throw new Error(`kit.json's id ${JSON.stringify(kitJson?.id)} is not kit.<name>`)
  if (!VERSION.test(String(kitJson.version))) throw new Error(`kit.json's version ${JSON.stringify(kitJson.version)} is not a version (semver)`)
  if (typeof kitJson.name !== 'string' || !kitJson.name.trim()) throw new Error(`${kitJson.id} has no name`)
  const protocol = kitJson.headless?.protocol
  if (!/^kition-kit\/[0-9]+$/.test(String(protocol))) throw new Error(`${kitJson.id} names no protocol (headless.protocol)`)
  const extensions = editExtensions(kitJson)
  if (!extensions.length) throw new Error(`${kitJson.id} edits no file type (no format with role edit and extensions)`)
  if (role !== 'headless' && role !== 'ui') throw new Error(`no role ${role} (headless, ui)`)
  if (role === 'headless' && !PLATFORMS.includes(platform)) throw new Error(`no platform ${platform} (${PLATFORMS.join(', ')})`)
  const commits = Object.fromEntries(Object.entries(build).filter(([, value]) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)))
  return {
    kit,
    id: kitJson.id,
    name: kitJson.name,
    version: kitJson.version,
    role,
    ...(role === 'headless' ? { platform } : {}),
    protocol,
    extensions,
    views: viewExtensions(kitJson),
    ...(Object.keys(commits).length ? { build: commits } : {}),
  }
}

/** The GitHub repository `owner/name` of a kit's packages: `repository` when given, else the kit's (templates/community/repositories.json). */
export function kitRepository(kit, repository) {
  if (repository === undefined || repository === null || repository === '') return kitOf(kit).github
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) throw new Error(`the repository ${JSON.stringify(repository)} is not owner/name`)
  return repository
}

/**
 * The package.json of a kit's package: its name and version, what it is (the kit's description,
 * its GitHub repository, keywords), the platform it installs on (npm `os`, `cpu`, `libc`), the files
 * it ships, its `readme` when given (the editor package's), and the `kition` field.
 */
export function packageManifest(kitJson, role, { platform, build, files, repository, scope = npmScope(), readme } = {}) {
  const kition = kitionField(kitJson, role, { platform, build })
  const kit = kitOf(kition.kit)
  const target = role === 'headless' ? PLATFORM_TARGETS[platform] : null
  const github = `https://github.com/${kitRepository(kition.kit, repository)}`
  return {
    name: packageName(kition.kit, role === 'ui' ? 'ui' : platform, scope),
    version: kition.version,
    description: role === 'ui' ? kit.description : `${kit.description} (${platform} executable)`,
    keywords: ['kition', 'kit', 'khp', kition.kit, ...(role === 'ui' ? ['editor', 'webassembly'] : ['headless', 'mcp']), 'ai-agents'],
    homepage: github,
    bugs: { url: `${github}/issues` },
    license: typeof kitJson.license === 'string' ? kitJson.license : 'UNLICENSED',
    repository: { type: 'git', url: `git+${github}.git` },
    ...(target ? { os: [target.os], cpu: [target.cpu], ...(target.libc ? { libc: [target.libc] } : {}) } : {}),
    files,
    ...(readme ? { readme } : {}),
    kition,
  }
}

/**
 * The registries `kition` reads, in order: `KITION_NPM_REGISTRY` (one address, or several
 * separated by commas), else none; then npm's own setting for the scope (`npmScope(env)`, default
 * @kition) or its registry (`npm_config_registry`, else `~/.npmrc`: `<scope>:registry`, then
 * `registry`); then
 * npmjs.org and npmmirror.com. Each address ends with `/`; none twice. The same rules as
 * crates/kition-cli/src/registry.rs, for the tools and the tests.
 */
export function registries(env = process.env, npmrcText = null) {
  const list = []
  const add = (value) => {
    const address = String(value ?? '').trim()
    if (!/^https?:\/\//i.test(address)) return
    const normal = address.endsWith('/') ? address : `${address}/`
    if (!list.includes(normal)) list.push(normal)
  }
  for (const value of String(env.KITION_NPM_REGISTRY ?? '').split(',')) add(value)
  const npmrc = parseNpmrc(npmrcText ?? '', env)
  add(npmrc[`${npmScope(env)}:registry`])
  add(env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? npmrc.registry)
  for (const address of DEFAULT_REGISTRIES) add(address)
  return list
}

/** The `key=value` settings of an .npmrc text: comments and blank lines skipped, `${VAR}` expanded. */
export function parseNpmrc(text, env = process.env) {
  const settings = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    settings[key] = value.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '')
  }
  return settings
}

/**
 * The bytes of `name` at `version` from the first of `list` (registry addresses ending with `/`)
 * that serves bytes of `integrity`; a registry that does not answer or serves other bytes passes
 * to the next. Throws naming every registry tried.
 */
export async function fetchPackage(list, name, version, integrity, fetchImpl = globalThis.fetch) {
  const tried = []
  for (const registry of list) {
    const url = `${registry}${tarballPath(name, version)}`
    try {
      const response = await fetchImpl(url)
      if (!response.ok) {
        tried.push(`${registry}: HTTP ${response.status}`)
        continue
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const found = integrityOf(bytes)
      if (found === integrity) return bytes
      tried.push(`${registry}: the integrity is ${found}, not ${integrity}`)
    } catch (error) {
      tried.push(`${registry}: ${error.message}`)
    }
  }
  throw new Error(`${name}@${version} could not be downloaded (tried ${tried.join('; ')})`)
}

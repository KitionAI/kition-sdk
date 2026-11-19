/**
 * What the `kition` launcher starts, and what it tells the program it starts. Pure: every look at
 * the machine (environment, files, installed packages) is passed in, so each case is testable.
 *
 * The program (`resolveKition`):
 * 1. `KITION_BINARY`, a `kition` executable the person names (a development build). Named but
 *    missing is an error, never a quiet fall back to another.
 * 2. The optional package `@kition/cli-<platform>`, which npm installs with `@kition/cli` on the
 *    platforms it is built for: its `bin/kition`. It carries no kit: kition installs each kit into
 *    its store (~/.kition/kits) when it is first needed.
 * Nothing else: a launcher that looked on the PATH would find itself (`npm install -g @kition/cli`
 * puts this launcher there under the name `kition`).
 *
 * How it was started (`launchedAs`), passed to kition in `KITION_LAUNCHER` so that
 * `kition agent add` registers a command that keeps working: `npx -y @kition/cli` when the launcher
 * runs from npx's cache, which npm may clear; npm's `kition` command (the global one, or a
 * project's node_modules/.bin/kition) when there is one for this launcher.
 */
import platforms from './platforms.json'

/** The npm package, and the command it installs (sdk.json `binaries.cli.npm` and `name`). */
export const PACKAGE_NAME = '@kition/cli'
export const KITION_NAME = 'kition'
/** The environment variable naming the executable to start instead (sdk.json `binaries.cli.binary`). */
export const BINARY_VARIABLE = 'KITION_BINARY'
/** Set by the launcher for kition: how it was started (sdk.json `binaries.cli.launcher`). */
export const LAUNCHER_VARIABLE = 'KITION_LAUNCHER'

export interface Platform {
  os: string
  cpu: string
  libc?: string
  rustTarget: string
}

/** The platforms a package carries kition for, by `${process.platform}-${process.arch}`. */
export const PLATFORMS: Readonly<Record<string, Platform>> = Object.fromEntries(Object.entries(platforms).filter(([key]) => !key.startsWith('$'))) as Record<string, Platform>

/** The optional package that carries kition for `platform`. */
export const platformPackage = (platform: string) => `@kition/cli-${platform}`

export interface Machine {
  env: Record<string, string | undefined>
  /** `process.platform` */
  platform: string
  /** `process.arch` */
  arch: string
  /** Linux only: false on a C library other than glibc (musl). */
  glibc?: boolean
  /** The folder of an installed package, or null. */
  packageDir(name: string): string | null
  isFile(path: string): boolean
  /** The real path of a file (symbolic links followed); the path itself when it has none. */
  realPath(path: string): string
  /** This launcher's own file, its real path (`<package>/dist/cli.js`). */
  self: string
  join(...parts: string[]): string
  dirname(path: string): string
  basename(path: string): string
}

export type Resolved = { ok: true; command: string; from: 'env' | 'package' } | { ok: false; message: string }

const exe = (platform: string) => (platform === 'win32' ? '.exe' : '')

export function supportedPlatforms(): string {
  const names = Object.entries(PLATFORMS).map(([key, platform]) => (platform.libc ? `${key} (${platform.libc})` : key))
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const INSTALL_SH = 'curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh'
const INSTALL_PS1 = 'irm https://github.com/KitionAI/kition-sdk/releases/latest/download/install.ps1 | iex'

export function resolveKition(machine: Machine): Resolved {
  const named = machine.env[BINARY_VARIABLE]
  if (named) {
    if (machine.isFile(named)) return { ok: true, command: named, from: 'env' }
    return { ok: false, message: `${BINARY_VARIABLE} names ${named}, which is no file. Point it at a kition executable, or unset it.` }
  }

  const key = `${machine.platform}-${machine.arch}`
  const platform = PLATFORMS[key]
  const notGlibc = platform?.libc === 'glibc' && machine.glibc === false
  const supported = platform && !notGlibc
  if (supported) {
    const dir = machine.packageDir(platformPackage(key))
    if (dir) {
      const kition = machine.join(dir, 'bin', `${KITION_NAME}${exe(machine.platform)}`)
      if (machine.isFile(kition)) return { ok: true, command: kition, from: 'package' }
    }
  }

  const here = notGlibc ? `${key} (not glibc: musl, as on Alpine)` : key
  const why = supported
    ? `The optional package ${platformPackage(key)} that carries it is not installed: npm leaves it out when optional dependencies are omitted (--omit=optional, --no-optional) or when the install ran on another platform. Install ${PACKAGE_NAME} again without omitting them.`
    : `${PACKAGE_NAME} carries no kition for ${here}.`
  const other = machine.platform === 'win32' ? INSTALL_PS1 : INSTALL_SH
  return {
    ok: false,
    message: [
      `no kition for this platform (${here}).`,
      why,
      `${PACKAGE_NAME} carries kition for ${supportedPlatforms()}.`,
      `Without npm, install kition with ${machine.platform === 'win32' ? 'install.ps1' : 'install.sh'}: ${other}`,
      `(https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md), or set ${BINARY_VARIABLE} to a kition executable.`,
    ].join('\n'),
  }
}

/** How the launcher was started, as kition reads it from `KITION_LAUNCHER` (JSON). */
export interface Launched {
  /** `npx`: from npx's cache; `npm`: npm's `kition` command, global or a project's. */
  via: 'npx' | 'npm'
  /** The command that starts this kition again, kition's arguments to follow. */
  command: string[]
  /** The executable the launcher started: kition takes the rest as its own only when it is that one. */
  executable: string
}

/**
 * How this launcher runs, and the command that starts it again; null when neither npx nor an npm
 * command of its own is to be seen (kition then registers its own path).
 *
 * - npx runs packages from its cache, `<npm cache>/_npx/<hash>/node_modules/@kition/cli`.
 * - npm's `kition` command: global, `<prefix>/bin/kition` (a link to this file) on macOS and
 *   Linux, `<prefix>\kition.cmd` on Windows, beside `<prefix>\node_modules`; a project's,
 *   `node_modules/.bin/kition` (`kition.cmd` on Windows). This file is
 *   `<modules>/@kition/cli/dist/cli.js` in both.
 */
export function launchedAs(machine: Machine, executable: string): Launched | null {
  const self = machine.self
  const parts = self.split(/[\\/]/)
  if (parts.includes('_npx')) return { via: 'npx', command: ['npx', '-y', PACKAGE_NAME], executable }
  // <modules>/@kition/cli/dist/cli.js
  const pkg = machine.dirname(machine.dirname(self))
  const scope = machine.dirname(pkg)
  if (`${machine.basename(scope)}/${machine.basename(pkg)}` !== PACKAGE_NAME) return null
  const modules = machine.dirname(scope)
  if (machine.basename(modules) !== 'node_modules') return null
  const windows = machine.platform === 'win32'
  const above = machine.dirname(modules)
  const candidates = windows
    ? [machine.join(above, `${KITION_NAME}.cmd`), machine.join(modules, '.bin', `${KITION_NAME}.cmd`)]
    : [...(machine.basename(above) === 'lib' ? [machine.join(machine.dirname(above), 'bin', KITION_NAME)] : []), machine.join(modules, '.bin', KITION_NAME)]
  for (const candidate of candidates) {
    // On Windows, npm's command is a .cmd that names this file; elsewhere, a link to it.
    if (machine.isFile(candidate) && (windows || machine.realPath(candidate) === self)) return { via: 'npm', command: [candidate], executable }
  }
  return null
}

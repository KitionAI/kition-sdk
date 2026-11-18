/**
 * What the launcher starts, and with which arguments. Pure: every look at the machine
 * (environment, files, installed packages) is passed in, so the order is testable.
 *
 * 1. `KITION_KITS_MCP`, an executable the person names (a development build): `kition`, started as
 *    `kition mcp`, or a `kition-kits-mcp`, started as it is. Named but missing is an error, never
 *    a quiet fall back to another.
 * 2. The optional package `@kition/kits-mcp-<platform>`, installed by npm with this one on the
 *    platforms it is built for: its `bin/kition`, started as `kition mcp`. It carries no kit: kition
 *    installs each kit into its store (~/.kition/kits) when the agent first needs it.
 * 3. On the PATH: `kition`, else a `kition-kits-mcp` other than this launcher itself (a global npm
 *    install puts the launcher on the PATH under that name). Not from a launcher that another
 *    started, so two launchers never start each other.
 */
import platforms from './platforms.json'

/** The environment variable naming the executable to start (sdk.json `binaries.mcp.env`). */
export const SERVER_VARIABLE = 'KITION_KITS_MCP'
/** Set by the launcher for the program it starts. */
export const LAUNCHED_VARIABLE = 'KITION_KITS_MCP_LAUNCHED'
/** The Kition command line (sdk.json `binaries.cli.name`), which the platform packages carry. */
export const KITION_NAME = 'kition'
/** The kits' MCP server alone (sdk.json `binaries.mcp.name`), and this launcher's command name. */
export const SERVER_NAME = 'kition-kits-mcp'
export const PACKAGE_NAME = '@kition/kits-mcp'

export interface Platform {
  os: string
  cpu: string
  libc?: string
  rustTarget: string
}

/** The platforms a server package is built for, by `${process.platform}-${process.arch}`. */
export const PLATFORMS: Readonly<Record<string, Platform>> = Object.fromEntries(Object.entries(platforms).filter(([key]) => !key.startsWith('$'))) as Record<string, Platform>

export const platformPackage = (platform: string) => `${PACKAGE_NAME}-${platform}`

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
  /** The real path of a file (symbolic links followed), for telling this launcher apart. */
  realPath(path: string): string
  /** This launcher's own file. */
  self: string
  /** The path separator of the PATH variable (`:`, or `;` on Windows). */
  delimiter: string
  join(...parts: string[]): string
}

/** `kition` (started as `kition mcp`), or a `kition-kits-mcp` (started as it is). */
export type Kind = 'kition' | 'server'

export type Resolved =
  | { ok: true; command: string; kind: Kind; from: 'env' | 'package' | 'path' }
  | { ok: false; message: string }

const exe = (platform: string) => (platform === 'win32' ? '.exe' : '')

/** `kition` or `kition.exe`, in any folder. */
const isKition = (file: string) => /(^|[\\/])kition(\.exe)?$/i.test(file)

export function supportedPlatforms(): string {
  const names = Object.entries(PLATFORMS).map(([key, platform]) => (platform.libc ? `${key} (${platform.libc})` : key))
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function resolveServer(machine: Machine): Resolved {
  const named = machine.env[SERVER_VARIABLE]
  if (named) {
    if (machine.isFile(named)) return { ok: true, command: named, kind: isKition(named) ? 'kition' : 'server', from: 'env' }
    return { ok: false, message: `${SERVER_VARIABLE} names ${named}, which is no file. Point it at a kition (or kition-kits-mcp) executable, or unset it.` }
  }

  const key = `${machine.platform}-${machine.arch}`
  const platform = PLATFORMS[key]
  const supported = platform && !(platform.libc === 'glibc' && machine.glibc === false)
  if (supported) {
    const dir = machine.packageDir(platformPackage(key))
    if (dir) {
      const kition = machine.join(dir, 'bin', `${KITION_NAME}${exe(machine.platform)}`)
      if (machine.isFile(kition)) return { ok: true, command: kition, kind: 'kition', from: 'package' }
    }
  }

  if (!machine.env[LAUNCHED_VARIABLE]) {
    const self = machine.realPath(machine.self)
    const folders = (machine.env.PATH ?? machine.env.Path ?? '').split(machine.delimiter).filter(Boolean)
    for (const [name, kind] of [[KITION_NAME, 'kition'], [SERVER_NAME, 'server']] as const) {
      for (const folder of folders) {
        const candidate = machine.join(folder, `${name}${exe(machine.platform)}`)
        if (machine.isFile(candidate) && machine.realPath(candidate) !== self) return { ok: true, command: candidate, kind, from: 'path' }
      }
    }
  }

  const here = machine.platform === 'linux' && platform?.libc === 'glibc' && machine.glibc === false ? `${key} (not glibc)` : key
  const why = supported
    ? `The optional package ${platformPackage(key)} that carries it is not installed: npm leaves it out when optional dependencies are omitted (--omit=optional, --no-optional) or the install ran on another platform.`
    : `${PACKAGE_NAME} carries no kition for ${here}.`
  return {
    ok: false,
    message: [
      `no kition for this platform (${here}).`,
      why,
      `${PACKAGE_NAME} carries kition for ${supportedPlatforms()}.`,
      `Otherwise install kition (https://github.com/KitionAI/kition-sdk/blob/main/docs/sdk/cli.md) and put it on the PATH, or set ${SERVER_VARIABLE} to a kition executable.`,
    ].join('\n'),
  }
}

/**
 * The arguments to start `resolved` with: `kition mcp` and the person's arguments, or the person's
 * arguments alone for a `kition-kits-mcp`. A `kit` command (`kit install note`, `kit list`) goes to
 * `kition` as it is, so the store can be filled before an agent starts; a `kition-kits-mcp` has no
 * such command, and gets null.
 */
export function serverArgs(args: readonly string[], kind: Kind): string[] | null {
  if (args[0] === 'kit') return kind === 'kition' ? [...args] : null
  return kind === 'kition' ? ['mcp', ...args] : [...args]
}

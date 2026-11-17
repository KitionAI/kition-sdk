/**
 * Which `kition-kits-mcp` the launcher starts, and with which kits. Pure: every look at the
 * machine (environment, files, installed packages) is passed in, so the order is testable.
 *
 * 1. `KITION_KITS_MCP`, an executable the person names (a development build). Named but missing
 *    is an error, never a quiet fall back to another server.
 * 2. The optional package `@kition/kits-mcp-<platform>`, installed by npm with this one on the
 *    platforms it is built for: its `bin/kition-kits-mcp`, with the kits it carries
 *    (`kits/<kit>/kit.json` beside `kits/<kit>/kition-<kit>`) as the default `--kits-dir`.
 * 3. `kition-kits-mcp` on the PATH, other than this launcher itself (a global npm install puts
 *    the launcher on the PATH under that name). Not from a launcher that another started, so two
 *    launchers never start each other.
 */
import platforms from './platforms.json'

/** The environment variable naming a kition-kits-mcp executable (sdk.json `binaries.mcp.env`). */
export const SERVER_VARIABLE = 'KITION_KITS_MCP'
/** Set by the launcher for the server it starts. */
export const LAUNCHED_VARIABLE = 'KITION_KITS_MCP_LAUNCHED'
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
  isDir(path: string): boolean
  /** The real path of a file (symbolic links followed), for telling this launcher apart. */
  realPath(path: string): string
  /** This launcher's own file. */
  self: string
  /** The path separator of the PATH variable (`:`, or `;` on Windows). */
  delimiter: string
  join(...parts: string[]): string
}

export type Resolved =
  | { ok: true; server: string; from: 'env' | 'package' | 'path'; kitsDir: string | null }
  | { ok: false; message: string }

const exe = (platform: string) => (platform === 'win32' ? '.exe' : '')

export function supportedPlatforms(): string {
  const names = Object.entries(PLATFORMS).map(([key, platform]) => (platform.libc ? `${key} (${platform.libc})` : key))
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function resolveServer(machine: Machine): Resolved {
  const named = machine.env[SERVER_VARIABLE]
  if (named) {
    if (machine.isFile(named)) return { ok: true, server: named, from: 'env', kitsDir: null }
    return { ok: false, message: `${SERVER_VARIABLE} names ${named}, which is no file. Point it at a kition-kits-mcp executable, or unset it.` }
  }

  const key = `${machine.platform}-${machine.arch}`
  const platform = PLATFORMS[key]
  const supported = platform && !(platform.libc === 'glibc' && machine.glibc === false)
  if (supported) {
    const dir = machine.packageDir(platformPackage(key))
    if (dir) {
      const server = machine.join(dir, 'bin', `${SERVER_NAME}${exe(machine.platform)}`)
      if (machine.isFile(server)) {
        const kits = machine.join(dir, 'kits')
        return { ok: true, server, from: 'package', kitsDir: machine.isDir(kits) ? kits : null }
      }
    }
  }

  if (!machine.env[LAUNCHED_VARIABLE]) {
    const self = machine.realPath(machine.self)
    for (const folder of (machine.env.PATH ?? machine.env.Path ?? '').split(machine.delimiter).filter(Boolean)) {
      const candidate = machine.join(folder, `${SERVER_NAME}${exe(machine.platform)}`)
      if (machine.isFile(candidate) && machine.realPath(candidate) !== self) return { ok: true, server: candidate, from: 'path', kitsDir: null }
    }
  }

  const here = machine.platform === 'linux' && platform?.libc === 'glibc' && machine.glibc === false ? `${key} (not glibc)` : key
  const why = supported
    ? `The optional package ${platformPackage(key)} that carries it is not installed: npm leaves it out when optional dependencies are omitted (--omit=optional, --no-optional) or the install ran on another platform.`
    : `${PACKAGE_NAME} carries no server for ${here}.`
  return {
    ok: false,
    message: [
      `no kition-kits-mcp for this platform (${here}).`,
      why,
      `${PACKAGE_NAME} carries kition-kits-mcp for ${supportedPlatforms()}.`,
      `Otherwise set ${SERVER_VARIABLE} to a kition-kits-mcp executable, or put one on the PATH: build it from https://github.com/KitionAI/kition-sdk with \`cargo build --release -p kition-kits --bin kition-kits-mcp\`.`,
    ].join('\n'),
  }
}

/**
 * The arguments for the server: the person's, with `--kits-dir <kitsDir>` added when they named no
 * kits themselves (`--kits-dir` or `--kit`).
 */
export function serverArgs(args: readonly string[], kitsDir: string | null): string[] {
  if (!kitsDir || args.includes('--kits-dir') || args.includes('--kit')) return [...args]
  return [...args, '--kits-dir', kitsDir]
}

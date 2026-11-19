import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Machine } from './resolve'

/** glibc or not, on Linux: Node's report names the glibc it runs on, and none on musl. */
function glibc(): boolean | undefined {
  if (process.platform !== 'linux') return undefined
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  return Boolean(header?.glibcVersionRuntime)
}

const realPath = (file: string) => {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/** This machine, as `resolveKition` and `launchedAs` look at it; `self` is the launcher's own file. */
export function thisMachine(self: string): Machine {
  const require = createRequire(self)
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    glibc: glibc(),
    packageDir(name) {
      try {
        return path.dirname(require.resolve(`${name}/package.json`))
      } catch {
        return null
      }
    },
    isFile: (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false,
    realPath,
    self: realPath(self),
    join: path.join,
    dirname: path.dirname,
    basename: path.basename,
  }
}

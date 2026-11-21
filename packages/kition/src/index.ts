/**
 * `@kition/cli` on npm: the `kition` command, a launcher that starts Kition's command line for this
 * platform (from the optional package `@kition/cli-<platform>`). This module is how it finds
 * kition, for programs that start kition themselves.
 */
export { BINARY_VARIABLE, KITION_NAME, LAUNCHER_VARIABLE, PACKAGE_NAME, PLATFORMS, REAL_SCOPE, SCOPE_VARIABLE, launchedAs, launcherScope, platformPackage, resolveKition, supportedPlatforms } from './resolve'
export type { Launched, Machine, Platform, Resolved } from './resolve'
export { thisMachine } from './machine'

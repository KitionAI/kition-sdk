/**
 * `@kition/kits-mcp`: the `kition-kits-mcp` command, which starts Kition's kits MCP server
 * (`kition mcp`, kition-sdk's command line) for this platform; kition installs the kits on first
 * use. This module is how it finds kition, for programs that start the server themselves.
 */
export { KITION_NAME, LAUNCHED_VARIABLE, PACKAGE_NAME, PLATFORMS, SERVER_NAME, SERVER_VARIABLE, platformPackage, resolveServer, serverArgs, supportedPlatforms } from './resolve'
export type { Kind, Machine, Platform, Resolved } from './resolve'
export { thisMachine } from './machine'

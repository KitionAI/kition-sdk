/**
 * `@kition/kits-mcp`: the `kition-kits-mcp` command, which starts Kition's kits MCP server
 * (kition-sdk's `kition-kits-mcp`) for this platform. This module is how it finds the server, for
 * programs that start the server themselves.
 */
export { LAUNCHED_VARIABLE, PACKAGE_NAME, PLATFORMS, SERVER_NAME, SERVER_VARIABLE, platformPackage, resolveServer, serverArgs, supportedPlatforms } from './resolve'
export type { Machine, Platform, Resolved } from './resolve'
export { thisMachine } from './machine'

// The types of registry.mjs, for the TypeScript tests that import it.
export function hermeticInstallEnv(base: string, url?: string, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function writeNpmrc(base: string, url: string): void
export function assertServed(requests: string[], packages: string[]): string[]
export function startRegistry(folder: string, port?: number, options?: { logRequests?: boolean }): Promise<{ url: string; requests: string[]; stop: () => Promise<void> }>
export function releaseArchives(out: string, kition: string): string

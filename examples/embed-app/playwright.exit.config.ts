import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The SDK exit path end to end (`pnpm test:sdk:exit`, local only): the example page keeps its
// files in one folder on its server (EMBED_WORKSPACE), and the agent example edits the same
// folder over MCP. Results and the folder go under EMBED_E2E_CACHE (~/.cache/kition-embed-e2e).
const here = path.dirname(fileURLToPath(import.meta.url))
const cache = process.env.EMBED_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-embed-e2e')
const appPort = Number(process.env.EMBED_EXIT_APP_PORT || 5330)
const kitsPort = Number(process.env.EMBED_EXIT_KITS_PORT || 5331)
// The test workers read it from the environment they inherit.
process.env.EMBED_EXIT_WORKSPACE ||= path.join(cache, 'exit-workspace')

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  testMatch: /exit\.flow\.ts$/,
  outputDir: path.join(cache, 'exit-results'),
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${appPort}`,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node ${JSON.stringify(path.join(here, 'serve.mjs'))}`,
    url: `http://127.0.0.1:${appPort}/`,
    env: {
      EMBED_APP_PORT: String(appPort),
      EMBED_KITS_PORT: String(kitsPort),
      EMBED_WORKSPACE: process.env.EMBED_EXIT_WORKSPACE,
    },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
})

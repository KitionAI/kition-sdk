import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The embed example's end-to-end tests (`pnpm test:embed:e2e`, local only). serve.mjs runs the
// page and the kit packages on two origins; kition-server is started per test (e2e/helpers.ts).
// Results and kition-server's configurations go under EMBED_E2E_CACHE (~/.cache/kition-embed-e2e).
const here = path.dirname(fileURLToPath(import.meta.url))
const appPort = Number(process.env.EMBED_E2E_APP_PORT || 5320)
const kitsPort = Number(process.env.EMBED_E2E_KITS_PORT || 5321)

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  testMatch: /\.e2e\.ts$/,
  outputDir: path.join(process.env.EMBED_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-embed-e2e'), 'results'),
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
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
    env: { EMBED_APP_PORT: String(appPort), EMBED_KITS_PORT: String(kitsPort) },
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
  },
})

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The gateway page's end-to-end tests (`pnpm test:gateway:e2e`, local only): each test starts a
// real `kition gateway` (target/debug/kition, or KITION_BINARY) on a workspace and a Kition home of
// its own, with the kits installed from the kit index's release assets (e2e/helpers.ts). Results and
// screenshots go under GATEWAY_E2E_CACHE (~/.cache/kition-gateway-e2e).
const here = path.dirname(fileURLToPath(import.meta.url))
const cache = process.env.GATEWAY_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-gateway-e2e')

export default defineConfig({
  testDir: path.join(here, 'e2e'),
  testMatch: /(gateway|drafts)\.e2e\.ts$/,
  outputDir: path.join(cache, 'results'),
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 }, trace: 'retain-on-failure' },
})

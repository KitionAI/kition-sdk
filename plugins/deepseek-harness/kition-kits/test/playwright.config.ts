import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// The plugin in a real DeepSeek Harness web UI (`pnpm test:dsh:e2e`, local only; `pnpm test:dsh:desktop`
// in the installed Desktop app, test/desktop.e2e.ts): the published
// @deepseek-ai/dsh runtime (test/e2e.sh's cache, DSH_KITS_CACHE), a profile from its `web` template
// with the packed plugin installed, a Kition home with the Table and Note kits from the gateway
// e2e's cache (GATEWAY_E2E_CACHE), and a scripted model, all under a temporary HOME. Results and
// screenshots go under GATEWAY_E2E_CACHE (~/.cache/kition-gateway-e2e).
const here = path.dirname(fileURLToPath(import.meta.url))
const cache = process.env.GATEWAY_E2E_CACHE || path.join(os.homedir(), '.cache', 'kition-gateway-e2e')

export default defineConfig({
  testDir: here,
  outputDir: path.join(cache, 'dsh-results'),
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 }, trace: 'retain-on-failure' },
  // `web`: the web UI in Chromium; `desktop`: the installed DeepSeek Harness Desktop app (macOS).
  projects: [
    { name: 'web', testMatch: /web\.e2e\.ts$/ },
    { name: 'desktop', testMatch: /desktop\.e2e\.ts$/ },
  ],
})

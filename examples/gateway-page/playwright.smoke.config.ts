import config from './playwright.config'

// Every kit's editor in the gateway page (`pnpm test:gateway:smoke`, local only; it downloads every
// editor package on its first run): e2e/smoke.e2e.ts.
export default { ...config, testMatch: /smoke\.e2e\.ts$/ }

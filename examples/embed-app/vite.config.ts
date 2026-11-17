import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The example page, run by serve.mjs. It imports @kition/embed and @kition/script as an integrator
// would: the built libraries (`pnpm --filter @kition/embed --filter @kition/script build`), not their
// sources.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@kition/embed': fileURLToPath(new URL('../../packages/embed/dist/index.js', import.meta.url)),
      '@kition/script/kits/note': fileURLToPath(new URL('../../packages/script/dist/kits/note.js', import.meta.url)),
      '@kition/script': fileURLToPath(new URL('../../packages/script/dist/index.js', import.meta.url)),
    },
  },
  clearScreen: false,
})

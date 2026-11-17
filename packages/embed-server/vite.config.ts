import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The shipped package's modules (tools/sdk-bundle.mjs), one per export plus the CLI, for Node:
// Node's own modules, @kition/sync and @kition/embed stay imports. Declarations: tools/package-types.mjs.
const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig({
  build: {
    lib: { entry: { index: entry('./src/index.ts'), callbacks: entry('./src/callbacks.ts'), cli: entry('./src/cli.ts') }, formats: ['es'] },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: true,
    rollupOptions: {
      external: [/^node:/, /^@kition\//],
      output: { chunkFileNames: 'chunks/[name]-[hash].js', banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : '') },
    },
  },
})

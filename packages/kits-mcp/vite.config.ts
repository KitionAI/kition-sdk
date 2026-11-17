import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The shipped package's modules, for Node: the library (`index`) and the `kition-kits-mcp` command
// (`cli`), with platforms.json inlined. Declarations: tools/package-types.mjs.
const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig({
  build: {
    lib: { entry: { index: entry('./src/index.ts'), cli: entry('./src/cli.ts') }, formats: ['es'] },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node20',
    sourcemap: false,
    rollupOptions: {
      external: [/^node:/],
      output: { chunkFileNames: 'chunks/[name]-[hash].js', banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : '') },
    },
  },
})

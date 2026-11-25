import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The shipped package's modules (tools/sdk-bundle.mjs), one per export. Declarations:
// tools/package-types.mjs.
const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))
export default defineConfig({
  build: {
    lib: { entry: { index: entry('./src/index.ts'), openToken: entry('./src/openToken.ts') }, formats: ['es'] },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
  },
})

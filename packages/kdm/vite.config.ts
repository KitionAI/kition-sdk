import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The shipped package's module (tools/sdk-bundle.mjs): one ES module without dependencies.
// Declarations: tools/package-types.mjs.
export default defineConfig({
  build: {
    lib: { entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)), formats: ['es'], fileName: 'index' },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
})

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The library build: one ES module (and the chunks it loads on demand) holding the kit host and
// the Kit UI protocol, so a page needs no bundler setup for it.
export default defineConfig({
  build: {
    lib: { entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)), formats: ['es'], fileName: 'index' },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
  },
})

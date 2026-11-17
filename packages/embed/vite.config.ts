import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The library build: one ES module (and the chunks it loads on demand) holding the kit host, the
// Kit UI protocol, the sync client and its relay, and Loro (only in the collaboration chunk), with
// Loro's WebAssembly inlined, so a page needs no bundler setup for it.
export default defineConfig({
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] },
  build: {
    lib: { entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)), formats: ['es'], fileName: 'index' },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
  },
})

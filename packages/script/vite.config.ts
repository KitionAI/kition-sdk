import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'
import { defineConfig } from 'vite'

const entry = (path: string) => fileURLToPath(new URL(path, import.meta.url))
/** The generated kits (kits/<kit>.ts) and their index. */
const KITS = readdirSync(new URL('./kits/', import.meta.url)).filter((name) => name.endsWith('.ts')).map((name) => name.slice(0, -3)).sort()

// The library build: ES modules for pages (`index`) and Node (`node`), and one module per
// generated kit, with Loro's WebAssembly inlined so neither needs bundler setup.
export default defineConfig({
  resolve: { alias: [{ find: /^loro-crdt$/, replacement: 'loro-crdt/base64' }] },
  build: {
    lib: { entry: { index: entry('./src/index.ts'), node: entry('./src/node.ts'), proxy: entry('./src/proxy.ts'), ...Object.fromEntries(KITS.map((kit) => [`kits/${kit}`, entry(`./kits/${kit}.ts`)])) }, formats: ['es'] },
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { external: [/^node:/], output: { chunkFileNames: 'chunks/[name]-[hash].js' } },
  },
})

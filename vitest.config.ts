import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // @kition/tessera-ui is linked from a kition-tessera checkout with its own React; one React for the tests.
    dedupe: ['react', 'react-dom'],
  },
})

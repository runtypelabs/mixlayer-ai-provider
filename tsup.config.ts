import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  target: 'node22',
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // AI SDK packages are runtime dependencies — keep them external so a single
  // provider stack is deduped by the host app.
  external: ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/openai'],
  outExtension() {
    return { js: '.mjs' }
  },
})

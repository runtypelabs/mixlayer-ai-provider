import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  target: 'node22',
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // AI SDK packages and ws are runtime dependencies — keep them external so a
  // single provider/transport stack is deduped by the host app.
  external: ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/openai', 'ws'],
  outExtension() {
    return { js: '.mjs' }
  },
})

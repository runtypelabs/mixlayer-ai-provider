import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  target: 'node22',
  format: ['esm'],
  dts: {
    compilerOptions: { ignoreDeprecations: '6.0' },
  },
  sourcemap: true,
  clean: true,
  // AI SDK packages are runtime dependencies — keep them external so a single
  // provider stack is deduped by the host app.
  deps: { neverBundle: ['ai', '@ai-sdk/openai-compatible', '@ai-sdk/openai'] },
  outExtensions() {
    return { js: '.mjs', dts: '.d.ts' }
  },
})

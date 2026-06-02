import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // `ai` and `@ai-sdk/openai-compatible` are the consumer's AI SDK — keep them
  // external so a single version is deduped by the host app.
  external: ['ai', '@ai-sdk/openai-compatible'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.mjs' : '.cjs',
    }
  },
})

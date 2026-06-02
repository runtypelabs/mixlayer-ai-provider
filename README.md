# @runtypelabs/mixlayer-ai-provider

[![npm](https://img.shields.io/npm/v/@runtypelabs/mixlayer-ai-provider.svg)](https://www.npmjs.com/package/@runtypelabs/mixlayer-ai-provider)
[![license](https://img.shields.io/npm/l/@runtypelabs/mixlayer-ai-provider.svg)](./LICENSE)

An [AI SDK](https://sdk.vercel.ai) provider for **Mixlayer** — open-weight model
inference served over an OpenAI-compatible endpoint at
`https://models.mixlayer.ai/v1`. Mixlayer's catalog is currently the
[Qwen](https://qwenlm.github.io) 3.5 / 3.6 family, and is expected to grow to
other open-weight families (e.g. Kimi) over time — the provider is
model-family-agnostic and only layers family-specific tuning on models it
recognizes.

It wraps [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
and bakes in everything Mixlayer needs to behave correctly:

- the Mixlayer base URL default
- family-specific sampling defaults — currently the recommended Qwen open-weight
  defaults (thinking / non-thinking, including the vLLM
  `chat_template_kwargs.enable_thinking` toggle), **scoped to the Qwen 3.5 / 3.6
  models** and overridable per request (see below)
- reasoning middleware that extracts `<think>` tags into AI SDK reasoning parts
  (the provider also emits native `reasoning_content`)
- tolerant model-id handling (strips a leading `mixlayer/` prefix)

### Models

The current Mixlayer chat catalog (see the
[Mixlayer models page](https://models.mixlayer.ai) for the live list and pricing):

| Model id                      |
| ----------------------------- |
| `qwen/qwen3.5-4b-free`        |
| `qwen/qwen3.5-9b`             |
| `qwen/qwen3.5-27b`            |
| `qwen/qwen3.5-35b-a3b`        |
| `qwen/qwen3.5-397b-a17b`      |
| `qwen/qwen3.6-27b`            |
| `qwen/qwen3.6-35b-a3b`        |

These are exported as the open `MixlayerChatModelId` union (for editor
autocomplete) — any model id string is still accepted, so new models and future
non-Qwen families work without a package update.

### Sampling defaults are scoped to Qwen 3.5 / 3.6

The bundled sampling defaults come from the official Qwen HuggingFace model
cards' [recommended sampling parameters](https://huggingface.co/Qwen/Qwen3.6-35B-A3B#:~:text=We%20recommend%20using%20the%20following%20set%20of%20sampling%20parameters%20for%20generation),
which are tuned for the **3.5** and **3.6** generations. The provider applies
them only to those models, so later Qwen generations and other model families
pass through untouched. The defaults are also overridable per call — any
`temperature` / `top_p` / etc. you set on the request takes precedence. Use the
exported `isQwen35Or36(modelId)` helper if you need the same predicate.

## Install

```bash
pnpm add @runtypelabs/mixlayer-ai-provider ai
```

`ai` is a peer dependency, so your app dedupes a single AI SDK version.

## Usage

```ts
import { mixlayer } from '@runtypelabs/mixlayer-ai-provider'
import { streamText } from 'ai'

const result = streamText({
  model: mixlayer('qwen/qwen3.6-27b'),
  prompt: 'Explain reasoning models in one paragraph.',
})

for await (const text of result.textStream) process.stdout.write(text)
```

The default `mixlayer` instance reads `MIXLAYER_API_KEY` from the environment
(Node). To set the key (or any other option) explicitly — required in
Cloudflare Workers / the browser — create your own provider with
`createMixlayer`.

### Explicit settings

```ts
import { createMixlayer } from '@runtypelabs/mixlayer-ai-provider'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // use the non-thinking Qwen sampling defaults
})

const model = provider('qwen/qwen3.5-9b')
```

### Provider registry

The provider implements the AI SDK provider shape, so it slots into
`createProviderRegistry`:

```ts
import { createProviderRegistry } from 'ai'

const registry = createProviderRegistry({ mixlayer })
const model = registry.languageModel('mixlayer:qwen/qwen3.6-27b')
```

## API

| Export                                                         | Description                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mixlayer`                                                     | Default provider instance (thinking mode, no API key configured) |
| `createMixlayer(settings)`                                     | Provider factory                                                 |
| `extractMixlayerModelId(id)`                                   | Strips a leading `mixlayer/` prefix                              |
| `getMixlayerSamplingDefaults(thinking)`                        | Returns the Qwen sampling defaults for a mode                    |
| `isQwen35Or36(modelId)`                                        | Whether an id is a Qwen 3.5 / 3.6 model (the scoped generations) |
| `applyQwenSamplingDefaults(body, thinking?)`                   | Applies the defaults to a request body, scoped to Qwen 3.5 / 3.6 |
| `MIXLAYER_DEFAULT_BASE_URL`                                    | `https://models.mixlayer.ai/v1`                                  |
| `MIXLAYER_THINKING_DEFAULTS` / `MIXLAYER_NON_THINKING_DEFAULTS` | The raw sampling-default objects                                 |

The provider also exposes `provider.languageModel(id)` / `provider.chatModel(id)`
(equivalent to calling `provider(id)`).

### `MixlayerProviderSettings`

| Option     | Type                      | Default                       | Description                                                              |
| ---------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `apiKey`   | `string`                  | —                             | Mixlayer API key                                                         |
| `baseURL`  | `string`                  | `MIXLAYER_DEFAULT_BASE_URL`   | Override the inference endpoint                                          |
| `headers`  | `Record<string, string>`  | —                             | Extra headers sent with every request                                   |
| `fetch`    | `typeof fetch`            | `globalThis.fetch`            | Custom fetch (e.g. instrumented or proxied)                             |
| `thinking` | `boolean`                 | `true`                        | Apply the thinking (`true`) or non-thinking (`false`) sampling defaults |

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup (ESM + CJS + d.ts)
```

## Releasing

Versioning and npm publishing are driven by
[changesets](https://github.com/changesets/changesets).

1. For any user-facing change, add a changeset and pick a bump type:

   ```bash
   pnpm changeset
   ```

2. On push to `main`, the Release workflow opens (or updates) a **Version
   Packages** PR that applies the pending changesets.
3. Merging that PR bumps the version, regenerates this `CHANGELOG.md`, and
   publishes to npm with provenance.

Publishing requires an `NPM_TOKEN` repository secret with publish rights to the
`@runtypelabs` npm org (the package is published as
`@runtypelabs/mixlayer-ai-provider`).

## License

[MIT](./LICENSE) © Runtype Labs

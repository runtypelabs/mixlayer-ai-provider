# mixlayer-ai-provider

[![npm](https://img.shields.io/npm/v/mixlayer-ai-provider.svg)](https://www.npmjs.com/package/mixlayer-ai-provider)
[![license](https://img.shields.io/npm/l/mixlayer-ai-provider.svg)](./LICENSE)

An [AI SDK](https://sdk.vercel.ai) provider for **Mixlayer** — the open-weight
[Qwen](https://qwenlm.github.io) inference API served over an OpenAI-compatible
endpoint at `https://models.mixlayer.ai/v1`.

It wraps [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
and bakes in everything Mixlayer needs to behave correctly:

- the Mixlayer base URL default
- the official Qwen open-weight sampling defaults (thinking / non-thinking),
  including the vLLM `chat_template_kwargs.enable_thinking` toggle —
  **scoped to Qwen 3.5 / 3.6 models** and overridable per request (see below)
- reasoning middleware that extracts `<think>` tags into AI SDK reasoning parts
  (the provider also emits native `reasoning_content`)
- an optional Cloudflare AI Gateway fetch wrapper
- tolerant model-id handling (strips a leading `mixlayer/` prefix)

### Sampling defaults are scoped to Qwen 3.5 / 3.6

The bundled sampling defaults are only tuned for the open-weight Qwen **3.5** and
**3.6** generations, so the provider applies them only to those models
(`qwen3-5-*`, `qwen3-6-*`). Future Qwen generations (3.7+) and any non-Qwen model
pass through untouched. The defaults are also overridable per call — any
`temperature` / `top_p` / etc. you set on the request takes precedence. Use the
exported `isQwen35Or36(modelId)` helper if you need the same predicate.

## Install

```bash
pnpm add mixlayer-ai-provider ai
```

`ai` is a peer dependency, so your app dedupes a single AI SDK version.

## Usage

```ts
import { mixlayer } from 'mixlayer-ai-provider'
import { streamText } from 'ai'

const result = streamText({
  model: mixlayer('qwen3-6-27b'),
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
import { createMixlayer } from 'mixlayer-ai-provider'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // use the non-thinking Qwen sampling defaults
})

const model = provider('qwen/qwen3-8b')
```

### Cloudflare AI Gateway

```ts
const provider = createMixlayer({
  apiKey,
  gateway: {
    viaCfGateway: true,
    // Only needed in local dev (wrangler/bun); in production CF Workers,
    // Worker identity handles gateway auth automatically.
    cfGatewayToken: process.env.CF_AI_GATEWAY_TOKEN,
  },
})
```

### Embeddings

If your Mixlayer deployment exposes an OpenAI-compatible `/embeddings` endpoint,
use a Qwen embedding model:

```ts
import { embed } from 'ai'

const { embedding } = await embed({
  model: provider.textEmbeddingModel('qwen3-embedding-8b'),
  value: 'hello world',
})
```

### Provider registry

The provider implements the AI SDK provider shape, so it slots into
`createProviderRegistry`:

```ts
import { createProviderRegistry } from 'ai'

const registry = createProviderRegistry({ mixlayer })
const model = registry.languageModel('mixlayer:qwen3-6-27b')
```

## API

| Export                                                         | Description                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mixlayer`                                                     | Default provider instance (thinking mode, no API key configured) |
| `createMixlayer(settings)`                                     | Provider factory                                                 |
| `createMixlayerFetch(baseFetch, gateway?)`                     | Cloudflare AI Gateway fetch wrapper                              |
| `extractMixlayerModelId(id)`                                   | Strips a leading `mixlayer/` prefix                              |
| `getMixlayerSamplingDefaults(thinking)`                        | Returns the Qwen sampling defaults for a mode                    |
| `isQwen35Or36(modelId)`                                        | Whether an id is a Qwen 3.5 / 3.6 model (the scoped generations) |
| `applyQwenSamplingDefaults(body, thinking?)`                   | Applies the defaults to a request body, scoped to Qwen 3.5 / 3.6 |

The provider also exposes `provider.languageModel(id)` / `provider.chatModel(id)`
(equivalent to calling `provider(id)`) and `provider.textEmbeddingModel(id)`.
| `MIXLAYER_DEFAULT_BASE_URL`                                    | `https://models.mixlayer.ai/v1`                                  |
| `MIXLAYER_THINKING_DEFAULTS` / `MIXLAYER_NON_THINKING_DEFAULTS` | The raw sampling-default objects                                 |

### `MixlayerProviderSettings`

| Option     | Type                      | Default                       | Description                                                              |
| ---------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `apiKey`   | `string`                  | —                             | Mixlayer API key                                                         |
| `baseURL`  | `string`                  | `MIXLAYER_DEFAULT_BASE_URL`   | Override the inference endpoint                                          |
| `headers`  | `Record<string, string>`  | —                             | Extra headers sent with every request                                   |
| `fetch`    | `typeof fetch`            | `globalThis.fetch`            | Custom fetch (e.g. instrumented or proxied)                             |
| `gateway`  | `MixlayerGatewayOptions`  | —                             | Cloudflare AI Gateway routing                                            |
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

Publishing requires an `NPM_TOKEN` repository secret with publish rights to
`mixlayer-ai-provider`.

## License

[MIT](./LICENSE) © Runtype Labs

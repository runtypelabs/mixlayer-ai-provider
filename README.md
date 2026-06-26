# @runtypelabs/mixlayer-ai-provider

[![npm](https://img.shields.io/npm/v/@runtypelabs/mixlayer-ai-provider.svg)](https://www.npmjs.com/package/@runtypelabs/mixlayer-ai-provider)
[![license](https://img.shields.io/npm/l/@runtypelabs/mixlayer-ai-provider.svg)](./LICENSE)

An [AI SDK](https://sdk.vercel.ai) provider for [Mixlayer](https://www.mixlayer.com/) —
fast, open-weight model inference served over an OpenAI-compatible endpoint.
Mixlayer's catalog is currently the [Qwen](https://qwenlm.github.io) 3.5 / 3.6
family and grows over time; this provider is model-family-agnostic and only
layers family-specific tuning on models it recognizes.

It wraps [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
and bakes in everything Mixlayer needs to behave correctly out of the box:

- the Mixlayer base URL
- recommended Qwen sampling defaults (thinking / non-thinking), scoped to the
  Qwen 3.5 / 3.6 models and overridable per request
- reasoning support — `<think>` tags and native `reasoning_content` both surface
  as AI SDK reasoning parts
- tolerant model-id handling (strips a leading `mixlayer/` prefix)

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
(Node). To set the key (or any other option) explicitly, create your own
provider with `createMixlayer`:

```ts
import { createMixlayer } from '@runtypelabs/mixlayer-ai-provider'

const provider = createMixlayer({
  apiKey: process.env.MIXLAYER_API_KEY,
  thinking: false, // use the non-thinking Qwen sampling defaults
})

const model = provider('qwen/qwen3.5-9b')
```

The provider also slots into `createProviderRegistry`:

```ts
import { createProviderRegistry } from 'ai'

const registry = createProviderRegistry({ mixlayer })
const model = registry.languageModel('mixlayer:qwen/qwen3.6-27b')
```

## Models

Pass any model id from Mixlayer's catalog — see the
[Mixlayer models page](https://docs.mixlayer.com/models) for the live list and
pricing. Ids look like `qwen/qwen3.6-27b` or `moonshotai/kimi-k2.6`.

The `MixlayerChatModelId` union ships a snapshot of the known ids for editor
autocomplete, but the union is open — any model id string is accepted, so new
models and future families work without a package update.

## Sampling defaults

The provider applies Mixlayer's recommended Qwen sampling defaults
automatically, drawn from Mixlayer's
[chat completions parameter reference](https://docs.mixlayer.com/chat-completions#sampling-parameters)
and [per-model notes](https://docs.mixlayer.com/models#qwen-35). They apply
**only to Qwen 3.5 / 3.6 models**, so later Qwen generations and other model
families pass through untouched. Any `temperature` / `top_p` / etc. you set on a
request always takes precedence. Use the exported `isQwen35Or36(modelId)` helper
if you need the same predicate.

## API

| Export                                                          | Description                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `mixlayer`                                                      | Default provider instance (thinking mode, key from env)          |
| `createMixlayer(settings)`                                      | Provider factory                                                 |
| `extractMixlayerModelId(id)`                                    | Strips a leading `mixlayer/` prefix                              |
| `getMixlayerSamplingDefaults(thinking)`                         | Returns the Qwen sampling defaults for a mode                    |
| `isQwen35Or36(modelId)`                                         | Whether an id is a Qwen 3.5 / 3.6 model (the scoped generations) |
| `applyQwenSamplingDefaults(body, thinking?)`                    | Applies the defaults to a request body, scoped to Qwen 3.5 / 3.6 |
| `MIXLAYER_DEFAULT_BASE_URL`                                     | `https://models.mixlayer.ai/v1`                                  |
| `MIXLAYER_THINKING_DEFAULTS` / `MIXLAYER_NON_THINKING_DEFAULTS` | The raw sampling-default objects                                 |

The provider also exposes `provider.languageModel(id)` / `provider.chatModel(id)`
(equivalent to calling `provider(id)`).

### `MixlayerProviderSettings`

| Option         | Type                     | Default                     | Description                                                              |
| -------------- | ------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `apiKey`       | `string`                 | `MIXLAYER_API_KEY` env      | Mixlayer API key                                                         |
| `baseURL`      | `string`                 | `MIXLAYER_DEFAULT_BASE_URL` | Override the inference endpoint                                          |
| `headers`      | `Record<string, string>` | —                           | Extra headers sent with every request                                   |
| `fetch`        | `typeof fetch`           | `globalThis.fetch`          | Custom fetch (e.g. instrumented or proxied)                             |
| `includeUsage` | `boolean`                | —                           | Include usage information in streaming responses                        |
| `thinking`     | `boolean`                | `true`                      | Apply the thinking (`true`) or non-thinking (`false`) sampling defaults |

## License

[MIT](./LICENSE)

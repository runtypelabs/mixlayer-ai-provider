import { createProviderRegistry } from 'ai'
import { NoSuchModelError } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import { createMixlayer } from '../src/index'

describe('AI SDK provider registry', () => {
  it.each(['chat', 'responses'] as const)(
    'routes language models through the configured %s API',
    defaultModelApi => {
      const provider = createMixlayer({ apiKey: 'test', defaultModelApi })
      const registry = createProviderRegistry({ mixlayer: provider })
      const model = registry.languageModel('mixlayer:qwen/qwen3.8-27b')

      expect(model.modelId).toBe('qwen/qwen3.8-27b')
      expect(model.provider).toBe(`mixlayer.${defaultModelApi}`)
      expect(model.specificationVersion).toBe('v4')
    }
  )

  it.each(['embeddingModel', 'imageModel'] as const)(
    'rejects unsupported %s requests with the SDK model error',
    modelType => {
      const registry = createProviderRegistry({
        mixlayer: createMixlayer({ apiKey: 'test' }),
      })

      const getModel = modelType === 'embeddingModel'
        ? () => registry.embeddingModel('mixlayer:unsupported-model')
        : () => registry.imageModel('mixlayer:unsupported-model')
      expect(getModel).toThrow(
        new NoSuchModelError({ modelId: 'unsupported-model', modelType })
      )
    }
  )
})

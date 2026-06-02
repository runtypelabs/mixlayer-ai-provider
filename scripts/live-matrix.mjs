#!/usr/bin/env node

import {
  Output,
  createProviderRegistry,
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
} from 'ai'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

let providerModule
try {
  providerModule = await import('../dist/index.mjs')
} catch (error) {
  console.error('Could not import ../dist/index.mjs. Run `pnpm run build` first.')
  console.error(redact(String(error?.message ?? error)))
  process.exit(1)
}

const {
  MIXLAYER_DEFAULT_BASE_URL,
  createMixlayer,
  isQwen35Or36,
} = providerModule

const KNOWN_MODELS = [
  'qwen/qwen3.5-4b-free',
  'qwen/qwen3.5-9b',
  'qwen/qwen3.5-27b',
  'qwen/qwen3.5-35b-a3b',
  'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.6-35b-a3b',
]

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  printHelp()
  process.exit(0)
}

const apiKey = process.env.MIXLAYER_API_KEY
if (!apiKey) {
  console.error('MIXLAYER_API_KEY is required for live tests.')
  process.exit(1)
}

const baseURL = stripTrailingSlash(
  args.baseUrl ?? process.env.MIXLAYER_BASE_URL ?? MIXLAYER_DEFAULT_BASE_URL
)
const concurrency = parsePositiveInt(
  args.concurrency ?? process.env.MIXLAYER_LIVE_CONCURRENCY,
  1
)
const timeoutMs = parsePositiveInt(
  args.timeoutMs ?? process.env.MIXLAYER_LIVE_TIMEOUT_MS,
  120_000
)
const maxRetries = parseNonNegativeInt(
  args.maxRetries ?? process.env.MIXLAYER_LIVE_MAX_RETRIES,
  0
)
const outputPath = resolve(
  projectRoot,
  args.output ?? `live-test-results/mixlayer-live-${timestamp()}.json`
)
const includeStructured = args.structured !== false
const includeTools = args.tools === true

const selectedModes = parseList(args.modes, ['generate', 'stream'])
const selectedThinkingModes = parseThinkingModes(args.thinking, [true, false])
const cases = selectCases(
  buildCases({ includeStructured, includeTools }),
  parseList(args.cases)
)
const models = await resolveModels()

const tasks = []
for (const modelId of models) {
  for (const thinking of selectedThinkingModes) {
    for (const testCase of cases) {
      if (testCase.thinkingModes && !testCase.thinkingModes.includes(thinking)) {
        continue
      }
      for (const mode of selectedModes) {
        if (testCase.modes.includes(mode)) {
          tasks.push({ modelId, thinking, testCase, mode })
        }
      }
    }
  }
}

console.log(`Mixlayer live matrix`)
console.log(`Base URL: ${baseURL}`)
console.log(`Models: ${models.join(', ')}`)
console.log(`Thinking modes: ${selectedThinkingModes.map(String).join(', ')}`)
console.log(`Cases: ${cases.map(testCase => testCase.id).join(', ')}`)
console.log(`Modes: ${selectedModes.join(', ')}`)
console.log(`Tasks: ${tasks.length}; concurrency: ${concurrency}; timeout: ${timeoutMs}ms`)
console.log('')

const startedAt = new Date()
const results = await runQueue(tasks, concurrency, runTask)
const finishedAt = new Date()
const passed = results.filter(result => result.status === 'passed').length
const failed = results.length - passed

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
  outputPath,
  JSON.stringify(
    {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      baseURL,
      models,
      thinkingModes: selectedThinkingModes,
      modes: selectedModes,
      cases: cases.map(({ id, description, modes }) => ({ id, description, modes })),
      summary: { tasks: results.length, passed, failed },
      results,
    },
    null,
    2
  )
)

console.log('')
console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed`)
console.log(`Report: ${outputPath}`)

if (failed > 0) {
  console.log('')
  for (const result of results.filter(result => result.status === 'failed')) {
    console.log(
      `FAIL ${result.modelId} thinking=${result.thinking} ${result.caseId}/${result.mode}: ${result.error?.message}`
    )
  }
  process.exitCode = 1
}

async function runTask(task, index, total) {
  const started = Date.now()
  const calls = []
  const label = `${task.modelId} thinking=${task.thinking} ${task.testCase.id}/${task.mode}`

  try {
    const fetch = async (input, init = {}) => {
      const call = {
        url: redact(String(input)),
        method: init.method ?? 'GET',
        requestBody: parseRequestBody(init.body),
        startedAt: new Date().toISOString(),
      }

      const callStarted = Date.now()
      try {
        const response = await globalThis.fetch(input, init)
        call.status = response.status
        call.durationMs = Date.now() - callStarted
        calls.push(call)
        return response
      } catch (error) {
        call.durationMs = Date.now() - callStarted
        call.error = errorSummary(error)
        calls.push(call)
        throw error
      }
    }

    const provider = createMixlayer({
      apiKey,
      baseURL,
      thinking: task.thinking,
      fetch,
      ...(task.testCase.providerSettings?.(task) ?? {}),
    })
    const model =
      task.testCase.viaRegistry === true
        ? createProviderRegistry({ mixlayer: provider }).languageModel(
            `mixlayer:${task.modelId}`
          )
        : provider(task.modelId)

    const callOptions = {
      model,
      maxRetries,
      timeout: { totalMs: timeoutMs },
      ...task.testCase.options(),
    }

    let output
    if (task.mode === 'generate') {
      output = await runGenerate(callOptions, task.testCase)
    } else {
      output = await runStream(callOptions, task.testCase)
    }

    const assertions = [
      ...assertRequest({ task, calls, output }),
      ...task.testCase.assertOutput(output),
    ]
    const failures = assertions.filter(assertion => assertion.status === 'failed')
    const result = {
      status: failures.length === 0 ? 'passed' : 'failed',
      modelId: task.modelId,
      thinking: task.thinking,
      caseId: task.testCase.id,
      mode: task.mode,
      durationMs: Date.now() - started,
      output,
      requestCalls: calls,
      assertions,
    }

    if (failures.length > 0) {
      result.error = {
        message: failures.map(assertion => assertion.message).join('; '),
      }
    }

    logProgress(index, total, result.status, label, result.durationMs)
    return result
  } catch (error) {
    const result = {
      status: 'failed',
      modelId: task.modelId,
      thinking: task.thinking,
      caseId: task.testCase.id,
      mode: task.mode,
      durationMs: Date.now() - started,
      requestCalls: calls,
      error: errorSummary(error),
    }
    logProgress(index, total, 'failed', label, result.durationMs)
    return result
  }
}

async function runGenerate(callOptions, testCase) {
  const result = await generateText(callOptions)
  return compact({
    textLength: result.text?.length ?? 0,
    textSample: sample(result.text),
    reasoningLength: result.reasoningText?.length ?? 0,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
    usage: result.usage,
    totalUsage: result.totalUsage,
    warnings: result.warnings,
    output: testCase.captureStructuredOutput ? result.output : undefined,
    toolCalls: result.steps.flatMap(step => step.toolCalls ?? []).map(toolCall => ({
      toolName: toolCall.toolName,
      input: toolCall.input,
    })),
    toolResults: result.steps.flatMap(step => step.toolResults ?? []).map(toolResult => ({
      toolName: toolResult.toolName,
      output: toolResult.output,
    })),
  })
}

async function runStream(callOptions) {
  const result = streamText(callOptions)
  let text = ''
  let reasoningText = ''
  const partCounts = {}

  for await (const part of result.fullStream) {
    partCounts[part.type] = (partCounts[part.type] ?? 0) + 1
    if (part.type === 'text-delta') text += part.text
    if (part.type === 'reasoning-delta') reasoningText += part.text
  }

  const [warnings, usage, providerMetadata] = await Promise.all([
    result.warnings.catch(errorSummary),
    result.totalUsage.catch(errorSummary),
    result.providerMetadata.catch(errorSummary),
  ])

  return compact({
    textLength: text.length,
    textSample: sample(text),
    reasoningLength: reasoningText.length,
    reasoningSample: sample(reasoningText),
    partCounts,
    warnings,
    totalUsage: usage,
    providerMetadataKeys:
      providerMetadata && typeof providerMetadata === 'object'
        ? Object.keys(providerMetadata)
        : undefined,
  })
}

function buildCases({ includeStructured, includeTools }) {
  const cases = [
    {
      id: 'default',
      description: 'Default provider settings with a short text response.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
      }),
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'temperature',
      description: 'Caller temperature override beats provider defaults.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        temperature: 0.2,
      }),
      expectedBody: { temperature: 0.2 },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'top-p',
      description: 'Caller topP override is sent as top_p.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        topP: 0.73,
      }),
      expectedBody: { top_p: 0.73 },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'penalties',
      description: 'Caller frequency and presence penalties are sent.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
      }),
      expectedBody: {
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
      },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'stop-sequence',
      description: 'Stop sequence is sent and should not appear in final text.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Write OK, then write the exact token STOP.',
        maxOutputTokens: 48,
        stopSequences: ['STOP'],
      }),
      expectedBody: { stop: ['STOP'] },
      assertOutput: output => [
        ...assertTextOrReasoning(output),
        passIf(
          !String(output.textSample ?? '').includes('STOP'),
          'output did not include the stop token',
          'output included the stop token'
        ),
      ],
    },
    {
      id: 'seed',
      description: 'Seed is passed through.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        seed: 1234,
      }),
      expectedBody: { seed: 1234 },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'supported-provider-params',
      description: 'Provider-specific supported Mixlayer parameters override defaults.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        providerOptions: {
          mixlayer: {
            top_k: 5,
            repetition_penalty: 1.01,
          },
        },
      }),
      expectedBody: {
        top_k: 5,
        repetition_penalty: 1.01,
      },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'max-completion-tokens',
      description: 'Mixlayer max_completion_tokens is sent through provider options.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        providerOptions: {
          mixlayer: {
            max_completion_tokens: 48,
          },
        },
      }),
      expectedBody: {
        max_completion_tokens: 48,
      },
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'playground-sampling',
      description:
        'Playground-style stream request with all exposed sampling and penalty controls, including observed min_p.',
      modes: ['stream'],
      providerSettings: () => ({ includeUsage: true }),
      options: () => ({
        allowSystemInMessages: true,
        messages: [
          {
            role: 'system',
            content: 'You are a poet, unappreciated in your time.',
          },
          { role: 'user', content: 'test' },
          {
            role: 'assistant',
            content: '\n\nTest received! How can I help you?',
          },
          { role: 'user', content: 'Write a two-line poem.' },
        ],
        maxOutputTokens: 64,
        temperature: 0.4,
        topP: 0.67,
        frequencyPenalty: 0.41,
        presencePenalty: 0.48,
        providerOptions: {
          mixlayer: {
            reasoningEffort: 'low',
            repetition_penalty: 1.82,
            top_k: 144,
            min_p: 0.29,
          },
        },
      }),
      expectedBody: {
        max_tokens: 64,
        temperature: 0.4,
        top_p: 0.67,
        frequency_penalty: 0.41,
        presence_penalty: 0.48,
        reasoning_effort: 'low',
        repetition_penalty: 1.82,
        top_k: 144,
        min_p: 0.29,
        stream_options: { include_usage: true },
      },
      assertOutput: output => [
        ...assertTextOrReasoning(output),
        passIf(
          Number(output.totalUsage?.totalTokens ?? 0) > 0,
          'streaming usage was included',
          `streaming usage was missing: ${JSON.stringify(output.totalUsage)}`
        ),
      ],
    },
    {
      id: 'standard-top-k',
      description:
        'Standard AI SDK topK warns in the OpenAI-compatible adapter; use providerOptions.mixlayer.top_k for Mixlayer.',
      modes: ['generate', 'stream'],
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
        topK: 7,
      }),
      expectedWarnings: ['topK'],
      assertOutput: assertTextOrReasoning,
    },
    {
      id: 'registry-default',
      description: 'Runtime createProviderRegistry path can resolve and call the model.',
      modes: ['generate', 'stream'],
      viaRegistry: true,
      options: () => ({
        prompt: 'Reply with exactly: OK',
        maxOutputTokens: 48,
      }),
      assertOutput: assertTextOrReasoning,
    },
  ]

  if (includeStructured) {
    cases.push({
      id: 'json-object',
      description:
        'AI SDK Output.object path with supported json_object response format, run with thinking=false.',
      modes: ['generate'],
      thinkingModes: [false],
      captureStructuredOutput: true,
      options: () => ({
        prompt:
          'Return only a JSON object with exactly these fields: {"ok":true,"label":"OK"}',
        maxOutputTokens: 96,
        output: Output.object({
          schema: jsonSchema({
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              label: { type: 'string' },
            },
            required: ['ok', 'label'],
            additionalProperties: false,
          }),
        }),
      }),
      expectedBody: { response_format: { type: 'json_object' } },
      assertOutput: output => [
        passIf(
          output.output?.ok === true && output.output?.label === 'OK',
          'structured output matched expected object',
          `structured output mismatch: ${JSON.stringify(output.output)}`
        ),
      ],
    })

    cases.push({
      id: 'json-schema',
      description:
        'Supported response_format=json_schema path, run only with thinking=false per Mixlayer constraints.',
      modes: ['generate'],
      thinkingModes: [false],
      captureStructuredOutput: true,
      options: () => ({
        prompt:
          'Return only a JSON object with exactly these fields: {"ok":true,"label":"OK"}',
        maxOutputTokens: 96,
        output: Output.object({
          schema: jsonSchema({
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              label: { type: 'string' },
            },
            required: ['ok', 'label'],
            additionalProperties: false,
          }),
        }),
        providerOptions: {
          mixlayer: {
            response_format: {
              type: 'json_schema',
              json_schema: {
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    label: { type: 'string' },
                  },
                  required: ['ok', 'label'],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      }),
      expectedBody: {
        response_format: {
          type: 'json_schema',
          json_schema: {
            strict: true,
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                label: { type: 'string' },
              },
              required: ['ok', 'label'],
              additionalProperties: false,
            },
          },
        },
      },
      assertOutput: output => [
        passIf(
          output.output?.ok === true && output.output?.label === 'OK',
          'json_schema structured output matched expected object',
          `json_schema structured output mismatch: ${JSON.stringify(output.output)}`
        ),
      ],
    })
  }

  if (includeTools) {
    cases.push({
      id: 'tool-auto',
      description: 'Prompt-guided auto tool call with an executable AI SDK tool.',
      modes: ['generate'],
      options: () => ({
        prompt:
          'You must call the report_marker tool with marker "OK" before answering. Do not answer normally first.',
        maxOutputTokens: 96,
        tools: {
          report_marker: tool({
            description: 'Report a marker string.',
            inputSchema: jsonSchema({
              type: 'object',
              properties: {
                marker: { type: 'string' },
              },
              required: ['marker'],
              additionalProperties: false,
            }),
            execute: async input => ({ echoed: input.marker }),
          }),
        },
        stopWhen: stepCountIs(2),
      }),
      assertOutput: output => [
        passIf(
          output.toolCalls?.some(toolCall => toolCall.toolName === 'report_marker'),
          'model emitted the prompted tool call',
          `expected report_marker tool call, got ${JSON.stringify(output.toolCalls)}`
        ),
        passIf(
          output.toolResults?.some(
            toolResult =>
              toolResult.toolName === 'report_marker' &&
              toolResult.output?.echoed === 'OK'
          ),
          'tool execution result was returned',
          `expected report_marker tool result, got ${JSON.stringify(output.toolResults)}`
        ),
      ],
    })
  }

  return cases
}

function assertRequest({ task, calls, output }) {
  const assertions = []
  const chatCall = calls.find(call => String(call.url).includes('/chat/completions'))

  assertions.push(
    passIf(Boolean(chatCall), 'made a chat completions request', 'no chat request captured')
  )

  if (!chatCall) return assertions

  const body = chatCall.requestBody ?? {}
  assertions.push(
    passIf(
      body.model === task.modelId,
      `request model was ${task.modelId}`,
      `request model mismatch: ${body.model}`
    )
  )

  if (task.mode === 'stream') {
    assertions.push(
      passIf(body.stream === true, 'stream=true was sent', 'stream request omitted stream=true')
    )
  }

  if (!hasExpectedBodyKey(task.testCase, 'min_p')) {
    assertions.push(
      passIf(
        body.min_p === undefined,
        'min_p was not sent outside playground-observed cases',
        `min_p was sent unexpectedly: ${body.min_p}`
      )
    )
  }

  assertions.push(
    passIf(
      body.chat_template_kwargs === undefined,
      'unsupported chat_template_kwargs was not sent',
      `unsupported chat_template_kwargs was sent: ${JSON.stringify(
        body.chat_template_kwargs
      )}`
    )
  )

  if (task.testCase.id === 'tool-auto') {
    assertions.push(
      passIf(
        body.tool_choice === undefined,
        'unsupported tool_choice was not sent',
        `unsupported tool_choice was sent: ${JSON.stringify(body.tool_choice)}`
      )
    )
  }

  if (isQwen35Or36(task.modelId)) {
    const defaultTemperature = task.thinking ? 1 : 0.7
    const defaultTopP = task.thinking ? 0.95 : 0.8
    const defaultPresencePenalty = task.thinking ? 0 : 1.5

    if (!hasExpectedBodyKey(task.testCase, 'temperature')) {
      assertions.push(
        passIf(
          body.temperature === defaultTemperature,
          `Qwen temperature default ${defaultTemperature} was sent`,
          `Qwen temperature default mismatch: ${body.temperature}`
        )
      )
    }

    if (!hasExpectedBodyKey(task.testCase, 'top_p')) {
      assertions.push(
        passIf(
          body.top_p === defaultTopP,
          `Qwen top_p default ${defaultTopP} was sent`,
          `Qwen top_p default mismatch: ${body.top_p}`
        )
      )
    }

    if (!hasExpectedBodyKey(task.testCase, 'top_k')) {
      assertions.push(
        passIf(
          body.top_k === 20,
          'Qwen top_k default 20 was sent',
          `Qwen top_k default mismatch: ${body.top_k}`
        )
      )
    }

    if (!hasExpectedBodyKey(task.testCase, 'presence_penalty')) {
      assertions.push(
        passIf(
          body.presence_penalty === defaultPresencePenalty,
          `Qwen presence_penalty default ${defaultPresencePenalty} was sent`,
          `Qwen presence_penalty default mismatch: ${body.presence_penalty}`
        )
      )
    }

    if (!hasExpectedBodyKey(task.testCase, 'repetition_penalty')) {
      assertions.push(
        passIf(
          body.repetition_penalty === 1,
          'Qwen repetition_penalty default 1 was sent',
          `Qwen repetition_penalty default mismatch: ${body.repetition_penalty}`
        )
      )
    }

    if (!hasExpectedBodyKey(task.testCase, 'thinking')) {
      assertions.push(
        passIf(
          body.thinking === task.thinking,
          `Qwen thinking toggle ${task.thinking} was sent`,
          `Qwen thinking toggle mismatch: ${body.thinking}`
        )
      )
    }
  }

  for (const [key, expected] of Object.entries(task.testCase.expectedBody ?? {})) {
    assertions.push(
      passIf(
        deepEqual(body[key], expected),
        `request body ${key} matched ${JSON.stringify(expected)}`,
        `request body ${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(
          body[key]
        )}`
      )
    )
  }

  for (const feature of task.testCase.expectedWarnings ?? []) {
    const warnings = extractWarningsFromOutput(output)
    assertions.push(
      passIf(
        warnings.some(warning => warning.feature === feature),
        `received expected warning for ${feature}`,
        `missing expected warning for ${feature}`
      )
    )
  }

  return assertions
}

function assertTextOrReasoning(output) {
  return [
    passIf(
      Number(output.textLength ?? 0) > 0 || Number(output.reasoningLength ?? 0) > 0,
      'model returned text or reasoning content',
      'model returned no text or reasoning content'
    ),
  ]
}

function extractWarningsFromOutput(output) {
  return Array.isArray(output?.warnings) ? output.warnings : []
}

function hasExpectedBodyKey(testCase, key) {
  return Object.prototype.hasOwnProperty.call(testCase.expectedBody ?? {}, key)
}

function passIf(condition, passMessage, failMessage) {
  return condition
    ? { status: 'passed', message: passMessage }
    : { status: 'failed', message: failMessage }
}

async function resolveModels() {
  let models = parseList(args.models)

  if (models.length === 0) {
    models = await discoverModels()
  }

  if (args.modelFilter) {
    const filter = new RegExp(args.modelFilter)
    models = models.filter(model => filter.test(model))
  }

  if (args.maxModels) {
    models = models.slice(0, parsePositiveInt(args.maxModels, models.length))
  }

  if (models.length === 0) {
    throw new Error('No models selected.')
  }

  return models
}

async function discoverModels() {
  const url = `${baseURL}/models`
  const response = await globalThis.fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (args.allowKnownModelsFallback === true) {
      console.warn(
        `Could not discover models from ${url}; falling back to known catalog. Status ${response.status}.`
      )
      return KNOWN_MODELS
    }
    throw new Error(`Model discovery failed with ${response.status}: ${redact(body)}`)
  }

  const data = await response.json()
  const discovered = Array.isArray(data.data)
    ? data.data.map(model => model.id).filter(id => typeof id === 'string')
    : []

  if (discovered.length === 0) {
    if (args.allowKnownModelsFallback === true) {
      console.warn('Model discovery returned no models; falling back to known catalog.')
      return KNOWN_MODELS
    }
    throw new Error('Model discovery returned no models.')
  }

  return [...new Set(discovered)].sort()
}

async function runQueue(items, concurrency, runner) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await runner(items[index], index + 1, items.length)
      if (args.failFast === true && results[index].status === 'failed') {
        nextIndex = items.length
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )

  return results.filter(Boolean)
}

function parseArgs(argv) {
  const parsed = {}

  for (const arg of argv) {
    if (arg === '--') continue

    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }

    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const [rawKey, rawValue] = arg.slice(2).split(/=(.*)/s)
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase())

    if (rawValue === undefined || rawValue === '') {
      parsed[key] = true
    } else if (rawValue === 'true') {
      parsed[key] = true
    } else if (rawValue === 'false') {
      parsed[key] = false
    } else {
      parsed[key] = rawValue
    }
  }

  return parsed
}

function selectCases(allCases, selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return allCases

  const selected = allCases.filter(testCase => selectedIds.includes(testCase.id))
  const missing = selectedIds.filter(id => !allCases.some(testCase => testCase.id === id))

  if (missing.length > 0) {
    throw new Error(`Unknown case(s): ${missing.join(', ')}`)
  }

  return selected
}

function parseList(value, fallback = []) {
  if (value == null || value === '') return fallback
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseThinkingModes(value, fallback) {
  return parseList(value, fallback.map(String)).map(item => {
    if (item === true || item === 'true') return true
    if (item === false || item === 'false') return false
    throw new Error(`Invalid thinking mode: ${item}`)
  })
}

function parsePositiveInt(value, fallback) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected a positive integer, got ${value}`)
  }
  return number
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`)
  }
  return number
}

function parseRequestBody(body) {
  if (body == null) return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return redact(body)
    }
  }

  return '[non-string body]'
}

function logProgress(index, total, status, label, durationMs) {
  const prefix = status === 'passed' ? 'PASS' : 'FAIL'
  console.log(`[${index}/${total}] ${prefix} ${label} (${durationMs}ms)`)
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sample(value, max = 160) {
  if (!value) return undefined
  const text = redact(String(value)).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function errorSummary(error) {
  const message = redact(String(error?.message ?? error))
  const summary = { name: error?.name, message }

  if (error?.statusCode) summary.statusCode = error.statusCode
  if (error?.url) summary.url = redact(error.url)
  if (error?.responseBody) summary.responseBody = redact(String(error.responseBody))

  return compact(summary)
}

function redact(value) {
  return String(value).replace(/sk_mxl_[A-Za-z0-9_-]+/g, '[REDACTED_MIXLAYER_KEY]')
}

function printHelp() {
  console.log(`
Usage:
  MIXLAYER_API_KEY=... pnpm test:live -- [options]

Options:
  --models=a,b                  Comma-separated model ids. Defaults to live /models discovery.
  --model-filter=regex          Filter discovered/selected model ids.
  --max-models=n                Limit selected models after filtering.
  --cases=a,b                   Case ids to run. Defaults to all cases.
  --modes=generate,stream       Modes to run. Defaults to both.
  --thinking=true,false         Thinking settings to run. Defaults to both.
  --concurrency=n               Concurrent live calls. Defaults to 1.
  --timeout-ms=n                AI SDK total timeout per task. Defaults to 120000.
  --max-retries=n               AI SDK retries per task. Defaults to 0.
  --base-url=url                Override Mixlayer base URL.
  --output=path                 JSON report path.
  --structured=false            Skip structured output case.
  --tools                       Include prompt-guided tool-calling cases. Defaults to off.
  --allow-known-models-fallback Use the package's known model list if /models fails.
  --fail-fast                   Stop scheduling new tasks after the first failure.

Case ids:
  ${buildCases({ includeStructured: true, includeTools: true })
    .map(testCase => testCase.id)
    .join(', ')}
`)
}

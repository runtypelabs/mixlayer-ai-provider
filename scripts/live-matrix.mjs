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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import {
  LIVE_MODES,
  createLiveTasks,
  parseAllowedList,
} from './live-matrix-config.mjs'

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
  MIXLAYER_KNOWN_MODEL_IDS,
  MIXLAYER_VISION_MODEL_IDS,
  createMixlayer,
  createMixlayerWebSocketFetch,
  isQwen35Or36,
} = providerModule

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
const includeVision = args.vision === true
const visionFixture = includeVision
  ? await readFile(resolve(__dirname, 'fixtures/vision-color-bands.png'))
  : undefined

const selectedModes = parseAllowedList(args.modes, LIVE_MODES, 'mode')
const selectedTransports = parseAllowedList(
  args.transports,
  ['chat', 'responses-http', 'responses-websocket'],
  'transport'
)
const selectedThinkingModes = parseThinkingModes(args.thinking, [true, false])
const cases = selectCases(
  buildCases({ includeStructured, includeTools, includeVision, visionFixture }),
  parseList(args.cases)
)
const models = await resolveModels()

const tasks = createLiveTasks({
  models,
  thinkingModes: selectedThinkingModes,
  transports: selectedTransports,
  cases,
  modes: selectedModes,
})

console.log(`Mixlayer live matrix`)
console.log(`Base URL: ${baseURL}`)
console.log(`Models: ${models.join(', ')}`)
console.log(`Transports: ${selectedTransports.join(', ')}`)
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
      transports: selectedTransports,
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
      `FAIL ${result.modelId} transport=${result.transport} thinking=${result.thinking} ${result.caseId}/${result.mode}: ${result.error?.message}`
    )
  }
  process.exitCode = 1
}

async function runTask(task, index, total) {
  const started = Date.now()
  const calls = []
  const label = `${task.modelId} transport=${task.transport} thinking=${task.thinking} ${task.testCase.id}/${task.mode}`
  let websocketFetch

  try {
    const fetch = async (input, init = {}) => {
      const call = {
        transport: 'http',
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

    if (task.transport === 'responses-websocket') {
      websocketFetch = createMixlayerWebSocketFetch({
        baseURL,
        fetch,
        connect: createNodeWebSocketConnector(calls),
      })
    }

    const provider = createMixlayer({
      apiKey,
      baseURL,
      thinking: task.thinking,
      fetch: websocketFetch ?? fetch,
      ...(task.testCase.providerSettings?.(task) ?? {}),
    })
    const model =
      task.testCase.viaRegistry === true
        ? createProviderRegistry({ mixlayer: provider }).languageModel(
            `mixlayer:${task.modelId}`
          )
        : task.transport === 'chat'
          ? provider(task.modelId)
          : provider.responses(task.modelId)

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
      transport: task.transport,
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
      transport: task.transport,
      thinking: task.thinking,
      caseId: task.testCase.id,
      mode: task.mode,
      durationMs: Date.now() - started,
      requestCalls: calls,
      error: errorSummary(error),
    }
    logProgress(index, total, 'failed', label, result.durationMs)
    return result
  } finally {
    websocketFetch?.close()
  }
}

function createNodeWebSocketConnector(calls) {
  return async ({ url, headers, signal, onSocket }) => {
    const socket = new WebSocket(url, { headers })
    const originalSend = socket.send.bind(socket)

    socket.send = (data, ...sendOptions) => {
      const requestBody = parseRequestBody(data)
      if (requestBody?.type === 'response.create') {
        calls.push({
          transport: 'websocket',
          url: redact(url),
          method: 'WEBSOCKET',
          eventType: requestBody.type,
          requestBody,
          startedAt: new Date().toISOString(),
        })
      }
      return originalSend(data, ...sendOptions)
    }

    onSocket?.(socket)

    return new Promise((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const settle = callback => value => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
      const resolveOpen = settle(() => resolve(socket))
      const rejectOpen = settle(reject)
      const onOpen = () => resolveOpen()
      const onError = event =>
        rejectOpen(event?.error ?? new Error('WebSocket connection failed'))
      const onClose = event =>
        rejectOpen(
          new Error(
            `WebSocket closed before opening (code ${event?.code ?? 'unknown'})`
          )
        )
      const onAbort = () => {
        try {
          socket.close()
        } finally {
          rejectOpen(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
      }

      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
      socket.addEventListener('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })

      if (signal?.aborted) onAbort()
    })
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

function buildCases({ includeStructured, includeTools, includeVision, visionFixture }) {
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
      description: 'Caller temperature is sent on the request.',
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

  if (includeVision) {
    cases.push({
      id: 'vision',
      description:
        'Inline PNG image understanding through standard AI SDK file parts.',
      modes: ['generate', 'stream'],
      transports: ['chat', 'responses-http', 'responses-websocket'],
      thinkingModes: [false],
      modelIds: [...MIXLAYER_VISION_MODEL_IDS],
      options: () => ({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'List the four vertical color bands from left to right. Answer with only the four color names.',
              },
              {
                type: 'file',
                mediaType: 'image/png',
                data: visionFixture,
              },
            ],
          },
        ],
        maxOutputTokens: 128,
      }),
      assertOutput: output => [
        ...assertTextOrReasoning(output),
        passIf(
          /red.*green.*blue.*yellow/i.test(String(output.textSample ?? '')),
          'model identified the four image colors in order',
          `model did not identify the image colors in order: ${JSON.stringify(
            output.textSample
          )}`
        ),
      ],
    })
  }

  return cases
}

function assertRequest({ task, calls, output }) {
  if (task.transport === 'responses-http') {
    const responsesCall = calls.find(
      call =>
        call.transport === 'http' &&
        call.method === 'POST' &&
        String(call.url).includes('/responses')
    )
    const assertions = [
      passIf(
        Boolean(responsesCall),
        'made a Responses HTTP request',
        'no Responses HTTP request captured'
      ),
    ]
    if (!responsesCall) return assertions

    const body = responsesCall.requestBody ?? {}
    assertions.push(
      passIf(
        body.model === task.modelId,
        `request model was ${task.modelId}`,
        `request model mismatch: ${body.model}`
      )
    )
    if (task.mode === 'stream') {
      assertions.push(
        passIf(
          body.stream === true,
          'stream=true was sent',
          'stream request omitted stream=true'
        )
      )
    }
    assertions.push(...assertVisionRequest(body, task))
    return assertions
  }

  if (task.transport === 'responses-websocket') {
    const responseCreateCall = calls.find(
      call => call.transport === 'websocket' && call.eventType === 'response.create'
    )
    const body = responseCreateCall?.requestBody ?? {}
    return [
      passIf(
        Boolean(responseCreateCall),
        'sent a WebSocket response.create event',
        'no WebSocket response.create event captured'
      ),
      ...(responseCreateCall
        ? [
            passIf(
              body.type === 'response.create',
              'outgoing event type was response.create',
              `outgoing event type mismatch: ${body.type}`
            ),
            passIf(
              body.model === task.modelId,
              `request model was ${task.modelId}`,
              `request model mismatch: ${body.model}`
            ),
          ]
        : []),
      ...assertTextOrReasoning(output),
      ...assertVisionRequest(body, task),
    ]
  }

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

  assertions.push(...assertVisionRequest(body, task))

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

  // Mixlayer applies recommended sampling defaults server-side; the provider
  // must not inject any sampling parameters the caller didn't set. Keys the
  // case sets itself are exempt — via expectedBody, or via expectedWarnings
  // when the case passes an AI SDK option the adapter warns on (it may still
  // serialize the caller's value, which is not an injected default).
  const SAMPLING_OPTION_BY_WIRE_KEY = {
    temperature: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    presence_penalty: 'presencePenalty',
    repetition_penalty: 'repetitionPenalty',
  }
  for (const [key, option] of Object.entries(SAMPLING_OPTION_BY_WIRE_KEY)) {
    if (hasExpectedBodyKey(task.testCase, key)) continue
    if ((task.testCase.expectedWarnings ?? []).includes(option)) continue
    assertions.push(
      passIf(
        body[key] === undefined,
        `no ${key} default was injected`,
        `unexpected ${key} was sent: ${body[key]}`
      )
    )
  }

  if (isQwen35Or36(task.modelId)) {
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

function assertVisionRequest(body, task) {
  if (task.testCase.id !== 'vision') return []

  const imagePart = findNestedValue(
    body,
    value =>
      value != null &&
      typeof value === 'object' &&
      (value.type === 'image_url' || value.type === 'input_image')
  )
  const imageUrl =
    typeof imagePart?.image_url === 'string'
      ? imagePart.image_url
      : imagePart?.image_url?.url

  return [
    passIf(
      typeof imageUrl === 'string' &&
        imageUrl.startsWith('data:image/png;base64,'),
      'serialized the AI SDK image as an inline PNG data URL',
      `missing inline PNG image part: ${JSON.stringify(imagePart)}`
    ),
  ]
}

function findNestedValue(value, predicate) {
  if (predicate(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findNestedValue(item, predicate)
      if (match !== undefined) return match
    }
  } else if (value != null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const match = findNestedValue(item, predicate)
      if (match !== undefined) return match
    }
  }
  return undefined
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
      return [...MIXLAYER_KNOWN_MODEL_IDS]
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
      return [...MIXLAYER_KNOWN_MODEL_IDS]
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
      return summarizeDataUrls(JSON.parse(body))
    } catch {
      return redact(body)
    }
  }

  return '[non-string body]'
}

function summarizeDataUrls(value) {
  if (typeof value === 'string') {
    const match = /^(data:[^;,]+;base64,)(.+)$/s.exec(value)
    return match ? `${match[1]}[${match[2].length} base64 chars]` : value
  }
  if (Array.isArray(value)) return value.map(summarizeDataUrls)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, summarizeDataUrls(item)])
    )
  }
  return value
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
  --transports=chat,responses-http,responses-websocket
                                Transports to run. Defaults to all three.
  --thinking=true,false         Thinking settings to run. Defaults to both.
  --concurrency=n               Concurrent live calls. Defaults to 1.
  --timeout-ms=n                AI SDK total timeout per task. Defaults to 120000.
  --max-retries=n               AI SDK retries per task. Defaults to 0.
  --base-url=url                Override Mixlayer base URL.
  --output=path                 JSON report path.
  --structured=false            Skip structured output case.
  --tools                       Include prompt-guided tool-calling cases. Defaults to off.
  --vision                      Include image-input cases on known vision models. Defaults to off.
  --allow-known-models-fallback Use the package's known model list if /models fails.
  --fail-fast                   Stop scheduling new tasks after the first failure.

Case ids:
  ${buildCases({ includeStructured: true, includeTools: true, includeVision: true })
    .map(testCase => testCase.id)
    .join(', ')}
`)
}

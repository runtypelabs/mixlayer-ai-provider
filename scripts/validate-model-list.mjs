#!/usr/bin/env node

import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const SOURCE_FILE = resolve('src/mixlayer-provider.ts')
const TYPE_ALIAS = 'MixlayerChatModelId'
const DEFAULT_BASE_URL = 'https://models.mixlayer.ai/v1'

const apiKey = process.env.MIXLAYER_API_KEY
const baseURL = stripTrailingSlash(process.env.MIXLAYER_BASE_URL ?? DEFAULT_BASE_URL)

if (!apiKey) {
  fail('MIXLAYER_API_KEY is required to validate the live Mixlayer model catalog.')
}

const localModels = await readAutocompleteModels()
const liveModels = await fetchLiveModels()

const missingFromAutocomplete = liveModels.filter(model => !localModels.includes(model))
const staleAutocomplete = localModels.filter(model => !liveModels.includes(model))

console.log(`Live Mixlayer models: ${liveModels.length}`)
console.log(`Autocomplete models: ${localModels.length}`)

if (missingFromAutocomplete.length > 0 || staleAutocomplete.length > 0) {
  if (missingFromAutocomplete.length > 0) {
    annotate(
      'error',
      `${TYPE_ALIAS} is missing live model id(s): ${missingFromAutocomplete.join(', ')}`
    )
    console.error('\nMissing from autocomplete list:')
    for (const model of missingFromAutocomplete) console.error(`  + ${model}`)
  }

  if (staleAutocomplete.length > 0) {
    annotate(
      'error',
      `${TYPE_ALIAS} contains model id(s) not returned by Mixlayer: ${staleAutocomplete.join(', ')}`
    )
    console.error('\nStale/deprecated in autocomplete list:')
    for (const model of staleAutocomplete) console.error(`  - ${model}`)
  }

  console.error(
    `\nUpdate ${TYPE_ALIAS} in ${SOURCE_FILE} so autocomplete matches the live Mixlayer catalog.`
  )
  process.exit(1)
}

console.log(`${TYPE_ALIAS} matches the live Mixlayer model catalog.`)

async function readAutocompleteModels() {
  const sourceText = await readFile(SOURCE_FILE, 'utf8')
  const sourceFile = ts.createSourceFile(
    SOURCE_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  let aliasNode
  ts.forEachChild(sourceFile, node => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === TYPE_ALIAS) {
      aliasNode = node
    }
  })

  if (!aliasNode) {
    fail(`Could not find type alias ${TYPE_ALIAS} in ${SOURCE_FILE}.`)
  }

  const modelIds = [...new Set(collectStringLiteralTypes(aliasNode.type))].sort()

  if (modelIds.length === 0) {
    fail(`No string literal model ids found in ${TYPE_ALIAS}.`)
  }

  return modelIds
}

function collectStringLiteralTypes(node) {
  if (ts.isUnionTypeNode(node)) {
    return node.types.flatMap(collectStringLiteralTypes)
  }

  if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
    return [node.literal.text]
  }

  // Ignore the open-union `(string & {})` autocomplete idiom.
  return []
}

async function fetchLiveModels() {
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    fail(`Mixlayer model discovery failed with ${response.status}: ${redact(body)}`)
  }

  const data = await response.json()
  const modelIds = Array.isArray(data.data)
    ? data.data.map(model => model?.id).filter(id => typeof id === 'string')
    : []

  if (modelIds.length === 0) {
    fail('Mixlayer model discovery returned no model ids.')
  }

  return [...new Set(modelIds)].sort()
}

function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::${level} file=src/mixlayer-provider.ts,title=Mixlayer model catalog drift::${escapeAnnotation(message)}`)
  }
}

function escapeAnnotation(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '')
}

function fail(message) {
  console.error(redact(message))
  process.exit(1)
}

function redact(value) {
  return String(value).replace(/sk_mxl_[A-Za-z0-9_-]+/g, '[REDACTED_MIXLAYER_KEY]')
}

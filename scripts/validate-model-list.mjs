#!/usr/bin/env node

import ts from 'typescript'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const SOURCE_FILE = resolve('src/model-catalog.ts')
const CATALOG_NAME = 'MIXLAYER_KNOWN_MODEL_IDS'
const DEFAULT_BASE_URL = 'https://models.mixlayer.ai/v1'

const apiKey = process.env.MIXLAYER_API_KEY
const baseURL = stripTrailingSlash(process.env.MIXLAYER_BASE_URL ?? DEFAULT_BASE_URL)

if (!apiKey) {
  fail('MIXLAYER_API_KEY is required to validate the live Mixlayer model catalog.')
}

const localModels = await readRuntimeCatalog()
const liveModels = await fetchLiveModels()

const missingFromCatalog = liveModels.filter(model => !localModels.includes(model))
const staleCatalog = localModels.filter(model => !liveModels.includes(model))

console.log(`Live Mixlayer models: ${liveModels.length}`)
console.log(`Runtime catalog models: ${localModels.length}`)

if (missingFromCatalog.length > 0 || staleCatalog.length > 0) {
  if (missingFromCatalog.length > 0) {
    annotate(
      'error',
      `${CATALOG_NAME} is missing live model id(s): ${missingFromCatalog.join(', ')}`
    )
    console.error('\nMissing from runtime catalog:')
    for (const model of missingFromCatalog) console.error(`  + ${model}`)
  }

  if (staleCatalog.length > 0) {
    annotate(
      'error',
      `${CATALOG_NAME} contains model id(s) not returned by Mixlayer: ${staleCatalog.join(', ')}`
    )
    console.error('\nStale/deprecated in runtime catalog:')
    for (const model of staleCatalog) console.error(`  - ${model}`)
  }

  console.error(
    `\nUpdate ${CATALOG_NAME} in ${SOURCE_FILE} so the runtime catalog matches the live Mixlayer catalog.`
  )
  process.exit(1)
}

console.log(`${CATALOG_NAME} matches the live Mixlayer model catalog.`)

async function readRuntimeCatalog() {
  const sourceText = await readFile(SOURCE_FILE, 'utf8')
  const sourceFile = ts.createSourceFile(
    SOURCE_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )

  let catalogNode
  ts.forEachChild(sourceFile, node => {
    if (!ts.isVariableStatement(node)) return

    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === CATALOG_NAME) {
        catalogNode = declaration
      }
    }
  })

  if (!catalogNode) {
    fail(`Could not find runtime catalog ${CATALOG_NAME} in ${SOURCE_FILE}.`)
  }

  if (!catalogNode.initializer) {
    fail(`${CATALOG_NAME} has no initializer in ${SOURCE_FILE}.`)
  }

  const initializer = unwrapExpression(catalogNode.initializer)
  if (!ts.isArrayLiteralExpression(initializer)) {
    fail(`${CATALOG_NAME} initializer must be an array literal.`)
  }

  const modelIds = initializer.elements.map(element => {
    if (!ts.isStringLiteral(element)) {
      fail(`${CATALOG_NAME} must contain only string literal model ids.`)
    }
    return element.text
  })

  if (modelIds.length === 0) {
    fail(`${CATALOG_NAME} must not be empty.`)
  }

  const duplicates = modelIds.filter((model, index) => modelIds.indexOf(model) !== index)
  if (duplicates.length > 0) {
    fail(
      `${CATALOG_NAME} contains duplicate model id(s): ${[...new Set(duplicates)].join(', ')}`
    )
  }

  return modelIds.sort()
}

function unwrapExpression(node) {
  while (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    node = node.expression
  }
  return node
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
    console.error(`::${level} file=src/model-catalog.ts,title=Mixlayer runtime catalog drift::${escapeAnnotation(message)}`)
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

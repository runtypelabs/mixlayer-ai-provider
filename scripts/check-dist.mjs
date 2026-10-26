import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

for (const entry of Object.values(pkg.exports['.'])) {
  await access(new URL(entry, root))
}

const built = await import(new URL(pkg.exports['.'].import, root).href)
assert.equal(typeof built.createMixlayer, 'function')
assert.equal(typeof built.createMixlayerWebSocketFetch, 'function')
assert.ok(built.MIXLAYER_KNOWN_MODEL_IDS.length > 0)
assert.ok(built.MIXLAYER_DECISION_MODEL_IDS.length > 0)
assert.equal(typeof built.createMixlayer({ apiKey: 'test' }).decisionModel, 'function')
console.log('Published entry points and runtime exports verified')

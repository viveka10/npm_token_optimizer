'use strict'
/**
 * End-to-end smoke test with Node's built-in test runner (no Jest), so it also runs on
 * Node 22, where Jest cannot require() the ESM-only SDK. Uses the real SDK, LangChain
 * and the sample CAP app against the mock AI Core server.
 *
 *   npm run test:smoke        (node --test test/smoke/smoke.js)
 */
const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createMockAiCore } = require('../mock-aicore/server')
const { createOptimizer } = require('../../index')
const instrument = require('../../lib/client/instrument')
const log = require('../../lib/util/log')

const SAMPLE = path.resolve(__dirname, '../../../sample-cap-agent')
// @cap-js/sqlite 3 needs node:sqlite with user functions (Node >= 22.13 / 23.5)
const sqliteReady = (() => {
  try { return typeof require('node:sqlite').DatabaseSync.prototype.function === 'function' } catch { return false }
})()
const sampleSkip = !fs.existsSync(path.join(SAMPLE, 'node_modules/@sap/cds'))
  ? 'run npm install in ../sample-cap-agent'
  : !sqliteReady && `node:sqlite is not usable on Node ${process.version} (needed by @cap-js/sqlite)`
const mock = createMockAiCore()
const tools = Array.from({ length: 20 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } } }))

function setup (config = {}) {
  const opt = createOptimizer({ metrics: { exporters: [] }, ...config })
  const events = []
  opt.on('call', e => events.push(e))
  return { opt, events }
}

describe(`smoke (node ${process.version})`, () => {
  let sdk
  before(async () => {
    log._set({ debug () {}, info () {}, warn () {}, error () {} })
    await mock.start()
    process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
    sdk = {
      ...require('@sap-ai-sdk/orchestration'),
      fm: require('@sap-ai-sdk/foundation-models'),
      lc: require('@sap-ai-sdk/langchain')
    }
  })
  after(async () => {
    instrument.uninstall()
    await mock.stop()
  })

  it('wrap(): optimizes, measures and caches orchestration calls', async () => {
    mock.reset()
    const { opt, events } = setup()
    const client = opt.wrap(new sdk.OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } }, prompt: { tools } } }), { useCase: 'smoke' })
    const req = { messages: [{ role: 'user', content: 'Hello   smoke' }] }
    const a = await client.chatCompletion(req)
    const b = await client.chatCompletion(req)
    assert.equal(b.getContent(), a.getContent())
    assert.equal(mock.state.requests.length, 1)
    assert.equal(mock.state.requests[0].body.config.modules.prompt_templating.prompt.tools.length, 15)
    assert.equal(events[0].status, 'success')
    assert.ok(events[0].tokens.prompt > 0)
    assert.equal(events[1].savings.cacheHit, true)
  })

  it('chat(): foundation models', async () => {
    const { opt, events } = setup()
    const r = await opt.chat({ sdk: 'foundation-models', model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }] })
    assert.match(r.content, /Mock answer/)
    assert.equal(events[0].sdk, 'foundation-models')
  })

  it('classifies errors', async () => {
    const { opt, events } = setup()
    mock.setScenario('content_filter')
    await assert.rejects(opt.chat({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] }))
    mock.reset()
    assert.equal(events[0].error.category, 'CONTENT_FILTER')
  })

  it('autoInstrument and wrapLangChain', async () => {
    const { opt, events } = setup({ autoInstrument: true })
    await new sdk.OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }).chatCompletion({ messages: [{ role: 'user', content: 'auto' }] })
    opt.configure({ metrics: { exporters: [] } })
    const model = opt.wrapLangChain(new sdk.lc.OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }), { useCase: 'lc' })
    await model.invoke('langchain')
    assert.deepEqual(events.map(e => e.useCase), ['default', 'lc'])
  })

  it('sample CAP app', { skip: sampleSkip }, async () => {
    const cwd = process.cwd()
    process.chdir(SAMPLE)
    const cds = require(require.resolve('@sap/cds', { paths: [SAMPLE] }))
    // same arguments as cds.test(): serve the app in cds.root with an in-memory database
    const { server, url } = await cds.exec('--in-memory?', '--port', '0')
    try {
      const { optimizer } = require('../../index')
      optimizer.configure({ ...cds.env.requires.tokenOptimizer, metrics: { exporters: [] } })
      const auth = { authorization: 'Basic ' + Buffer.from('alice:').toString('base64'), 'content-type': 'application/json' }
      const res = await fetch(`${url}/odata/v4/agent/runAgent`, { method: 'POST', headers: auth, body: JSON.stringify({ question: 'Status of 4711?' }) })
      assert.equal(res.status, 200)
      assert.match((await res.json()).value, /Mock answer/)
      const stats = await fetch(`${url}/odata/v4/token-optimizer/summary()`, { headers: { authorization: 'Basic ' + Buffer.from('ops:').toString('base64') } })
      assert.equal((await stats.json()).calls, 1)
    } finally {
      await new Promise(resolve => server.close(resolve))
      cds.emit('shutdown')
      process.chdir(cwd)
    }
  })
})

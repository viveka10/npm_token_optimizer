'use strict'
// Separate file: the Cloud SDK caches OAuth tokens per process/module registry.
const { createMockAiCore } = require('../mock-aicore/server')
const { TokenOptimizer } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const mock = createMockAiCore()

beforeAll(async () => {
  log._set({ debug () {}, info () {}, warn () {}, error () {} })
  await mock.start()
  process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
})
afterAll(async () => { await mock.stop(); delete process.env.AICORE_SERVICE_KEY; log._set(undefined) })

test('OAuth failure is classified as AUTH', async () => {
  mock.setScenario('auth')
  const { OrchestrationClient } = require('@sap-ai-sdk/orchestration')
  const opt = new TokenOptimizer({ metrics: { exporters: [] } })
  const events = []
  opt.on('call', e => events.push(e))
  const client = opt.wrap(new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }))
  await expect(client.chatCompletion({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
  expect(events[0].error.category).toBe('AUTH')
})

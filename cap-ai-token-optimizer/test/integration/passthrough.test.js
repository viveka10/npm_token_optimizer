'use strict'
/**
 * Real @sap-ai-sdk clients against the mock AI Core server, wrapped by the optimizer.
 * Phase 1: requests must reach AI Core unchanged; every call produces one event.
 */
const { createMockAiCore } = require('../mock-aicore/server')
const { TokenOptimizer } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const mock = createMockAiCore({ delayMs: 1500 })
let OrchestrationClient, AzureOpenAiChatClient
let opt, events

beforeAll(async () => {
  log._set({ debug () {}, info () {}, warn () {}, error () {} })
  await mock.start()
  process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  ;({ OrchestrationClient } = require('@sap-ai-sdk/orchestration'))
  ;({ AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models'))
})

afterAll(async () => {
  await mock.stop()
  delete process.env.AICORE_SERVICE_KEY
  log._set(undefined)
})

beforeEach(() => {
  mock.reset()
  opt = new TokenOptimizer({ metrics: { exporters: [] }, pricing: { 'gpt-4.1': { inputPer1k: 1, outputPer1k: 1 } } })
  events = []
  opt.on('call', e => events.push(e))
})

const orchestration = (extra = {}) => new OrchestrationClient({
  promptTemplating: {
    model: { name: 'gpt-4.1', params: { max_tokens: 50 } },
    prompt: { template: [{ role: 'system', content: 'You are a concise assistant.' }], ...extra }
  }
})

describe('orchestration passthrough', () => {
  test('sends the original request and records real usage', async () => {
    const plain = await orchestration().chatCompletion({ messages: [{ role: 'user', content: 'What is CAP?' }] })
    const sentPlain = mock.state.requests.at(-1).body

    const wrapped = opt.wrap(orchestration(), { useCase: 'faq' })
    const res = await wrapped.chatCompletion({ messages: [{ role: 'user', content: 'What is CAP?' }] })
    const sentWrapped = mock.state.requests.at(-1).body

    expect(sentWrapped).toEqual(sentPlain)
    expect(res.getContent()).toBe(plain.getContent())
    expect(events).toHaveLength(1)
    const usage = res.getTokenUsage()
    expect(events[0]).toMatchObject({
      sdk: 'orchestration', model: 'gpt-4.1', useCase: 'faq', status: 'success', requestId: res.getRequestId(), finishReason: 'stop',
      tokens: { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens, cached: 0 }
    })
    expect(events[0].tokens.promptEstimatedBefore).toBeGreaterThan(0)
    expect(events[0].costEstimate).toBeCloseTo(usage.total_tokens / 1000, 6)
  })

  test('cached tokens from the response are recorded', async () => {
    mock.state.cachedTokens = 3
    await opt.wrap(orchestration()).chatCompletion({ messages: [{ role: 'user', content: 'Tell me about caching please' }] })
    expect(events[0].tokens.cached).toBe(3)
  })

  test('messagesHistory and tools are included in the estimate', async () => {
    const tools = [{ type: 'function', function: { name: 'lookup_invoice', description: 'Look up an invoice by number', parameters: { type: 'object', properties: { id: { type: 'string' } } } } }]
    await opt.wrap(orchestration()).chatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    await opt.wrap(orchestration({ tools })).chatCompletion({
      messages: [{ role: 'user', content: 'hi' }],
      messagesHistory: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }]
    })
    expect(events[1].tokens.promptEstimatedBefore).toBeGreaterThan(events[0].tokens.promptEstimatedBefore + 20)
  })

  test.each([
    ['rate_limit', 'RATE_LIMIT', 429],
    ['content_filter', 'CONTENT_FILTER', 400],
    ['context_length', 'CONTEXT_LENGTH', 400],
    ['server_error', 'SERVER', 500],
    ['not_found', 'DEPLOYMENT_NOT_FOUND', 404]
  ])('%s -> %s', async (scenario, category, httpStatus) => {
    mock.setScenario(scenario)
    await expect(opt.wrap(orchestration()).chatCompletion({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
    expect(events[0]).toMatchObject({ status: 'error', error: { category, httpStatus } })
    expect(events[0].error.message.length).toBeLessThanOrEqual(300)
  })

  test('timeout from config', async () => {
    opt.configure({ metrics: { exporters: [] }, timeoutMs: 200 })
    mock.setScenario('slow')
    await expect(opt.wrap(orchestration()).chatCompletion({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
    expect(events[0]).toMatchObject({ status: 'error', error: { category: 'TIMEOUT', httpStatus: null } })
  })

  test('retries a 429 using Retry-After, then succeeds', async () => {
    opt.configure({ metrics: { exporters: [] }, retry: { enabled: true, maxRetries: 2 } })
    mock.state.retryAfterSeconds = 0.05
    const wrapped = opt.wrap(orchestration())
    // the first request is rate limited via the header scenario, later ones succeed
    let n = 0
    const res = await wrapped.chatCompletion({ messages: [{ role: 'user', content: 'x' }] }, {
      get headers () { return n++ === 0 ? { 'x-mock-scenario': 'rate_limit' } : {} }
    })
    expect(res.getContent()).toMatch(/Mock answer/)
    expect(mock.state.requests.map(r => r.scenario)).toEqual(['rate_limit', 'ok'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'success', retries: 1 })
  })

  test('network failure', async () => {
    const down = createMockAiCore()
    await down.start()
    const key = process.env.AICORE_SERVICE_KEY
    const deployment = { deploymentId: 'd-orch' }
    const client = opt.wrap(new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }, deployment, { url: down.url }))
    await down.stop()
    try {
      await expect(client.chatCompletion({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
    } finally {
      process.env.AICORE_SERVICE_KEY = key
    }
    expect(events[0].error.category).toBe('NETWORK')
  })
})

describe('foundation models passthrough', () => {
  test('AzureOpenAiChatClient.run', async () => {
    const client = opt.wrap(new AzureOpenAiChatClient('gpt-4.1'), { useCase: 'fm' })
    const res = await client.run({ messages: [{ role: 'user', content: 'Hi azure' }], max_tokens: 20 })
    expect(mock.state.requests.at(-1).body).toEqual({ messages: [{ role: 'user', content: 'Hi azure' }], max_tokens: 20 })
    expect(events[0]).toMatchObject({ sdk: 'foundation-models', model: 'gpt-4.1', status: 'success', tokens: { prompt: res.getTokenUsage().prompt_tokens } })
  })

  test('azure content filter', async () => {
    mock.setScenario('content_filter')
    await expect(opt.wrap(new AzureOpenAiChatClient('gpt-4.1')).run({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow()
    expect(events[0].error).toMatchObject({ category: 'CONTENT_FILTER', code: 'content_filter' })
  })
})

describe('optimizer.chat()', () => {
  test('orchestration (default)', async () => {
    const r = await opt.chat({ useCase: 'explicit', model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hello chat' }], maxTokens: 30, temperature: 0 })
    expect(r.content).toMatch(/Hello chat/)
    expect(r.finishReason).toBe('stop')
    expect(r.usage.total_tokens).toBeGreaterThan(0)
    const sent = mock.state.requests.at(-1)
    expect(sent.kind).toBe('orchestration')
    expect(sent.body.config.modules.prompt_templating.model).toEqual({ name: 'gpt-4.1', params: { max_tokens: 30, temperature: 0 } })
    expect(events[0]).toMatchObject({ useCase: 'explicit', sdk: 'orchestration' })
  })

  test('foundation models with tools', async () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }]
    const r = await opt.chat({ sdk: 'foundation-models', model: 'gpt-4.1', messages: [{ role: 'user', content: 'Hi' }], tools, maxTokens: 10 })
    expect(r.content).toMatch(/Mock answer/)
    expect(mock.state.requests.at(-1).body).toEqual({ messages: [{ role: 'user', content: 'Hi' }], tools, max_tokens: 10 })
    expect(events[0].sdk).toBe('foundation-models')
  })

  test('errors propagate', async () => {
    mock.setScenario('server_error')
    await expect(opt.chat({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/500/)
    expect(events[0].error.category).toBe('SERVER')
  })
})

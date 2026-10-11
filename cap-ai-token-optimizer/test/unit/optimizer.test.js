'use strict'
const { TokenOptimizer, WRAPPED } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const quiet = { debug () {}, info () {}, warn: jest.fn(), error () {} }
beforeAll(() => log._set(quiet))
afterAll(() => log._set(undefined))
afterEach(() => { delete globalThis.cds })

function response (over = {}) {
  return {
    getTokenUsage: () => ({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 2 } }),
    getContent: () => 'answer',
    getToolCalls: () => undefined,
    getFinishReason: () => 'stop',
    getRequestId: () => 'req-1',
    ...over
  }
}

class FakeOrchestrationClient {
  constructor (config, deploymentConfig, destination, impl) {
    Object.assign(this, { config, deploymentConfig, destination })
    this.chatCompletion = impl ?? FakeOrchestrationClient.impl
    this.stream = jest.fn(async () => ({ stream: 'S' }))
    this.plain = 42
  }

  other () { return this.config.promptTemplating.model.name }
}

function orchestrationClient (impl = async () => response()) {
  const fn = jest.fn(impl)
  FakeOrchestrationClient.impl = fn
  return new FakeOrchestrationClient(
    { promptTemplating: { model: { name: 'gpt-4.1' }, prompt: { template: [{ role: 'system', content: 'Be brief.' }] } } },
    { resourceGroup: 'default' }, undefined, fn)
}

const httpError = (status, data = {}, headers = {}) => Object.assign(new Error(`Request failed with status code ${status}.`), {
  cause: Object.assign(new Error('axios'), { status, response: { status, data, headers } })
})

function setup (config = {}) {
  const opt = new TokenOptimizer({ mode: 'off', metrics: { exporters: [] }, ...config }, { sleep: jest.fn(async () => {}) })
  const events = []
  opt.on('call', e => events.push(e))
  return { opt, events }
}

describe('TokenOptimizer.wrap', () => {
  test('passes calls through unchanged and records a success event', async () => {
    const { opt, events } = setup({ pricing: { 'gpt-4.1': { inputPer1k: 1, outputPer1k: 2 } } })
    const client = orchestrationClient()
    const wrapped = opt.wrap(client, { useCase: 'invoice', cdsService: 'AgentService' })
    const req = { messages: [{ role: 'user', content: 'Hello' }] }
    const res = await wrapped.chatCompletion(req)

    expect(res.getContent()).toBe('answer')
    expect(client.chatCompletion).toHaveBeenCalledWith(req)
    expect(client.chatCompletion.mock.calls[0][0]).toBe(req)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e).toMatchObject({
      useCase: 'invoice', cdsService: 'AgentService', mode: 'off', model: 'gpt-4.1', resourceGroup: 'default',
      sdk: 'orchestration', operation: 'chat', requestId: 'req-1', finishReason: 'stop', estimateMethod: 'tiktoken',
      tokens: { prompt: 12, completion: 4, total: 16, cached: 2 },
      savings: { estimatedTokens: 0, byStep: {}, cacheHit: false, notes: [], failed: false },
      costEstimate: 0.02, retries: 0, status: 'success', error: null
    })
    expect(e.tokens.promptEstimatedBefore).toBeGreaterThan(0)
    expect(e.tokens.promptEstimatedAfter).toBe(e.tokens.promptEstimatedBefore)
    expect(e.promptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(e.latencyMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(e)).not.toContain('Hello')
    expect(opt.stats()).toMatchObject({ calls: 1, success: 1, tokens: { prompt: 12 } })
  })

  test('captureContent adds raw content to the event', async () => {
    const { opt, events } = setup({ captureContent: true })
    await opt.wrap(orchestrationClient()).chatCompletion({ messages: [{ role: 'user', content: 'Hello' }] })
    expect(events[0].content).toEqual({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }], completion: 'answer' })
  })

  test('forwards other members, bound to the client', () => {
    const { opt } = setup()
    const wrapped = opt.wrap(orchestrationClient())
    expect(wrapped.other()).toBe('gpt-4.1')
    expect(wrapped.plain).toBe(42)
    expect(wrapped.other).toBe(wrapped.other)
    expect(wrapped[WRAPPED]).toBe(true)
    expect(opt.wrap(wrapped)).toBe(wrapped)
  })

  test('rejects unsupported clients', () => {
    expect(() => setup().opt.wrap({})).toThrow(TypeError)
  })

  test('foundation-models client', async () => {
    const { opt, events } = setup()
    const client = { modelDeployment: { modelName: 'gpt-4o', resourceGroup: 'rg' }, run: jest.fn(async () => response({ getRequestId: () => undefined })) }
    await opt.wrap(client).run({ messages: [{ role: 'user', content: 'x' }], max_tokens: 5 })
    expect(events[0]).toMatchObject({ sdk: 'foundation-models', model: 'gpt-4o', resourceGroup: 'rg', requestId: null })
  })

  test('a stream that can\'t be tracked is passed through and recorded right away', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(orchestrationClient()).stream({ messages: [] })
    expect(res).toEqual({ stream: 'S' })
    expect(events[0]).toMatchObject({ operation: 'stream', status: 'success', tokens: { prompt: null } })
  })

  test('errors are rethrown unchanged and classified', async () => {
    const { opt, events } = setup()
    const err = httpError(429, { error: { code: 429, message: 'Rate limit exceeded' } }, { 'retry-after': '1' })
    const wrapped = opt.wrap(orchestrationClient(async () => { throw err }))
    await expect(wrapped.chatCompletion({ messages: [] })).rejects.toBe(err)
    expect(events[0]).toMatchObject({ status: 'error', error: { category: 'RATE_LIMIT', httpStatus: 429 }, tokens: { prompt: null } })
    expect(opt.stats().errorsByCategory).toEqual({ RATE_LIMIT: 1 })
  })

  test('applies the configured timeout unless the caller set one', async () => {
    const { opt } = setup({ timeoutMs: 1234 })
    const client = orchestrationClient()
    const wrapped = opt.wrap(client)
    await wrapped.chatCompletion({ messages: [] })
    await wrapped.chatCompletion({ messages: [] }, { timeout: 5 })
    expect(client.chatCompletion.mock.calls[0][1]).toEqual({ timeout: 1234 })
    expect(client.chatCompletion.mock.calls[1][1]).toEqual({ timeout: 5 })
  })

  test('retries retryable errors when enabled, honouring Retry-After', async () => {
    const sleep = jest.fn(async () => {})
    const opt = new TokenOptimizer({ mode: 'off', metrics: { exporters: [] }, retry: { enabled: true, maxRetries: 2 } }, { sleep })
    const events = []
    opt.on('call', e => events.push(e))
    let n = 0
    const client = orchestrationClient(async () => {
      n++
      if (n === 1) throw httpError(429, {}, { 'retry-after': '2' })
      if (n === 2) throw httpError(503)
      return response()
    })
    await opt.wrap(client).chatCompletion({ messages: [] })
    expect(client.chatCompletion).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls[0][0]).toBe(2000)
    expect(sleep.mock.calls[1][0]).toBeGreaterThanOrEqual(500)
    expect(sleep.mock.calls[1][0]).toBeLessThanOrEqual(1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'success', retries: 2 })
  })

  test('gives up after maxRetries and does not retry other categories', async () => {
    const { opt: noRetry, events: e1 } = setup({ retry: { enabled: true, maxRetries: 1 } })
    const failing = orchestrationClient(async () => { throw httpError(500) })
    await expect(noRetry.wrap(failing).chatCompletion({})).rejects.toThrow()
    expect(failing.chatCompletion).toHaveBeenCalledTimes(2)
    expect(e1[0]).toMatchObject({ status: 'error', retries: 1, error: { category: 'SERVER' } })

    const filtered = orchestrationClient(async () => { throw httpError(400, { error: { code: 'content_filter', message: 'x' } }) })
    await expect(noRetry.wrap(filtered).chatCompletion({})).rejects.toThrow()
    expect(filtered.chatCompletion).toHaveBeenCalledTimes(1)
  })

  test('retry delay is capped by maxDelayMs', () => {
    const { opt } = setup()
    const cfg = { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 1500, on: ['SERVER'] } }
    expect(opt._retryDelay(cfg, { category: 'SERVER', retryAfterMs: 60000 }, 0)).toBe(1500)
    expect(opt._retryDelay(cfg, { category: 'SERVER', retryAfterMs: null }, 4)).toBe(1500)
    expect(opt._retryDelay(cfg, { category: 'AUTH', retryAfterMs: null }, 0)).toBeNull()
  })

  test('metrics problems never break the call', async () => {
    const { opt } = setup()
    opt.on('call', () => { throw new Error('listener') })
    const client = orchestrationClient(async () => response({ getTokenUsage () { throw new Error('usage') }, getRequestId () { throw new Error('id') } }))
    Object.defineProperty(client, 'config', { get () { throw new Error('config getter') } })
    const res = await opt.wrap(client).chatCompletion({ messages: [] })
    expect(res.getContent()).toBe('answer')
    expect(opt.stats().calls).toBe(1)
  })

  test('reads tenant, user and service from cds.context', async () => {
    globalThis.cds = { context: { tenant: 't1', user: { id: 'alice' }, http: { req: { baseUrl: '/odata/v4/agent' } } } }
    const { opt, events } = setup({ metrics: { exporters: [], userHashSalt: 'pepper' } })
    await opt.wrap(orchestrationClient()).chatCompletion({ messages: [] })
    expect(events[0]).toMatchObject({ tenant: 't1', cdsService: '/odata/v4/agent' })
    expect(events[0].user).toHaveLength(16)
    expect(events[0].user).not.toContain('alice')
  })

  test('per-use-case config applies', async () => {
    const { opt, events } = setup({ captureContent: false, useCases: { debug: { captureContent: true } } })
    await opt.wrap(orchestrationClient(), { useCase: 'debug' }).chatCompletion({ messages: [] })
    await opt.wrap(orchestrationClient(), { useCase: 'prod' }).chatCompletion({ messages: [] })
    expect(events[0].content).toBeDefined()
    expect(events[1].content).toBeUndefined()
  })
})

describe('TokenOptimizer lifecycle', () => {
  test('configures itself from cds.env on first call', async () => {
    globalThis.cds = { env: { requires: { tokenOptimizer: { mode: 'shadow', cache: { enabled: false }, metrics: { exporters: [] } } } } }
    const opt = new TokenOptimizer()
    expect(opt.config.mode).toBe('active')
    await opt.wrap(orchestrationClient()).chatCompletion({})
    expect(opt.config.mode).toBe('shadow')
  })

  test('configure() replaces and shuts down previous exporters', async () => {
    const first = { name: 'first', export: jest.fn(), shutdown: jest.fn() }
    const opt = new TokenOptimizer({ mode: 'off', metrics: { exporters: [first] } })
    const second = { name: 'second', export: jest.fn() }
    opt.configure({ mode: 'off', metrics: { exporters: [second] } })
    await new Promise(setImmediate)
    expect(first.shutdown).toHaveBeenCalled()
    await opt.wrap(orchestrationClient()).chatCompletion({})
    expect(first.export).not.toHaveBeenCalled()
    expect(second.export).toHaveBeenCalledTimes(1)
    await opt.shutdown()
  })

  test('on/off/once, flush, resetStats', async () => {
    const opt = new TokenOptimizer({ mode: 'off', metrics: { exporters: [] } })
    const a = jest.fn(); const b = jest.fn()
    opt.on('call', a).once('call', b)
    const w = opt.wrap(orchestrationClient())
    await w.chatCompletion({})
    opt.off('call', a)
    await w.chatCompletion({})
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    await expect(opt.flush()).resolves.toBeUndefined()
    opt.resetStats()
    expect(opt.stats().calls).toBe(0)
    await opt.shutdown()
  })
})

describe('TokenOptimizer.chat validation', () => {
  test('requires model and messages', async () => {
    const opt = new TokenOptimizer({ metrics: { exporters: [] } })
    await expect(opt.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/model/)
    await expect(opt.chat({ model: 'gpt-4.1' })).rejects.toThrow(/messages/)
    await expect(opt.chat({ model: 'gpt-4.1', messages: [{}], sdk: 'nope' })).rejects.toThrow(/unknown sdk/)
  })
})

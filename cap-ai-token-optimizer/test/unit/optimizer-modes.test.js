'use strict'
const { TokenOptimizer } = require('../../lib/optimizer')
const { MemoryCacheStore } = require('../../lib/cache')
const log = require('../../lib/util/log')

const warn = jest.fn()
beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
afterAll(() => log._set(undefined))
beforeEach(() => warn.mockClear())

class FakeResponse {
  constructor (raw) { this.rawResponse = raw; this._data = raw.data }
  getTokenUsage () { return this._data.usage }
  getContent () { return this._data.choices[0].message.content }
  getFinishReason () { return 'stop' }
  getRequestId () { return this.rawResponse.headers?.['x-aicore-request-id'] }
}

/** Foundation-models style fake: records the requests it receives. */
class FakeChatClient {
  constructor (modelDeployment) {
    this.modelDeployment = modelDeployment
    this.requests = []
  }

  async run (request) {
    this.requests.push(request)
    const prompt = JSON.stringify(request.messages).length
    return new FakeResponse({
      data: { choices: [{ index: 0, message: { content: `answer ${this.requests.length}` } }], usage: { prompt_tokens: prompt, completion_tokens: 7, total_tokens: prompt + 7 } },
      headers: { 'x-aicore-request-id': `req-${this.requests.length}` }
    })
  }
}

const RULE = 'Always answer in English and keep answers short and precise.'
const tools = Array.from({ length: 20 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: `Tool ${i}` } }))
function request (extra = {}) {
  const messages = [{ role: 'system', content: `You are an agent.\n\n${RULE}` }]
  for (let i = 0; i < 12; i++) messages.push({ role: 'user', content: `Q${i}   with   spaces\n\n${RULE}` }, { role: 'assistant', content: `A${i}` })
  return { messages, tools, temperature: 0, ...extra }
}

function setup (config = {}) {
  const opt = new TokenOptimizer({ metrics: { exporters: [] }, ...config })
  const events = []
  opt.on('call', e => events.push(e))
  const client = new FakeChatClient('gpt-4.1')
  return { opt, events, client, wrapped: opt.wrap(client, { useCase: 'agent' }) }
}

describe('active mode', () => {
  test('sends the optimized request and reports savings', async () => {
    const { client, wrapped, events } = setup()
    const req = request()
    const original = structuredClone(req)
    await wrapped.run(req)
    const sent = client.requests[0]
    expect(req).toEqual(original)
    expect(sent.messages.length).toBeLessThan(req.messages.length)
    expect(sent.messages.filter(m => m.role === 'user')).toHaveLength(10)
    expect(sent.messages.some(m => m.content.includes('   '))).toBe(false)
    expect(sent.tools).toHaveLength(15)
    expect(sent.max_tokens).toBe(1024)
    const e = events[0]
    expect(e.mode).toBe('active')
    expect(e.tokens.promptEstimatedAfter).toBeLessThan(e.tokens.promptEstimatedBefore)
    expect(e.savings.estimatedTokens).toBe(e.tokens.promptEstimatedBefore - e.tokens.promptEstimatedAfter)
    expect(Object.keys(e.savings.byStep)).toEqual(['normalize', 'dedupe', 'history', 'tools', 'outputCap'])
    expect(e.savings.notes.length).toBeGreaterThan(0)
    expect(JSON.stringify(e.savings.notes)).not.toContain('Q1')
  })

  test('serves identical low-temperature requests from the cache', async () => {
    const { opt, client, wrapped, events } = setup({ pricing: { 'gpt-4.1': { inputPer1k: 1, outputPer1k: 1 } } })
    const first = await wrapped.run(request())
    const second = await wrapped.run(request())
    expect(client.requests).toHaveLength(1)
    expect(second).toBeInstanceOf(FakeResponse)
    expect(second.getContent()).toBe(first.getContent())
    expect(second).not.toBe(first)
    expect(events[1]).toMatchObject({ requestId: null, costEstimate: 0, tokens: { prompt: 0, completion: 0, total: 0 }, savings: { cacheHit: true } })
    expect(events[1].savings.byStep.cache).toBe(first.getTokenUsage().total_tokens)
    expect(opt.stats().cacheHits).toBe(1)
  })

  test('does not cache higher temperatures, streams or errors', async () => {
    const { client, wrapped } = setup()
    await wrapped.run(request({ temperature: 0.7 }))
    await wrapped.run(request({ temperature: 0.7 }))
    expect(client.requests).toHaveLength(2)

    let fail = true
    client.run = async function (req) {
      if (fail) { fail = false; throw Object.assign(new Error('boom'), { status: 500 }) }
      return FakeChatClient.prototype.run.call(this, req)
    }
    await expect(wrapped.run(request())).rejects.toThrow('boom')
    await wrapped.run(request())
    expect(client.requests).toHaveLength(3)
  })

  test('cache scope is per tenant by default', async () => {
    const { client, wrapped } = setup()
    globalThis.cds = { context: { tenant: 't1' } }
    await wrapped.run(request())
    globalThis.cds = { context: { tenant: 't2' } }
    await wrapped.run(request())
    globalThis.cds = { context: { tenant: 't1' } }
    await wrapped.run(request())
    delete globalThis.cds
    expect(client.requests).toHaveLength(2)
  })

  test('a custom (async) cache store can be plugged in; store failures are ignored', async () => {
    const map = new Map()
    const store = { get: jest.fn(async k => map.get(k)), set: jest.fn(async (k, v) => { map.set(k, v) }) }
    const { client, wrapped } = setup({ cache: { store } })
    await wrapped.run(request())
    await new Promise(setImmediate)
    await wrapped.run(request())
    expect(client.requests).toHaveLength(1)
    expect(store.set).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sdk: 'foundation-models' }), 3600000)

    const broken = { get: async () => { throw new Error('down') }, set: () => { throw new Error('down') } }
    const b = setup({ cache: { store: broken } })
    await b.wrapped.run(request())
    await b.wrapped.run(request())
    expect(b.client.requests).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith('cache read failed:', 'down')
    expect(warn).toHaveBeenCalledWith('cache write failed:', 'down')
  })

  test('a rejected async cache write is logged', async () => {
    const store = { get: async () => undefined, set: async () => { throw new Error('async down') } }
    const { wrapped } = setup({ cache: { store } })
    await wrapped.run(request())
    await new Promise(setImmediate)
    expect(warn).toHaveBeenCalledWith('cache write failed:', 'async down')
  })

  test('a failing pipeline sends the original request', async () => {
    const { client, wrapped, events } = setup({ steps: { history: { maxTurns: 2, strategy: () => { throw new Error('bad strategy') } } } })
    const req = request()
    await wrapped.run(req)
    expect(client.requests[0]).toEqual(req)
    expect(events[0].savings).toMatchObject({ failed: true, estimatedTokens: 0, notes: ['pipeline failed; original request sent'] })
    expect(events[0].tokens.promptEstimatedAfter).toBe(events[0].tokens.promptEstimatedBefore)
    expect(warn).toHaveBeenCalledWith('optimizer pipeline failed, sending the original request:', 'bad strategy')
  })

  test('per-use-case steps', async () => {
    const { client, opt } = setup({ useCases: { strict: { steps: { outputCap: { default: 64 } } } } })
    await opt.wrap(client, { useCase: 'strict' }).run({ messages: [{ role: 'user', content: 'x' }] })
    expect(client.requests[0].max_tokens).toBe(64)
  })

  test('streams are passed through without optimization', async () => {
    const { client, opt } = setup()
    client.stream = jest.fn(async () => ({ stream: true }))
    const req = request()
    await opt.wrap(client).stream(req)
    expect(client.stream.mock.calls[0][0]).toBe(req)
  })

  test('captureContent records what was actually sent', async () => {
    const { wrapped, events } = setup({ captureContent: true, steps: { history: { maxTurns: 1 } } })
    await wrapped.run(request())
    expect(events[0].content.messages.filter(m => m.role === 'user')).toHaveLength(1)
  })
})

describe('shadow mode', () => {
  test('sends the original request but records what would have been saved', async () => {
    const { client, wrapped, events } = setup({ mode: 'shadow' })
    const req = request()
    await wrapped.run(req)
    expect(client.requests[0]).toEqual(req)
    const e = events[0]
    expect(e.mode).toBe('shadow')
    expect(e.tokens.promptEstimatedAfter).toBeLessThan(e.tokens.promptEstimatedBefore)
    expect(e.savings.estimatedTokens).toBeGreaterThan(0)
  })

  test('never serves from the cache, but records would-be hits', async () => {
    const { client, wrapped, events } = setup({ mode: 'shadow' })
    await wrapped.run(request())
    await wrapped.run(request())
    expect(client.requests).toHaveLength(2)
    expect(events[0].savings.cacheHit).toBe(false)
    expect(events[1].savings.cacheHit).toBe(true)
    expect(events[1].savings.byStep.cache).toBeGreaterThan(0)
    expect(events[1].tokens.total).toBeGreaterThan(0)
  })
})

describe('off mode', () => {
  test('no optimization and no cache', async () => {
    const { client, wrapped, events } = setup({ mode: 'off' })
    const req = request()
    await wrapped.run(req)
    await wrapped.run(req)
    expect(client.requests).toEqual([req, req])
    expect(events[0].savings).toMatchObject({ estimatedTokens: 0, byStep: {}, cacheHit: false })
  })
})

describe('robustness', () => {
  test('unreadable call details leave the call untouched', async () => {
    const { client, opt, events } = setup()
    Object.defineProperty(client, 'modelDeployment', { get () { throw new Error('nope') } })
    const req = request()
    await opt.wrap(client).run(req)
    expect(client.requests[0]).toBe(req)
    expect(events).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith('could not read call details:', 'nope')
  })

  test('a response that cannot be rebuilt from the cache falls back to calling AI Core', async () => {
    const store = new MemoryCacheStore()
    const { client, wrapped } = setup({ cache: { store } })
    await wrapped.run(request())
    for (const k of store._map.keys()) store._map.get(k).value.sdk = 'unknown'
    await wrapped.run(request())
    expect(client.requests).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith('could not rebuild cached response:', expect.any(String))
  })

  test('responses without data are not cached', async () => {
    const { client, wrapped } = setup()
    client.run = jest.fn(async () => ({ getTokenUsage: () => undefined }))
    await wrapped.run(request())
    await wrapped.run(request())
    expect(client.run).toHaveBeenCalledTimes(2)
  })

  test('cache key failures are logged', async () => {
    const { client, opt } = setup()
    const circular = { role: 'user', content: 'x' }
    const req = { messages: [circular], temperature: 0, extra: {} }
    req.extra.self = req.extra
    await opt.wrap(client).run(req)
    expect(warn).toHaveBeenCalledWith('could not compute cache key:', expect.any(String))
  })
})

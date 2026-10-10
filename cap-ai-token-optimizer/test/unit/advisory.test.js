'use strict'
const { TokenOptimizer } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const warn = jest.fn()
beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
afterAll(() => log._set(undefined))
beforeEach(() => warn.mockClear())

class FakeResponse {
  constructor (raw) { this.rawResponse = raw; this._data = raw.data }
  getTokenUsage () { return this._data.usage }
}

class FakeChatClient {
  constructor (model) { this.modelDeployment = model; this.requests = [] }
  async run (request) {
    this.requests.push(request)
    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    return new FakeResponse({ data: { usage }, headers: {} })
  }
}

const tools = Array.from({ length: 4 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: `topic${i} lookup` } }))
const req = (system, user = 'hi', extra = {}) => ({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...extra })

function setup (config = {}) {
  const opt = new TokenOptimizer({ metrics: { exporters: [] }, ...config })
  const events = []
  const advisories = []
  opt.on('call', e => events.push(e))
  opt.on('advisory', a => advisories.push(a))
  return { opt, events, advisories, client: opt.wrap(new FakeChatClient('gpt-4.1'), { useCase: 'agent' }) }
}

describe('prompt-caching advisory', () => {
  test('flags a changed system prompt for the same use case and model', async () => {
    const { opt, events, advisories, client } = setup()
    await client.run(req('You are helpful. Today is Monday.'))
    await client.run(req('You are helpful. Today is Monday.', 'other question'))
    await client.run(req('You are helpful. Today is Tuesday.'))
    expect(events.map(e => e.advisory.promptPrefixChanged)).toEqual([false, false, true])
    expect(events[2].advisory).toEqual({ promptPrefixChanged: true, changed: ['system'], causedByOptimizer: false })
    expect(advisories).toEqual([{ type: 'PROMPT_PREFIX_CHANGED', useCase: 'agent', model: 'gpt-4.1', promptPrefixChanged: true, changed: ['system'], causedByOptimizer: false }])
    expect(opt.stats().promptPrefixChanges).toEqual({ agent: 1 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/prompt prefix \(system\) changed for use case "agent"/))
  })

  test('use cases and models are tracked separately', async () => {
    const { opt, events } = setup()
    await opt.wrap(new FakeChatClient('gpt-4.1'), { useCase: 'a' }).run(req('A'))
    await opt.wrap(new FakeChatClient('gpt-4.1'), { useCase: 'b' }).run(req('B'))
    await opt.wrap(new FakeChatClient('gpt-4o'), { useCase: 'a' }).run(req('C'))
    expect(events.every(e => !e.advisory.promptPrefixChanged)).toBe(true)
  })

  test('detects tool changes made by the optimizer', async () => {
    const { events, client } = setup({ steps: { tools: { maxTools: 1 } } })
    await client.run(req('S', 'topic1 please', { tools }))
    await client.run(req('S', 'topic3 please', { tools }))
    expect(events[1].advisory).toEqual({ promptPrefixChanged: true, changed: ['tools'], causedByOptimizer: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('by the optimizer'))
  })

  test('shadow mode compares what is actually sent (the original)', async () => {
    const { events, client } = setup({ mode: 'shadow', steps: { tools: { maxTools: 1 } } })
    await client.run(req('S', 'topic1 please', { tools }))
    await client.run(req('S', 'topic3 please', { tools }))
    expect(events[1].advisory.promptPrefixChanged).toBe(false)
  })

  test('logs at most once per interval, but counts every change', async () => {
    const { opt, client } = setup()
    for (const s of ['1', '2', '3', '4']) await client.run(req(s))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(opt.stats().promptPrefixChanges.agent).toBe(3)
  })

  test('not checked for cache hits or when disabled', async () => {
    const a = setup()
    await a.client.run(req('S', 'q', { temperature: 0 }))
    await a.client.run(req('S', 'q', { temperature: 0 }))
    expect(a.events[1].savings.cacheHit).toBe(true)
    expect(a.events[1].advisory).toBeNull()

    const b = setup({ advisories: { promptCache: false } })
    await b.client.run(req('S1'))
    await b.client.run(req('S2'))
    expect(b.events[1].advisory).toBeNull()
  })

  test('keeps a bounded number of prefixes', async () => {
    const { opt } = setup()
    for (let i = 0; i < 1005; i++) await opt.wrap(new FakeChatClient('m'), { useCase: `uc${i}` }).run(req('S'))
    expect(opt._prefixes.size).toBe(1000)
  })
})

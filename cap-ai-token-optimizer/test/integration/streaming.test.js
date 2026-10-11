'use strict'
/**
 * Streaming calls with the real @sap-ai-sdk clients against the mock AI Core server, which
 * answers streams as server-sent events with token usage in the last chunk. The event of a
 * streamed call is recorded when the stream ends and carries AI Core's usage.
 */
const { createMockAiCore } = require('../mock-aicore/server')
const { TokenOptimizer } = require('../../lib/optimizer')
const instrument = require('../../lib/client/instrument')
const log = require('../../lib/util/log')

const mock = createMockAiCore()
let OrchestrationClient, AzureOpenAiChatClient, LcOrchestrationClient

beforeAll(async () => {
  log._set({ debug () {}, info () {}, warn () {}, error () {} })
  await mock.start()
  process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  ;({ OrchestrationClient } = require('@sap-ai-sdk/orchestration'))
  ;({ AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models'))
  ;({ OrchestrationClient: LcOrchestrationClient } = require('@sap-ai-sdk/langchain'))
})
afterAll(async () => { await mock.stop(); delete process.env.AICORE_SERVICE_KEY; log._set(undefined) })
beforeEach(() => mock.reset())
afterEach(() => instrument.uninstall())

function setup (config = {}, deps) {
  const opt = new TokenOptimizer({ metrics: { exporters: [] }, pricing: { 'gpt-4.1': { inputPer1k: 1, outputPer1k: 2 } }, ...config }, deps)
  const events = []
  opt.on('call', e => events.push(e))
  return { opt, events }
}

const orchestration = () => new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } })
const ask = (content = 'What is CAP?') => ({ messages: [{ role: 'user', content }] })

async function readAll (stream) {
  let text = ''
  for await (const chunk of stream) text += chunk.getDeltaContent() ?? ''
  return text
}

describe('streams are recorded when they end', () => {
  test('orchestration: real usage, finish reason, request id, cost; chunks unchanged', async () => {
    const expected = await readAll((await orchestration().stream(ask())).stream)
    const { opt, events } = setup()
    const res = await opt.wrap(orchestration(), { useCase: 'agent' }).stream(ask())
    expect(events).toHaveLength(0)

    expect(await readAll(res.stream)).toBe(expected)
    const usage = res.getTokenUsage()
    expect(usage.total_tokens).toBeGreaterThan(0)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      operation: 'stream', sdk: 'orchestration', useCase: 'agent', status: 'success', error: null,
      finishReason: 'stop', requestId: res.getRequestId(),
      tokens: { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens }
    })
    expect(events[0].savings.notes).toEqual([])
    expect(events[0].costEstimate).toBeCloseTo((usage.prompt_tokens * 1 + usage.completion_tokens * 2) / 1000, 6)
    expect(opt.stats().tokens.total).toBe(usage.total_tokens)
  })

  test('foundation models: real usage from the usage chunk', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(new AzureOpenAiChatClient('gpt-4.1')).stream(ask())
    expect(await readAll(res.stream)).toMatch(/Mock answer/)
    const usage = res.getTokenUsage()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      operation: 'stream', sdk: 'foundation-models', status: 'success', finishReason: 'stop',
      tokens: { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens, cached: 0 }
    })
  })

  test('the stream keeps its class, e.g. toContentStream() works', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(orchestration()).stream(ask())
    let text = ''
    for await (const delta of res.stream.toContentStream()) text += delta
    expect(text).toMatch(/Mock answer/)
    expect(events).toHaveLength(1)
    expect(events[0].tokens.total).toBeGreaterThan(0)
  })

  test('latency covers the whole stream', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(orchestration()).stream(ask())
    await new Promise(resolve => setTimeout(resolve, 60))
    await readAll(res.stream)
    expect(events[0].latencyMs).toBeGreaterThanOrEqual(55)
  })

  test('a failure inside the stream is rethrown unchanged and recorded as an error', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(orchestration()).stream(ask('x [[mock:stream_error]]'))
    let thrown
    try { await readAll(res.stream) } catch (e) { thrown = e }
    expect(thrown?.message).toBe('Error while iterating over SSE stream.')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      operation: 'stream', status: 'error',
      error: { category: 'SERVER', httpStatus: 500, message: 'Mock: stream interrupted' },
      tokens: { prompt: null, completion: null }
    })
    expect(opt.stats().errorsByCategory).toEqual({ SERVER: 1 })
  })

  test('an error before the stream starts is recorded once, as before', async () => {
    const { opt, events } = setup()
    await expect(opt.wrap(orchestration()).stream(ask('x [[mock:rate_limit]]'))).rejects.toThrow()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation: 'stream', status: 'error', error: { category: 'RATE_LIMIT' } })
  })

  test('a stream closed early by the caller is recorded with a note', async () => {
    const { opt, events } = setup()
    const res = await opt.wrap(orchestration()).stream(ask())
    for await (const chunk of res.stream) { if (chunk) break }
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'success', tokens: { total: null } })
    expect(events[0].savings.notes).toEqual(['stream: closed by the caller before the end'])
  })

  test('a stream that is never read is recorded after the record timeout', async () => {
    const { opt, events } = setup({}, { streamRecordTimeoutMs: 30 })
    const res = await opt.wrap(orchestration()).stream(ask())
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(events).toHaveLength(1)
    expect(events[0].savings.notes).toEqual(['stream: not read to the end within the record timeout'])
    // reading it later neither fails nor records a second event
    expect(await readAll(res.stream)).toMatch(/Mock answer/)
    expect(events).toHaveLength(1)
  })
})

describe('LangChain streaming, as used by @cap-js/agents', () => {
  test('autoInstrument records the usage of a streaming model', async () => {
    const { events } = setup({ autoInstrument: { enabled: true, useCase: 'agent' } })
    const model = new LcOrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }, { streaming: true })
    const answer = await model.invoke('What is CAP?')
    expect(answer.content).toMatch(/Mock answer/)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation: 'stream', useCase: 'agent', status: 'success', finishReason: 'stop' })
    expect(events[0].tokens.total).toBeGreaterThan(0)
  })

  test('wrapLangChain records the usage of model.stream()', async () => {
    const { opt, events } = setup()
    const model = opt.wrapLangChain(new LcOrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }), { useCase: 'chat' })
    let text = ''
    for await (const chunk of await model.stream('What is CAP?')) text += chunk.content
    expect(text).toMatch(/Mock answer/)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation: 'stream', useCase: 'chat', status: 'success' })
    expect(events[0].tokens.total).toBeGreaterThan(0)
  })
})

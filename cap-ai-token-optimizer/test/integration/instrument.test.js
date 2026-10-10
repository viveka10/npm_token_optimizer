'use strict'
/**
 * autoInstrument, withUseCase() and wrapLangChain() with the real SDK classes against the mock.
 */
const { createMockAiCore } = require('../mock-aicore/server')
const { TokenOptimizer } = require('../../lib/optimizer')
const instrument = require('../../lib/client/instrument')
const log = require('../../lib/util/log')

const mock = createMockAiCore()
let OrchestrationClient, AzureOpenAiChatClient, LcOrchestrationClient, LcAzureOpenAiChatClient, HumanMessage
const info = jest.fn()
const warn = jest.fn()

beforeAll(async () => {
  log._set({ debug () {}, info, warn, error () {} })
  await mock.start()
  process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  ;({ OrchestrationClient } = require('@sap-ai-sdk/orchestration'))
  ;({ AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models'))
  ;({ OrchestrationClient: LcOrchestrationClient, AzureOpenAiChatClient: LcAzureOpenAiChatClient } = require('@sap-ai-sdk/langchain'))
  ;({ HumanMessage } = require('@langchain/core/messages'))
})
afterAll(async () => { await mock.stop(); delete process.env.AICORE_SERVICE_KEY; log._set(undefined) })
beforeEach(() => { mock.reset(); info.mockClear(); warn.mockClear() })
afterEach(() => instrument.uninstall())

const tools = Array.from({ length: 20 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: `Tool ${i}`, parameters: { type: 'object', properties: {} } } }))
const ask = { messages: [{ role: 'user', content: 'Hello   there' }] }

function setup (config = {}) {
  const opt = new TokenOptimizer({ metrics: { exporters: [] }, ...config })
  const events = []
  opt.on('call', e => events.push(e))
  return { opt, events }
}

describe('autoInstrument', () => {
  test('existing clients are optimized and measured without code changes', async () => {
    const { events } = setup({ autoInstrument: true })
    expect(info).toHaveBeenCalledWith('autoInstrument: OrchestrationClient, AzureOpenAiChatClient calls are optimized and measured')
    const client = new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' }, prompt: { tools } } })
    const res = await client.chatCompletion(ask)
    expect(res.getContent()).toMatch(/Mock answer/)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ useCase: 'default', sdk: 'orchestration', status: 'success' })
    const pt = mock.state.requests[0].body.config.modules.prompt_templating
    expect(pt.prompt.tools).toHaveLength(15)
    expect(pt.prompt.template.at(-1).content).toBe('Hello there')

    await new AzureOpenAiChatClient('gpt-4.1').run({ messages: [{ role: 'user', content: 'x' }] })
    expect(events[1]).toMatchObject({ sdk: 'foundation-models' })
  })

  test('the use case comes from config or withUseCase()', async () => {
    const { opt, events } = setup({ autoInstrument: { enabled: true, useCase: 'legacy' } })
    const client = new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } })
    await client.chatCompletion(ask)
    await opt.withUseCase('invoice', () => client.chatCompletion(ask), { cdsService: 'InvoiceService' })
    expect(events.map(e => [e.useCase, e.cdsService])).toEqual([['legacy', null], ['invoice', 'InvoiceService']])
  })

  test('explicitly wrapped clients are measured once', async () => {
    const { opt, events } = setup({ autoInstrument: true })
    const wrapped = opt.wrap(new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }), { useCase: 'explicit' })
    await wrapped.chatCompletion(ask)
    expect(events).toHaveLength(1)
    expect(events[0].useCase).toBe('explicit')
    expect(mock.state.requests).toHaveLength(1)
  })

  test('errors are rethrown and recorded', async () => {
    const { events } = setup({ autoInstrument: true })
    mock.setScenario('rate_limit')
    await expect(new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }).chatCompletion(ask)).rejects.toThrow(/429/)
    expect(events[0].error.category).toBe('RATE_LIMIT')
  })

  test('off by default; switching it off restores pass-through', async () => {
    const { opt, events } = setup()
    const client = new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } })
    await client.chatCompletion(ask)
    expect(events).toHaveLength(0)
    opt.configure({ metrics: { exporters: [] }, autoInstrument: true })
    await client.chatCompletion(ask)
    opt.configure({ metrics: { exporters: [] }, autoInstrument: false })
    await client.chatCompletion(ask)
    expect(events).toHaveLength(1)
    expect(mock.state.requests.map(r => r.body.messages ?? r.body.config.modules.prompt_templating.prompt.template.at(-1).content))
      .toEqual(['Hello   there', 'Hello there', 'Hello   there'])
  })

  test('uninstall restores the original methods', () => {
    setup({ autoInstrument: true })
    expect(OrchestrationClient.prototype.chatCompletion[instrument.ORIGINAL]).toBeDefined()
    instrument.uninstall()
    expect(OrchestrationClient.prototype.chatCompletion[instrument.ORIGINAL]).toBeUndefined()
  })
})

describe('wrapLangChain', () => {
  test('orchestration chat model: invoke and bound tools are optimized and measured', async () => {
    const { opt, events } = setup()
    const model = opt.wrapLangChain(new LcOrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } } } }), { useCase: 'lc-agent' })
    expect(opt.wrapLangChain(model)).toBe(model)

    const res = await model.invoke([new HumanMessage('Hello   from LangChain')])
    expect(res.content).toMatch(/Hello from LangChain/)
    expect(events[0]).toMatchObject({ useCase: 'lc-agent', sdk: 'orchestration', model: 'gpt-4.1', status: 'success' })
    expect(events[0].savings.byStep.normalize).toBeGreaterThan(0)

    const withTools = model.bindTools(tools.map(t => ({ ...t.function, schema: t.function.parameters })))
    await withTools.invoke([new HumanMessage('Use a tool')])
    expect(events).toHaveLength(2)
    expect(mock.state.requests[1].body.config.modules.prompt_templating.prompt.tools).toHaveLength(15)
  })

  test('identical low-temperature LangChain calls are served from the cache', async () => {
    const { opt, events } = setup()
    const model = opt.wrapLangChain(new LcOrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } } } }))
    const a = await model.invoke('Same question')
    const b = await model.invoke('Same question')
    expect(b.content).toBe(a.content)
    expect(mock.state.requests).toHaveLength(1)
    expect(events[1].savings.cacheHit).toBe(true)
  })

  test('Azure OpenAI chat model', async () => {
    const { opt, events } = setup()
    const model = opt.wrapLangChain(new LcAzureOpenAiChatClient({ modelName: 'gpt-4.1' }), { useCase: 'lc-fm' })
    await model.invoke('Hi')
    expect(events[0]).toMatchObject({ useCase: 'lc-fm', sdk: 'foundation-models' })
  })

  test('unwrapped LangChain models are not measured', async () => {
    const { events } = setup()
    instrument.install()
    await new LcOrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1' } } }).invoke('Hi')
    expect(events).toHaveLength(0)
  })

  test('streaming runs every step in the optimizer scope', async () => {
    const { opt, events } = setup()
    const seen = []
    const fake = {
      _generate () {},
      async * _streamResponseChunks () {
        seen.push(instrument.scopes.getStore()?.opts.useCase)
        yield 'a'
        seen.push(instrument.scopes.getStore()?.opts.useCase)
        yield 'b'
      }
    }
    opt.wrapLangChain(fake, { useCase: 'stream' })
    const out = []
    for await (const c of fake._streamResponseChunks()) out.push(c)
    expect(out).toEqual(['a', 'b'])
    expect(seen).toEqual(['stream', 'stream'])
    expect(events).toHaveLength(0)
  })

  test('rejects other objects', () => {
    expect(() => setup().opt.wrapLangChain({})).toThrow(/LangChain chat model/)
  })
})

describe('instrumentation safety', () => {
  test('skips unsupported SDK major versions', () => {
    const Cls = class { chatCompletion () {} }
    const hooked = instrument.install({ load: (pkg) => pkg.includes('orchestration') ? { OrchestrationClient: Cls } : {}, version: () => '3.0.0' })
    expect(hooked).toEqual([])
    expect(Cls.prototype.chatCompletion[instrument.ORIGINAL]).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('@3.0.0 is not supported'))
  })

  test('missing or broken SDK packages are skipped', () => {
    const missing = Object.assign(new Error('missing'), { code: 'PEER_DEPENDENCY_MISSING' })
    expect(instrument.install({ load: () => { throw missing }, version: () => null })).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(instrument.install({ load: () => { throw new Error('boom') }, version: () => null })).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not load'), 'boom')
  })

  test('a class whose methods cannot be replaced is skipped', () => {
    const Cls = class {}
    Object.defineProperty(Cls.prototype, 'chatCompletion', { value () {}, writable: false })
    const hooked = instrument.install({ load: (pkg) => pkg.includes('orchestration') ? { OrchestrationClient: Cls } : {}, version: () => '2.16.0' })
    expect(hooked).toEqual([])
    expect(warn).toHaveBeenCalledWith('could not instrument OrchestrationClient.chatCompletion:', expect.any(String))
  })

  test('warns when no SDK can be instrumented, and when moving to another optimizer', () => {
    const a = new TokenOptimizer({ metrics: { exporters: [] } })
    const b = new TokenOptimizer({ metrics: { exporters: [] } })
    instrument.enableAuto(a)
    instrument.enableAuto(b)
    expect(warn).toHaveBeenCalledWith('autoInstrument moved to another optimizer instance')
    instrument.uninstall()
    expect(instrument.enableAuto(a, {}, { load: () => ({}), version: () => null })).toEqual([])
    expect(warn).toHaveBeenCalledWith('autoInstrument: no supported @sap-ai-sdk client found to instrument')
  })
})

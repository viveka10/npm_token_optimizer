'use strict'
/**
 * Optimization with the real @sap-ai-sdk clients against the mock AI Core server.
 */
const { createMockAiCore } = require('../mock-aicore/server')
const { TokenOptimizer } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const mock = createMockAiCore()
let OrchestrationClient, AzureOpenAiChatClient

beforeAll(async () => {
  log._set({ debug () {}, info () {}, warn () {}, error () {} })
  await mock.start()
  process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  ;({ OrchestrationClient } = require('@sap-ai-sdk/orchestration'))
  ;({ AzureOpenAiChatClient } = require('@sap-ai-sdk/foundation-models'))
})
afterAll(async () => { await mock.stop(); delete process.env.AICORE_SERVICE_KEY; log._set(undefined) })
beforeEach(() => mock.reset())

const RULE = 'Answer only with facts from the SAP system and say so when data is missing.'
const tools = Array.from({ length: 32 }, (_, i) => ({
  type: 'function',
  function: { name: i === 7 ? 'get_sales_order_status' : `s4_tool_${i}`, description: i === 7 ? 'Status of a sales order' : `Business function number ${i}`, parameters: { type: 'object', properties: {} } }
}))
function history (turns) {
  const out = []
  for (let i = 0; i < turns; i++) out.push({ role: 'user', content: `Earlier   question ${i}\n\n${RULE}` }, { role: 'assistant', content: `Earlier answer ${i}` })
  return out
}

function setup (config) {
  const opt = new TokenOptimizer({ metrics: { exporters: [] }, ...config })
  const events = []
  opt.on('call', e => events.push(e))
  return { opt, events }
}

const agentClient = () => new OrchestrationClient({
  promptTemplating: {
    model: { name: 'gpt-4.1', params: { temperature: 0 } },
    prompt: { template: [{ role: 'system', content: `You are an S/4HANA agent.\n\n${RULE}` }], tools }
  }
})
const ask = { messages: [{ role: 'user', content: 'What is the   status of sales order 4711?' }], messagesHistory: history(14) }

test('active: orchestration request is optimized, the caller\'s client is not changed', async () => {
  const { opt, events } = setup()
  const client = agentClient()
  const res = await opt.wrap(client, { useCase: 'agent' }).chatCompletion(ask)
  expect(res.getContent()).toMatch(/Mock answer/)

  const body = mock.state.requests[0].body
  const pt = body.config.modules.prompt_templating
  expect(pt.prompt.tools).toHaveLength(15)
  expect(pt.prompt.tools.map(t => t.function.name)).toContain('get_sales_order_status')
  expect(pt.model.params).toEqual({ temperature: 0, max_tokens: 1024 })
  expect(pt.prompt.template[0].content).toBe(`You are an S/4HANA agent.\n\n${RULE}`)
  expect(body.messages_history.filter(m => m.role === 'user')).toHaveLength(9)
  expect(body.messages_history.every(m => !m.content.includes(RULE))).toBe(true)
  expect(pt.prompt.template.at(-1).content).toBe('What is the status of sales order 4711?')
  expect(client.config.promptTemplating.prompt.tools).toHaveLength(32)

  const e = events[0]
  expect(e.savings.byStep.tools).toBeGreaterThan(0)
  expect(e.savings.byStep.history).toBeGreaterThan(0)
  expect(e.savings.byStep.dedupe).toBeGreaterThan(0)
  expect(e.tokens.prompt).toBeGreaterThan(0)
})

test('active: a cache hit skips the HTTP call', async () => {
  const { opt, events } = setup()
  const client = opt.wrap(agentClient())
  const first = await client.chatCompletion(ask)
  const second = await client.chatCompletion(ask)
  expect(mock.state.requests).toHaveLength(1)
  expect(second.getContent()).toBe(first.getContent())
  expect(second.getTokenUsage()).toEqual(first.getTokenUsage())
  expect(second.constructor).toBe(first.constructor)
  expect(events[1].savings.cacheHit).toBe(true)
})

test('shadow: the original request is sent', async () => {
  const plain = agentClient()
  await plain.chatCompletion(ask)
  const originalBody = mock.state.requests[0].body

  const { opt, events } = setup({ mode: 'shadow' })
  await opt.wrap(agentClient()).chatCompletion(ask)
  expect(mock.state.requests[1].body).toEqual(originalBody)
  expect(events[0].savings.estimatedTokens).toBeGreaterThan(0)
  expect(events[0].tokens.promptEstimatedAfter).toBeLessThan(events[0].tokens.promptEstimatedBefore)
})

test('active: foundation models request is optimized', async () => {
  const { opt, events } = setup()
  const client = opt.wrap(new AzureOpenAiChatClient('gpt-4.1'))
  await client.run({ messages: [{ role: 'system', content: RULE }, ...history(12), { role: 'user', content: 'Status   of 4711?' }], tools, temperature: 0.5 })
  const body = mock.state.requests[0].body
  expect(body.tools).toHaveLength(15)
  expect(body.max_tokens).toBe(1024)
  expect(body.messages.filter(m => m.role === 'user')).toHaveLength(10)
  expect(body.messages.at(-1).content).toBe('Status of 4711?')
  expect(events[0].savings.cacheHit).toBe(false)
})

test('a fallback list config keeps its tools and params', async () => {
  const { opt, events } = setup()
  const list = [agentClient().config, { promptTemplating: { model: { name: 'gpt-4.1-mini' }, prompt: { tools } } }]
  await opt.wrap(new OrchestrationClient(list)).chatCompletion(ask)
  const modules = mock.state.requests[0].body.config.modules
  expect(modules[0].prompt_templating.prompt.tools).toHaveLength(32)
  expect(events[0].savings.notes).toContain("tools: skipped, the client's tools are fixed")
  expect(mock.state.requests[0].body.messages_history.filter(m => m.role === 'user')).toHaveLength(9)
})

test('optimizer.chat() goes through the pipeline', async () => {
  const { opt } = setup()
  await opt.chat({ model: 'gpt-4.1', messages: [...history(12), { role: 'user', content: 'Now?' }], tools, temperature: 0 })
  const pt = mock.state.requests[0].body.config.modules.prompt_templating
  expect(pt.prompt.tools).toHaveLength(15)
  expect(pt.model.params.max_tokens).toBe(1024)
})

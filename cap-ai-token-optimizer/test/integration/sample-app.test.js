'use strict'
/**
 * cds.test() on ../sample-cap-agent against the mock AI Core server.
 * The sample loads this package through its `file:` dependency, as a real app would.
 */
const path = require('node:path')
const fs = require('node:fs')
const { createMockAiCore } = require('../mock-aicore/server')

const SAMPLE = path.resolve(__dirname, '../../../sample-cap-agent')
const installed = fs.existsSync(path.join(SAMPLE, 'node_modules/@sap/cds'))
const describeIf = installed ? describe : describe.skip
if (!installed) console.warn(`Skipping sample app tests: run "npm install" in ${SAMPLE}`)

describeIf('sample-cap-agent', () => {
  const mock = createMockAiCore()
  beforeAll(async () => {
    await mock.start()
    process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  })
  afterAll(async () => {
    await mock.stop()
    delete process.env.AICORE_SERVICE_KEY
  })

  // use the sample's own @sap/cds, as `cds watch` in that folder would
  const cds = installed ? require(require.resolve('@sap/cds', { paths: [SAMPLE] })) : null
  const { GET, POST } = installed ? cds.test(SAMPLE) : {}
  const { optimizer } = require('../../index')
  const alice = { auth: { username: 'alice', password: '' } }

  let events
  const listener = (e) => events.push(e)
  const configure = (over = {}) => optimizer.configure({ ...cds.env.requires.tokenOptimizer, metrics: { exporters: [] }, ...over })

  beforeAll(() => optimizer.on('call', listener))
  afterAll(() => optimizer.off('call', listener))
  beforeEach(() => {
    events = []
    mock.reset()
    configure()
  })

  test('the CAP plugin configured the optimizer from cds.requires.tokenOptimizer', () => {
    expect(optimizer.config.useCases.agent.steps.tools.maxTools).toBe(10)
  })

  test('ask: answers and emits a metrics event with the right values', async () => {
    const { data } = await POST('/odata/v4/agent/ask', { question: 'What is SAP CAP?' }, alice)
    expect(data.value).toMatch(/Mock answer .*What is SAP CAP\?/)
    expect(mock.state.requests).toHaveLength(1)
    const sent = mock.state.requests[0].body.config.modules.prompt_templating
    expect(sent.model.params).toEqual({ temperature: 0, max_tokens: 256 })

    expect(events).toHaveLength(1)
    const e = events[0]
    const usage = mock.state.requests.length && e.tokens
    expect(e).toMatchObject({
      useCase: 'ask', cdsService: 'AgentService', mode: 'active', model: 'gpt-4.1', sdk: 'orchestration',
      status: 'success', error: null, requestId: 'req-1', savings: { cacheHit: false }
    })
    expect(e.user).toMatch(/^[0-9a-f]{16}$/)
    expect(usage.prompt).toBeGreaterThan(0)
    expect(usage.total).toBe(usage.prompt + usage.completion)
    expect(JSON.stringify(e)).not.toContain('What is SAP CAP')
  })

  test('ask: a cache hit skips the HTTP call', async () => {
    await POST('/odata/v4/agent/ask', { question: 'Cache me' }, alice)
    const { data } = await POST('/odata/v4/agent/ask', { question: 'Cache me' }, alice)
    expect(data.value).toMatch(/Cache me/)
    expect(mock.state.requests).toHaveLength(1)
    expect(events.map(e => e.savings.cacheHit)).toEqual([false, true])
    expect(events[1].tokens.total).toBe(0)
  })

  test('runAgent active: tools and history are reduced', async () => {
    const { data } = await POST('/odata/v4/agent/runAgent', { question: 'What is the status of sales order 4711?' }, alice)
    expect(data.value).toMatch(/Mock answer/)
    const body = mock.state.requests[0].body
    const tools = body.config.modules.prompt_templating.prompt.tools
    expect(tools).toHaveLength(10)
    expect(tools.map(t => t.function.name)).toEqual(expect.arrayContaining(['get_sales_order', 'get_sales_order_status', 'get_material_stock']))
    const e = events[0]
    expect(e.useCase).toBe('agent')
    expect(e.savings.byStep.tools).toBeGreaterThan(0)
    expect(e.savings.byStep.normalize).toBeGreaterThan(0)
    expect(e.savings.byStep.dedupe).toBeGreaterThan(0)
    expect(e.tokens.promptEstimatedAfter).toBeLessThan(e.tokens.promptEstimatedBefore)
  })

  test('runAgent shadow: the original prompt is sent', async () => {
    configure({ mode: 'shadow' })
    await POST('/odata/v4/agent/runAgent', { question: 'Status of 4711?' }, alice)
    configure({ mode: 'off' })
    await POST('/odata/v4/agent/runAgent', { question: 'Status of 4711?' }, alice)

    const [shadowBody, offBody] = mock.state.requests.map(r => r.body)
    expect(shadowBody).toEqual(offBody)
    expect(shadowBody.config.modules.prompt_templating.prompt.tools).toHaveLength(32)
    expect(events[0]).toMatchObject({ mode: 'shadow' })
    expect(events[0].savings.estimatedTokens).toBeGreaterThan(0)
    expect(events[1]).toMatchObject({ mode: 'off', savings: { estimatedTokens: 0 } })
  })

  test.each([
    ['rate_limit', 'RATE_LIMIT', 429],
    ['content_filter', 'CONTENT_FILTER', 422],
    ['context_length', 'CONTEXT_LENGTH', 413],
    ['server_error', 'SERVER', 502]
  ])('errors: %s is classified as %s', async (scenario, category, status) => {
    const err = await POST('/odata/v4/agent/ask', { question: `Hi [[mock:${scenario}]]` }, alice).catch(e => e)
    expect(err.status ?? err.response?.status).toBe(status)
    expect(events[0]).toMatchObject({ status: 'error', error: { category } })
  })

  test('stats() aggregates the calls', async () => {
    optimizer.resetStats()
    await POST('/odata/v4/agent/ask', { question: 'one' }, alice)
    await POST('/odata/v4/agent/ask', { question: 'one' }, alice)
    expect(optimizer.stats()).toMatchObject({ calls: 2, success: 2, cacheHits: 1, byUseCase: { ask: { calls: 2 } } })
  })

  describe('admin service', () => {
    const ops = { auth: { username: 'ops', password: '' } }

    test('is served with read-only stats for the admin role', async () => {
      optimizer.resetStats()
      await POST('/odata/v4/agent/ask', { question: 'stats please' }, alice)
      await POST('/odata/v4/agent/ask', { question: 'oops [[mock:server_error]]' }, alice).catch(() => {})

      const { data: summary } = await GET('/odata/v4/token-optimizer/summary()', ops)
      expect(summary).toMatchObject({ calls: 2, success: 1, errors: 1, mode: 'active', tokens: { prompt: expect.any(Number) } })

      const { data: useCases } = await GET('/odata/v4/token-optimizer/UseCases', ops)
      expect(useCases.value).toEqual([expect.objectContaining({ name: 'ask', calls: 2 })])
      const { data: one } = await GET("/odata/v4/token-optimizer/Models('gpt-4.1')", ops)
      expect(one).toMatchObject({ name: 'gpt-4.1', calls: 2 })
      const { data: errors } = await GET('/odata/v4/token-optimizer/ErrorCategories', ops)
      expect(errors.value).toEqual([{ category: 'SERVER', count: 1 }])
      const { data: steps } = await GET('/odata/v4/token-optimizer/StepSavings', ops)
      expect(steps.value.map(r => r.step)).toEqual(expect.arrayContaining(['normalize', 'outputCap']))
      const { data: exporters } = await GET('/odata/v4/token-optimizer/Exporters', ops)
      expect(exporters.value).toEqual([])
    })

    test('lists exporters with their stats', async () => {
      configure({ metrics: { exporters: [{ name: 'custom', export () {}, stats: () => ({ sent: 3 }) }] } })
      const { data } = await GET('/odata/v4/token-optimizer/Exporters', ops)
      expect(data.value).toEqual([{ name: 'custom', errors: 0, stats: '{"sent":3}' }])
    })

    test('UsageLog and PromptPrefixChanges', async () => {
      configure({ metrics: { exporters: ['db'] } })
      await POST('/odata/v4/agent/ask', { question: 'log me' }, alice)
      await POST('/odata/v4/agent/ask', { question: 'boom [[mock:rate_limit]]' }, alice).catch(() => {})
      await optimizer.flush()
      const { data } = await GET("/odata/v4/token-optimizer/UsageLog?$filter=useCase eq 'ask'&$orderby=timestamp desc&$top=2", ops)
      expect(data.value.map(r => r.status).sort()).toEqual(['error', 'success'])
      const err = data.value.find(r => r.status === 'error')
      expect(err).toMatchObject({ errorCategory: 'RATE_LIMIT', errorHttpStatus: 429, cdsService: 'AgentService', model: 'gpt-4.1' })
      expect(JSON.stringify(data.value)).not.toContain('log me')

      const { data: changes } = await GET('/odata/v4/token-optimizer/PromptPrefixChanges', ops)
      expect(Array.isArray(changes.value)).toBe(true)
    })

    test('requires the role and is read-only', async () => {
      const denied = await GET('/odata/v4/token-optimizer/summary()', alice).catch(e => e)
      expect(denied.status ?? denied.response?.status).toBe(403)
      const write = await POST('/odata/v4/token-optimizer/UseCases', { name: 'x' }, ops).catch(e => e)
      expect(write.status ?? write.response?.status).toBeGreaterThanOrEqual(400)
      const logWrite = await POST('/odata/v4/token-optimizer/UsageLog', { status: 'x' }, ops).catch(e => e)
      expect(logWrite.status ?? logWrite.response?.status).toBeGreaterThanOrEqual(400)
    })
  })
})

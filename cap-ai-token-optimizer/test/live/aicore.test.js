'use strict'
/**
 * Live tests against a real SAP AI Core instance. Opt-in, never run by default:
 *
 *   RUN_LIVE_TESTS=1 AICORE_SERVICE_KEY='{...}' npm run test:live
 *   # or in a CAP project with a binding:  cds bind --exec -- npm run test:live
 *
 * Env:
 *   LIVE_TEST_MODELS     comma-separated orchestration models (default: gpt-4.1)
 *   LIVE_TEST_FM_MODELS  comma-separated foundation-models deployments to test (default: none)
 *   AICORE_RESOURCE_GROUP  resource group (default: the SDK default)
 *
 * One tiny prompt per model, hard cap max_tokens 50.
 */
const { TokenOptimizer } = require('../../lib/optimizer')
const log = require('../../lib/util/log')

const MAX_TOKENS = 50
const enabled = process.env.RUN_LIVE_TESTS === '1'
const hasBinding = !!process.env.AICORE_SERVICE_KEY || /"aicore"/.test(process.env.VCAP_SERVICES ?? '')
const list = (v, d) => (v ?? d).split(',').map(s => s.trim()).filter(Boolean)
const MODELS = list(process.env.LIVE_TEST_MODELS, 'gpt-4.1')
const FM_MODELS = list(process.env.LIVE_TEST_FM_MODELS, '')
const resourceGroup = process.env.AICORE_RESOURCE_GROUP || undefined

if (enabled && !hasBinding) console.warn('RUN_LIVE_TESTS=1 but no AI Core binding (AICORE_SERVICE_KEY / VCAP_SERVICES): live tests skipped')
const describeLive = enabled && hasBinding ? describe : describe.skip

jest.setTimeout(60000)

describeLive('live SAP AI Core', () => {
  let opt, events
  beforeAll(() => log._set({ debug () {}, info () {}, warn: console.warn, error: console.error }))
  afterAll(() => log._set(undefined))
  beforeEach(() => {
    opt = new TokenOptimizer({ metrics: { exporters: [] } })
    events = []
    opt.on('call', e => events.push(e))
  })
  afterEach(() => opt.shutdown())

  const tiny = [{ role: 'user', content: 'Reply with the single word OK.' }]

  describe.each(MODELS)('orchestration %s', (model) => {
    test('measures a real call', async () => {
      const r = await opt.chat({ useCase: 'live', model, messages: tiny, maxTokens: MAX_TOKENS, temperature: 0, resourceGroup })
      expect(r.usage.prompt_tokens).toBeGreaterThan(0)
      expect(r.usage.completion_tokens).toBeLessThanOrEqual(MAX_TOKENS)
      const e = events[0]
      expect(e).toMatchObject({ status: 'success', sdk: 'orchestration', model, tokens: { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens } })
      expect(e.requestId).toEqual(expect.any(String))
      // the pre-call estimate should be in the right range
      expect(e.tokens.promptEstimatedBefore).toBeGreaterThan(0)
      expect(e.tokens.promptEstimatedBefore).toBeLessThan(r.usage.prompt_tokens * 3 + 20)
    })

    test('the second identical call is served from the cache', async () => {
      const a = await opt.chat({ model, messages: tiny, maxTokens: MAX_TOKENS, temperature: 0, resourceGroup })
      const b = await opt.chat({ model, messages: tiny, maxTokens: MAX_TOKENS, temperature: 0, resourceGroup })
      expect(b.content).toBe(a.content)
      expect(events.map(e => e.savings.cacheHit)).toEqual([false, true])
    })
  })

  describe.each(FM_MODELS.length ? FM_MODELS : [null])('foundation models %s', (model) => {
    const run = model ? test : test.skip
    run('measures a real call', async () => {
      const r = await opt.chat({ sdk: 'foundation-models', model, messages: tiny, maxTokens: MAX_TOKENS, temperature: 0, resourceGroup })
      expect(r.usage.prompt_tokens).toBeGreaterThan(0)
      expect(events[0]).toMatchObject({ status: 'success', sdk: 'foundation-models' })
    })
  })

  test('a failing call is classified, not UNKNOWN', async () => {
    await expect(opt.chat({ model: MODELS[0], messages: tiny, maxTokens: MAX_TOKENS, resourceGroup: 'cap-ai-token-optimizer-no-such-group' })).rejects.toThrow()
    expect(events[0].status).toBe('error')
    expect(events[0].error.category).not.toBe('UNKNOWN')
  })
})

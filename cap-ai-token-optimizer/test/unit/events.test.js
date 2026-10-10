'use strict'
const { buildEvent, estimateCost, usageToTokens, cdsContextInfo, SCHEMA_VERSION } = require('../../lib/metrics/events')

describe('events', () => {
  afterEach(() => { delete globalThis.cds })

  test('buildEvent fills a stable shape with defaults', () => {
    const e = buildEvent({})
    expect(e).toMatchObject({
      schemaVersion: SCHEMA_VERSION, tenant: null, user: null, useCase: 'default', mode: 'active',
      tokens: { promptEstimatedBefore: null, prompt: null, cached: null },
      savings: { estimatedTokens: 0, byStep: {}, cacheHit: false },
      retries: 0, status: 'success', error: null
    })
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(e.timestamp)).not.toBeNaN()
    expect(e).not.toHaveProperty('content')
  })

  test('buildEvent hashes the user and keeps the error compact', () => {
    const e = buildEvent({ userId: 'alice', status: 'error', error: { category: 'TIMEOUT', message: 'x', retryAfterMs: 5 }, content: { messages: [] } }, { userHashSalt: 's' })
    expect(e.user).toHaveLength(16)
    expect(e.error).toEqual({ category: 'TIMEOUT', httpStatus: null, code: null, message: 'x' })
    expect(e.content).toEqual({ messages: [] })
  })

  test('estimateCost uses per-1k prices, cached rate and prefix-stripped names', () => {
    const pricing = { 'gpt-4.1': { inputPer1k: 2, outputPer1k: 8, cachedInputPer1k: 0.5 } }
    expect(estimateCost('gpt-4.1', { prompt: 1000, completion: 500, cached: 0 }, pricing)).toBe(6)
    expect(estimateCost('gpt-4.1', { prompt: 1000, completion: 0, cached: 400 }, pricing)).toBe(1.4)
    expect(estimateCost('azure-openai--gpt-4.1', { prompt: 1000, completion: 0, cached: 0 }, pricing)).toBe(2)
    expect(estimateCost('gpt-4.1', { prompt: 1000, completion: 0, cached: 5000 }, { 'gpt-4.1': { inputPer1k: 1 } })).toBe(1)
    expect(estimateCost('unknown', { prompt: 1, completion: 1 }, pricing)).toBeNull()
    expect(estimateCost(null, { prompt: 1 }, pricing)).toBeNull()
    expect(estimateCost('gpt-4.1', { prompt: null }, pricing)).toBeNull()
  })

  test('usageToTokens normalizes SDK usage', () => {
    expect(usageToTokens({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } }))
      .toEqual({ prompt: 10, completion: 5, total: 15, cached: 4 })
    expect(usageToTokens({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({ prompt: 10, completion: 5, total: 15, cached: 0 })
    expect(usageToTokens(undefined)).toEqual({ prompt: null, completion: null, total: null, cached: null })
    expect(usageToTokens({ prompt_tokens: 'x' }).prompt).toBeNull()
  })

  test('cdsContextInfo reads cds.context', () => {
    expect(cdsContextInfo()).toEqual({ tenant: null, userId: null, cdsService: null })
    globalThis.cds = { context: { tenant: 't1', user: { id: 'bob' }, http: { req: { baseUrl: '/odata/v4/agent' } } } }
    expect(cdsContextInfo()).toEqual({ tenant: 't1', userId: 'bob', cdsService: '/odata/v4/agent' })
    globalThis.cds = { context: { user: { id: 'anonymous', _is_anonymous: true } } }
    expect(cdsContextInfo()).toEqual({ tenant: null, userId: null, cdsService: null })
    globalThis.cds = { context: {} }
    expect(cdsContextInfo().userId).toBeNull()
  })

  test('cdsContextInfo never throws', () => {
    globalThis.cds = {}
    Object.defineProperty(globalThis.cds, 'context', { get () { throw new Error('boom') } })
    expect(cdsContextInfo()).toEqual({ tenant: null, userId: null, cdsService: null })
  })
})

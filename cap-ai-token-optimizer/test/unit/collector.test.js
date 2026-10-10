'use strict'
const { MetricsCollector } = require('../../lib/metrics/collector')
const log = require('../../lib/util/log')

const quiet = { debug () {}, info () {}, warn: jest.fn(), error () {} }
beforeAll(() => log._set(quiet))
afterAll(() => log._set(undefined))

const event = (over = {}) => ({
  useCase: 'u1',
  model: 'gpt-4.1',
  status: 'success',
  tokens: { prompt: 10, completion: 5, total: 15, cached: 2 },
  savings: { estimatedTokens: 3, byStep: { normalize: 2, dedupe: 1 }, cacheHit: false },
  costEstimate: 0.1,
  latencyMs: 100,
  ...over
})

describe('MetricsCollector', () => {
  test('aggregates totals, per use case and per model', () => {
    const c = new MetricsCollector()
    c.record(event())
    c.record(event({ useCase: undefined, model: undefined, status: 'error', error: { category: 'RATE_LIMIT' }, tokens: {}, savings: { cacheHit: true }, costEstimate: 0.2, latencyMs: 300 }))
    c.record(event({ status: 'error', error: undefined, savings: undefined, latencyMs: undefined }))
    const s = c.stats()
    expect(s).toMatchObject({ calls: 3, success: 1, errors: 2, cacheHits: 1, savedTokensEstimate: 3, costEstimate: 0.4 })
    expect(s.tokens).toEqual({ prompt: 20, completion: 10, total: 30, cached: 4 })
    expect(s.errorsByCategory).toEqual({ RATE_LIMIT: 1, UNKNOWN: 1 })
    expect(s.savingsByStep).toEqual({ normalize: 2, dedupe: 1 })
    expect(s.byUseCase.u1.calls).toBe(2)
    expect(s.byUseCase.default.calls).toBe(1)
    expect(s.byModel.unknown.errors).toBe(1)
    expect(s.latencyMs).toEqual({ count: 2, avg: 200, p50: 100, p95: 300, max: 300 })
  })

  test('stats() returns a copy and reset() clears', () => {
    const c = new MetricsCollector()
    c.record(event())
    c.stats().tokens.prompt = 999
    expect(c.stats().tokens.prompt).toBe(10)
    c.reset()
    expect(c.stats()).toMatchObject({ calls: 0, latencyMs: { count: 0, avg: null } })
  })

  test('keeps a bounded latency sample', () => {
    const c = new MetricsCollector()
    for (let i = 0; i < 1100; i++) c.record(event({ latencyMs: i }))
    expect(c.stats().latencyMs.count).toBe(1000)
    expect(c.stats().latencyMs.max).toBe(1099)
  })

  test('emits call events; failing listeners are counted, not thrown', async () => {
    const c = new MetricsCollector()
    const seen = []
    c.on('call', e => seen.push(e))
    c.on('call', () => { throw new Error('sync boom') })
    c.on('call', async () => { throw new Error('async boom') })
    expect(() => c.record(event())).not.toThrow()
    await new Promise(setImmediate)
    expect(seen).toHaveLength(1)
    expect(c.stats().listenerErrors).toBe(2)
  })

  test('notify() emits other event types safely', () => {
    const c = new MetricsCollector()
    const fn = jest.fn()
    c.on('warning', fn)
    c.on('warning', () => { throw new Error('x') })
    c.notify('warning', { a: 1 })
    expect(fn).toHaveBeenCalledWith({ a: 1 })
  })

  test('fans out to exporters; failures are counted per exporter', async () => {
    const c = new MetricsCollector()
    const good = { name: 'good', export: jest.fn() }
    c.addExporter(good)
    c.addExporter({ name: 'sync', export () { throw new Error('x') } })
    c.addExporter({ export: () => Promise.reject(new Error('y')) })
    c.record(event())
    await new Promise(setImmediate)
    expect(good.export).toHaveBeenCalledTimes(1)
    expect(c.stats().exporterErrors).toEqual({ sync: 1, anonymous: 1 })
  })

  test('addExporter validates the exporter', () => {
    expect(() => new MetricsCollector().addExporter({})).toThrow(TypeError)
  })

  test('aggregation failures do not stop export', () => {
    const c = new MetricsCollector()
    const x = { export: jest.fn() }
    c.addExporter(x)
    c.record(null)
    expect(x.export).toHaveBeenCalledWith(null)
  })

  test('flush and shutdown call exporters and never reject', async () => {
    const c = new MetricsCollector()
    const a = { name: 'a', export () {}, flush: jest.fn(), shutdown: jest.fn() }
    const b = { name: 'b', export () {}, flush: () => Promise.reject(new Error('f')), shutdown () { throw new Error('s') } }
    c.addExporter(a)
    c.addExporter(b)
    await expect(c.flush()).resolves.toBeUndefined()
    await expect(c.shutdown()).resolves.toBeUndefined()
    expect(a.flush).toHaveBeenCalledTimes(2)
    expect(a.shutdown).toHaveBeenCalledTimes(1)
    expect(c.stats().exporterErrors.b).toBe(3)
  })

  test('start() flushes on an interval; stop() ends it', () => {
    jest.useFakeTimers()
    try {
      const c = new MetricsCollector()
      const x = { export () {}, flush: jest.fn() }
      c.addExporter(x)
      c.start(0)
      expect(c._timer).toBeNull()
      c.start(1000)
      c.start(1000)
      jest.advanceTimersByTime(3000)
      expect(x.flush).toHaveBeenCalledTimes(3)
      c.stop()
      jest.advanceTimersByTime(3000)
      expect(x.flush).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })

  test('includes exporter stats', () => {
    const c = new MetricsCollector()
    c.addExporter({ name: 'http', export () {}, stats: () => ({ queued: 2 }) })
    c.addExporter({ export () {}, stats () { throw new Error('x') } })
    c.addExporter({ name: 'plain', export () {} })
    expect(c.stats().exporters).toEqual({ http: { queued: 2 } })
  })
})

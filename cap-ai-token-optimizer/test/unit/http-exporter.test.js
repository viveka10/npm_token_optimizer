'use strict'
const { createHttpExporter } = require('../../lib/exporters/http')
const log = require('../../lib/util/log')

const warn = jest.fn()
beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
afterAll(() => log._set(undefined))
beforeEach(() => warn.mockClear())

const response = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers) })

function setup (cfg = {}, responses = []) {
  const calls = []
  const fetch = jest.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const r = responses.shift() ?? response(200)
    if (r instanceof Error) throw r
    return r
  })
  const sleep = jest.fn(async () => {})
  const x = createHttpExporter({ url: 'https://metrics.example.com/events', ...cfg }, { fetch, sleep, ...cfg.deps })
  return { x, fetch, calls, sleep }
}
const ev = (i) => ({ id: String(i) })

describe('http exporter', () => {
  test('needs a url or destination', () => {
    expect(() => createHttpExporter({})).toThrow(/url.*destination/)
  })

  test('batches events and posts JSON with configured headers', async () => {
    const { x, calls } = setup({ headers: { 'x-api-key': 'k' }, batchSize: 2 })
    x.export(ev(1))
    expect(calls).toHaveLength(0)
    x.export(ev(2))
    await x.flush()
    x.export(ev(3))
    await x.flush()
    expect(calls.map(c => c.body.events.map(e => e.id))).toEqual([['1', '2'], ['3']])
    expect(calls[0].url).toBe('https://metrics.example.com/events')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'k' })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    expect(x.stats()).toEqual({ queued: 0, sent: 3, dropped: 0, failedAttempts: 0, rejectedBatches: 0 })
  })

  test('flush with an empty queue sends nothing; concurrent flushes share one run', async () => {
    const { x, fetch } = setup()
    await x.flush()
    expect(fetch).not.toHaveBeenCalled()
    x.export(ev(1))
    const [a, b] = [x.flush(), x.flush()]
    expect(a).toBe(b)
    await a
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test('retries 5xx, 429 (Retry-After) and network errors with backoff', async () => {
    const { x, calls, sleep } = setup({}, [response(503), response(429, { 'retry-after': '2' }), new Error('ECONNRESET'), response(200)])
    x.export(ev(1))
    await x.flush()
    expect(calls).toHaveLength(4)
    expect(sleep.mock.calls[1][0]).toBe(2000)
    expect(x.stats()).toMatchObject({ sent: 1, failedAttempts: 3, queued: 0 })
  })

  test('keeps the batch when all retries fail, sends it on the next flush', async () => {
    const { x, calls } = setup({ maxRetries: 1 }, [response(500), response(500)])
    x.export(ev(1))
    await x.flush()
    expect(x.stats()).toMatchObject({ queued: 1, sent: 0 })
    expect(warn).not.toHaveBeenCalled()
    await x.flush()
    expect(calls).toHaveLength(3)
    expect(x.stats()).toMatchObject({ queued: 0, sent: 1 })
  })

  test('network failures are logged once retries are exhausted', async () => {
    const { x } = setup({ maxRetries: 0 }, [new Error('down')])
    x.export(ev(1))
    await x.flush()
    expect(warn).toHaveBeenCalledWith('http exporter: could not send events:', 'down')
  })

  test('drops batches rejected with other 4xx', async () => {
    const { x, calls } = setup({}, [response(400)])
    x.export(ev(1))
    await x.flush()
    expect(calls).toHaveLength(1)
    expect(x.stats()).toMatchObject({ queued: 0, sent: 0, dropped: 1, rejectedBatches: 1 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'))
  })

  test('caps the queue and drops the oldest events', async () => {
    const { x, calls } = setup({ maxQueueSize: 3, batchSize: 100 })
    for (let i = 1; i <= 5; i++) x.export(ev(i))
    expect(x.stats()).toMatchObject({ queued: 3, dropped: 2 })
    await x.flush()
    expect(calls[0].body.events.map(e => e.id)).toEqual(['3', '4', '5'])
  })

  test('shutdown flushes and then ignores new events', async () => {
    const { x, calls } = setup()
    x.export(ev(1))
    await x.shutdown()
    x.export(ev(2))
    await x.flush()
    expect(calls).toHaveLength(1)
  })

  describe('destination', () => {
    function connectivity (dest = { url: 'https://dest.example.com/ingest' }) {
      return {
        getDestination: jest.fn(async () => dest),
        buildHeadersForDestination: jest.fn(async () => ({ authorization: 'Bearer t' }))
      }
    }

    test('resolves the destination, adds its auth headers and caches it', async () => {
      const c = connectivity()
      let now = 0
      const { x, calls } = setup({ url: '', destination: 'METRICS', destinationCacheMs: 1000, deps: { connectivity: c, now: () => now } })
      x.export(ev(1))
      await x.flush()
      x.export(ev(2))
      await x.flush()
      expect(c.getDestination).toHaveBeenCalledTimes(1)
      expect(c.getDestination).toHaveBeenCalledWith({ destinationName: 'METRICS', useCache: true })
      expect(calls[0].url).toBe('https://dest.example.com/ingest')
      expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer t' })
      now = 2000
      x.export(ev(3))
      await x.flush()
      expect(c.getDestination).toHaveBeenCalledTimes(2)
    })

    test('re-resolves after 401', async () => {
      const c = connectivity()
      const { x, calls } = setup({ url: '', destination: 'METRICS', deps: { connectivity: c } }, [response(401), response(200)])
      x.export(ev(1))
      await x.flush()
      expect(calls).toHaveLength(2)
      expect(c.getDestination).toHaveBeenCalledTimes(2)
    })

    test('a missing destination keeps the events queued', async () => {
      const { x } = setup({ url: '', destination: 'NOPE', maxRetries: 0, deps: { connectivity: connectivity(null) } })
      x.export(ev(1))
      await x.flush()
      expect(x.stats().queued).toBe(1)
      expect(warn).toHaveBeenCalledWith('http exporter: could not send events:', 'destination "NOPE" not found or has no URL')
    })

    test('uses @sap-cloud-sdk/connectivity when no client is injected', async () => {
      process.env.destinations = JSON.stringify([{ name: 'LOCAL_METRICS', url: 'https://local.example.com/events' }])
      try {
        const { x, calls } = setup({ url: '', destination: 'LOCAL_METRICS' })
        x.export(ev(1))
        await x.flush()
        expect(calls[0].url).toBe('https://local.example.com/events')
      } finally {
        delete process.env.destinations
      }
    })
  })
})

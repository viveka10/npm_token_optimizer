'use strict'
const { createDbExporter, toRow, ENTITY } = require('../../lib/exporters/db')
const log = require('../../lib/util/log')

const warn = jest.fn()
beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
afterAll(() => log._set(undefined))
beforeEach(() => warn.mockClear())

/** Minimal stand-in for cds: records tx contexts and queries. */
function fakeCds ({ fail = 0, model = true, connectError = null } = {}) {
  const runs = []
  const contexts = []
  let failures = fail
  const db = {
    model: { definitions: model ? { [ENTITY]: {} } : {} },
    async tx (ctx, fn) {
      contexts.push(ctx)
      return fn({
        run: async (q) => {
          if (q.insert && failures > 0) { failures--; throw new Error('db down') }
          runs.push(q)
          return q.delete ? 2 : undefined
        }
      })
    }
  }
  class Privileged { constructor () { this.privileged = true } }
  return {
    runs,
    contexts,
    cds: {
      connect: { to: async () => { if (connectError) throw new Error(connectError); return db } },
      User: { Privileged },
      ql: {
        INSERT: { into: (e) => ({ entries: (rows) => ({ insert: e, rows }) }) },
        DELETE: { from: (e) => ({ where: (w) => ({ delete: e, where: w }) }) }
      }
    }
  }
}

const event = (over = {}) => ({
  id: 'e1', timestamp: '2026-10-10T10:00:00.000Z', tenant: 't1', user: 'abcd', cdsService: 'AgentService', useCase: 'ask', mode: 'active',
  model: 'gpt-4.1', deploymentId: 'd1', resourceGroup: 'default', sdk: 'orchestration', operation: 'chat', requestId: 'r1', finishReason: 'stop',
  tokens: { promptEstimatedBefore: 30, promptEstimatedAfter: 20, prompt: 18, completion: 5, total: 23, cached: 0 },
  savings: { estimatedTokens: 10, byStep: { normalize: 10 }, cacheHit: false },
  costEstimate: 0.0001, latencyMs: 120.4, retries: 0, status: 'success', error: null, promptHash: 'h', promptLength: 99,
  advisory: { promptPrefixChanged: true },
  content: { messages: [{ role: 'user', content: 'secret' }] },
  ...over
})

describe('db exporter', () => {
  test('maps events to rows without content', () => {
    const row = toRow(event())
    expect(row).toMatchObject({ ID: 'e1', tenant: 't1', userHash: 'abcd', promptTokens: 18, totalTokens: 23, savedTokensEstimate: 10, savingsByStep: '{"normalize":10}', cacheHit: false, promptPrefixChanged: true, latencyMs: 120, status: 'success', errorCategory: null })
    expect(JSON.stringify(row)).not.toContain('secret')
    const err = toRow(event({ status: 'error', error: { category: 'TIMEOUT', httpStatus: null, code: 'ECONNABORTED', message: 'x'.repeat(500) }, tokens: {}, savings: undefined, advisory: null, retries: undefined }))
    expect(err).toMatchObject({ errorCategory: 'TIMEOUT', errorHttpStatus: null, errorCode: 'ECONNABORTED', promptTokens: null, retries: 0, savingsByStep: '{}', promptPrefixChanged: false })
    expect(err.errorMessage).toHaveLength(300)
  })

  test('writes batches per tenant with a privileged user', async () => {
    const f = fakeCds()
    const x = createDbExporter({ batchSize: 3, retentionDays: 0 }, { cds: f.cds })
    x.export(event({ id: '1', tenant: 't1' }))
    x.export(event({ id: '2', tenant: 't2' }))
    expect(f.runs).toHaveLength(0)
    x.export(event({ id: '3', tenant: 't1' }))
    await x.flush()
    expect(f.contexts.map(c => c.tenant)).toEqual(['t1', 't2'])
    expect(f.contexts[0].user.privileged).toBe(true)
    expect(f.runs.map(q => q.rows.map(r => r.ID))).toEqual([['1', '3'], ['2']])
    expect(f.runs[0].insert).toBe(ENTITY)
    expect(x.stats()).toEqual({ queued: 0, written: 3, dropped: 0, failedWrites: 0, deleted: 0 })
  })

  test('single-tenant apps write without a tenant', async () => {
    const f = fakeCds()
    const x = createDbExporter({ retentionDays: 0 }, { cds: f.cds })
    x.export(event({ tenant: null }))
    await x.shutdown()
    expect(f.contexts[0].tenant).toBeUndefined()
  })

  test('deletes rows older than retentionDays at most once a day per tenant', async () => {
    const f = fakeCds()
    let now = Date.parse('2026-10-10T00:00:00Z')
    const x = createDbExporter({ retentionDays: 30 }, { cds: f.cds, now: () => now })
    x.export(event())
    await x.flush()
    x.export(event())
    await x.flush()
    const deletes = () => f.runs.filter(q => q.delete)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].where).toEqual({ timestamp: { '<': '2026-09-10T00:00:00.000Z' } })
    now += 25 * 60 * 60 * 1000
    x.export(event())
    await x.flush()
    expect(deletes()).toHaveLength(2)
    expect(x.stats().deleted).toBe(4)
  })

  test('failed writes stay queued and are retried on the next flush', async () => {
    const f = fakeCds({ fail: 1 })
    const x = createDbExporter({ retentionDays: 0 }, { cds: f.cds })
    x.export(event())
    await x.flush()
    expect(x.stats()).toMatchObject({ queued: 1, written: 0, failedWrites: 1 })
    expect(warn).toHaveBeenCalledWith('db exporter: could not write 1 row(s):', 'db down')
    await x.flush()
    expect(x.stats()).toMatchObject({ queued: 0, written: 1 })
  })

  test('caps the queue', () => {
    const x = createDbExporter({ maxQueueSize: 2, batchSize: 100 }, { cds: fakeCds().cds })
    for (let i = 0; i < 5; i++) x.export(event({ id: String(i) }))
    expect(x.stats()).toMatchObject({ queued: 2, dropped: 3 })
  })

  test('disables itself when there is no database or entity', async () => {
    for (const [opts, message] of [[{ connectError: 'No service definition found for db' }, 'No service definition found for db'], [{ model: false }, expect.stringContaining('not in the model')]]) {
      warn.mockClear()
      const x = createDbExporter({}, { cds: fakeCds(opts).cds })
      x.export(event())
      await x.flush()
      x.export(event())
      expect(warn).toHaveBeenCalledWith('db exporter disabled:', message)
      expect(x.stats()).toMatchObject({ queued: 0, dropped: 2 })
    }
  })

  test('without CAP loaded', async () => {
    const x = createDbExporter()
    x.export(event())
    await x.flush()
    expect(warn).toHaveBeenCalledWith('db exporter disabled:', '@sap/cds is not loaded')
    await x.flush()
  })

  test('is available as "db" and "hana"', () => {
    const { createExporters } = require('../../lib/exporters')
    expect(createExporters({ metrics: { exporters: ['db', 'hana'] } }).map(x => x.name)).toEqual(['db', 'db'])
  })
})

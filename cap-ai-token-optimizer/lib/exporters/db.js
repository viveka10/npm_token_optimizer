'use strict'
/**
 * Database exporter (`db`, alias `hana`): writes one TokenUsageLog row per call through
 * CAP's database service, so it works with SAP HANA, SQLite and PostgreSQL.
 *
 * - Rows are buffered and inserted in batches on the flush interval, when a batch is full,
 *   and on shutdown. Each tenant's rows go to that tenant's container (cds.tx with the tenant).
 * - The queue is capped; when full, the oldest rows are dropped and counted. Failed inserts
 *   are kept for the next flush (up to the cap).
 * - Rows older than `retentionDays` are deleted at most once a day per tenant (0 keeps all).
 * - Only metrics are stored, never prompt or completion text (even with captureContent).
 *
 * Never throws into the caller.
 */
const log = require('../util/log')
const { getCds } = require('../util/cds')

const ENTITY = 'cap.ai.token_optimizer.TokenUsageLog'
const DAY = 24 * 60 * 60 * 1000
const DEFAULTS = { batchSize: 50, maxQueueSize: 10000, retentionDays: 30 }

const int = (v) => (Number.isFinite(v) ? Math.round(v) : null)
const str = (v, max) => (v == null ? null : String(v).slice(0, max))

/** Map a call event to a TokenUsageLog row. */
function toRow (e) {
  return {
    ID: e.id,
    timestamp: e.timestamp,
    tenant: str(e.tenant, 255),
    userHash: e.user ?? null,
    cdsService: str(e.cdsService, 255),
    useCase: str(e.useCase, 255),
    mode: e.mode,
    model: str(e.model, 255),
    deploymentId: str(e.deploymentId, 255),
    resourceGroup: str(e.resourceGroup, 255),
    sdk: e.sdk ?? null,
    operation: e.operation ?? null,
    requestId: str(e.requestId, 255),
    finishReason: str(e.finishReason, 50),
    promptEstimatedBefore: int(e.tokens?.promptEstimatedBefore),
    promptEstimatedAfter: int(e.tokens?.promptEstimatedAfter),
    promptTokens: int(e.tokens?.prompt),
    completionTokens: int(e.tokens?.completion),
    totalTokens: int(e.tokens?.total),
    cachedTokens: int(e.tokens?.cached),
    savedTokensEstimate: int(e.savings?.estimatedTokens),
    savingsByStep: JSON.stringify(e.savings?.byStep ?? {}),
    cacheHit: !!e.savings?.cacheHit,
    promptPrefixChanged: !!e.advisory?.promptPrefixChanged,
    costEstimate: e.costEstimate ?? null,
    latencyMs: int(e.latencyMs),
    retries: int(e.retries) ?? 0,
    status: e.status,
    errorCategory: e.error?.category ?? null,
    errorHttpStatus: int(e.error?.httpStatus),
    errorCode: str(e.error?.code, 100),
    errorMessage: str(e.error?.message, 300),
    promptHash: e.promptHash ?? null,
    promptLength: int(e.promptLength)
  }
}

/**
 * @param {object} [cfg] metrics.db config
 * @param {{ cds?: any, now?: () => number }} [deps]
 * @returns {import('../../index').Exporter}
 */
function createDbExporter (cfg = {}, deps = {}) {
  const opts = { ...DEFAULTS, ...cfg }
  const now = deps.now ?? Date.now
  const queue = []
  const counters = { written: 0, dropped: 0, failedWrites: 0, deleted: 0 }
  const lastCleanup = new Map()
  let flushing = null
  let db = null
  let unavailable = false

  const cds = () => deps.cds ?? getCds()

  async function connect () {
    if (db) return db
    const c = cds()
    if (!c) throw new Error('@sap/cds is not loaded')
    db = await c.connect.to('db')
    if (!db.model?.definitions?.[ENTITY] && !c.model?.definitions?.[ENTITY]) {
      throw new Error(`entity ${ENTITY} is not in the model (is the @viveka10/cap-ai-token-optimizer plugin loaded?)`)
    }
    return db
  }

  function enqueue (rows, front = false) {
    if (front) queue.unshift(...rows)
    else queue.push(...rows)
    const over = queue.length - opts.maxQueueSize
    if (over > 0) {
      queue.splice(0, over)
      counters.dropped += over
    }
  }

  async function writeTenant (service, tenant, rows) {
    const c = cds()
    const ctx = { tenant: tenant ?? undefined, user: new c.User.Privileged() }
    await service.tx(ctx, async (tx) => {
      await tx.run(c.ql.INSERT.into(ENTITY).entries(rows))
      const key = tenant ?? ''
      if (opts.retentionDays > 0 && !(now() - (lastCleanup.get(key) ?? 0) < DAY)) {
        lastCleanup.set(key, now())
        const cutoff = new Date(now() - opts.retentionDays * DAY).toISOString()
        const n = await tx.run(c.ql.DELETE.from(ENTITY).where({ timestamp: { '<': cutoff } }))
        counters.deleted += Number(n) || 0
      }
    })
  }

  async function drain () {
    if (!queue.length || unavailable) return
    let service
    try {
      service = await connect()
    } catch (e) {
      unavailable = true
      counters.dropped += queue.length
      queue.length = 0
      log.warn('db exporter disabled:', e?.message)
      return
    }
    const rows = queue.splice(0, queue.length)
    const byTenant = new Map()
    for (const r of rows) {
      if (!byTenant.has(r.tenant)) byTenant.set(r.tenant, [])
      byTenant.get(r.tenant).push(r)
    }
    for (const [tenant, tenantRows] of byTenant) {
      try {
        await writeTenant(service, tenant, tenantRows)
        counters.written += tenantRows.length
      } catch (e) {
        counters.failedWrites++
        enqueue(tenantRows, true)
        log.warn(`db exporter: could not write ${tenantRows.length} row(s):`, e?.message)
      }
    }
  }

  function flush () {
    flushing ??= drain().catch(e => log.warn('db exporter flush failed:', e?.message)).finally(() => { flushing = null })
    return flushing
  }

  return {
    name: 'db',
    export (event) {
      if (unavailable) { counters.dropped++; return }
      enqueue([toRow(event)])
      if (queue.length >= opts.batchSize) flush()
    },
    flush,
    async shutdown () {
      await flushing
      await flush()
    },
    stats: () => ({ queued: queue.length, ...counters })
  }
}

module.exports = { createDbExporter, toRow, ENTITY, DEFAULTS }

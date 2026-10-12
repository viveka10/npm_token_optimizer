'use strict'
// Use the app's @sap/cds instance (see lib/util/cds.js)
const cds = globalThis.cds ?? require('@sap/cds')
const { optimizer } = require('../index')

const totals = (t) => ({
  calls: t.calls,
  success: t.success,
  errors: t.errors,
  cacheHits: t.cacheHits,
  tokens: { ...t.tokens },
  savedTokensEstimate: t.savedTokensEstimate,
  costEstimate: t.costEstimate
})

/**
 * OData exposes structured elements (`tokens`) as flat columns (`tokens_prompt`, …) unless the
 * app uses structured OData (`odata.structs`, e.g. flavor x4). Return rows in the same shape.
 */
function shape (row) {
  if (cds.env.effective?.odata?.structs || !row.tokens) return row
  const { tokens, ...rest } = row
  for (const [k, v] of Object.entries(tokens)) rest[`tokens_${k}`] = v
  return rest
}

/**
 * Rows for a READ, honouring a key lookup (e.g. UseCases('ask')). Lists carry `$count`, so
 * `$count=true` (used by Fiori elements to size its tables) reports the number of rows.
 */
function rows (req, list, key) {
  const wanted = req.data?.[key]
  if (wanted !== undefined) {
    const row = list.find(r => r[key] === wanted)
    return row ? shape(row) : null
  }
  const result = list.map(shape)
  result.$count = result.length
  return result
}

const DAY_MS = 24 * 3600 * 1000
const INTERVALS = { none: [], day: ['year', 'month', 'day'], hour: ['year', 'month', 'day', 'hour'] }
const GROUP_BY = ['model', 'useCase', 'cdsService', 'status', 'errorCategory', 'sdk', 'operation', 'resourceGroup']
const MAX_DAYS = { none: 366, day: 366, hour: 31 }
const pad = (n) => String(n).padStart(2, '0')
const int = (v) => v == null ? 0 : Math.round(Number(v))

/**
 * usage(): UsageLog totals per time bucket and `groupBy` value, aggregated in the database.
 * Buckets are UTC hours or days; empty buckets are not returned.
 */
async function usage (req, entity) {
  const interval = req.data.interval ?? 'day'
  const groupBy = req.data.groupBy ?? null
  const to = req.data.to ? new Date(req.data.to) : new Date()
  const from = req.data.from ? new Date(req.data.from) : new Date(to.getTime() - 7 * DAY_MS)
  if (!(interval in INTERVALS)) return req.reject(400, `interval must be one of ${Object.keys(INTERVALS).join(', ')}`)
  if (groupBy !== null && !GROUP_BY.includes(groupBy)) return req.reject(400, `groupBy must be one of ${GROUP_BY.join(', ')}`)
  if (isNaN(from) || isNaN(to) || from >= to) return req.reject(400, 'from must be before to')
  if (to - from > MAX_DAYS[interval] * DAY_MS) return req.reject(400, `interval '${interval}' allows at most ${MAX_DAYS[interval]} days`)

  const parts = INTERVALS[interval]
  const dims = [...parts.map(p => `${p}(timestamp)`), ...(groupBy ? [groupBy] : [])]
  const q = cds.ql.SELECT.from(entity).columns(
    ...parts.map(p => `${p}(timestamp) as ${p}`),
    ...(groupBy ? [`${groupBy} as name`] : []),
    'count(1) as calls',
    "sum(case when status = 'error' then 1 else 0 end) as errors",
    'sum(case when cacheHit = true then 1 else 0 end) as cacheHits',
    'sum(promptTokens) as promptTokens',
    'sum(completionTokens) as completionTokens',
    'sum(totalTokens) as totalTokens',
    'sum(cachedTokens) as cachedTokens',
    'sum(savedTokensEstimate) as savedTokensEstimate',
    'sum(costEstimate) as costEstimate',
    'avg(latencyMs) as latencyAvg',
    'max(latencyMs) as latencyMax'
  ).where('timestamp >=', from.toISOString(), 'and timestamp <', to.toISOString())
  if (dims.length) q.groupBy(...dims).orderBy(...dims)
  const rows = await cds.run(q)
  return rows.filter(r => r.calls > 0).map(r => ({
    bucket: parts.length ? `${r.year}-${pad(r.month)}-${pad(r.day)}T${pad(r.hour ?? 0)}:00:00Z` : null,
    name: groupBy ? (r.name ?? null) : null,
    calls: int(r.calls),
    errors: int(r.errors),
    cacheHits: int(r.cacheHits),
    promptTokens: int(r.promptTokens),
    completionTokens: int(r.completionTokens),
    totalTokens: int(r.totalTokens),
    cachedTokens: int(r.cachedTokens),
    savedTokensEstimate: int(r.savedTokensEstimate),
    costEstimate: r.costEstimate == null ? null : Number(Number(r.costEstimate).toFixed(6)),
    latencyAvg: r.latencyAvg == null ? null : int(r.latencyAvg),
    latencyMax: r.latencyMax == null ? null : int(r.latencyMax)
  }))
}

module.exports = class TokenOptimizerService extends cds.ApplicationService {
  init () {
    this.on('summary', () => {
      const s = optimizer.stats()
      return { ...totals(s), since: s.since, mode: optimizer.config.mode, latencyMs: s.latencyMs, listenerErrors: s.listenerErrors }
    })
    this.on('READ', 'UseCases', (req) => rows(req, Object.entries(optimizer.stats().byUseCase).map(([name, t]) => ({ name, ...totals(t) })), 'name'))
    this.on('READ', 'Models', (req) => rows(req, Object.entries(optimizer.stats().byModel).map(([name, t]) => ({ name, ...totals(t) })), 'name'))
    this.on('READ', 'ErrorCategories', (req) => rows(req, Object.entries(optimizer.stats().errorsByCategory).map(([category, count]) => ({ category, count })), 'category'))
    this.on('READ', 'StepSavings', (req) => rows(req, Object.entries(optimizer.stats().savingsByStep).map(([step, tokens]) => ({ step, tokens })), 'step'))
    this.on('READ', 'PromptPrefixChanges', (req) => rows(req, Object.entries(optimizer.stats().promptPrefixChanges).map(([useCase, count]) => ({ useCase, count })), 'useCase'))
    this.on('READ', 'Exporters', (req) => {
      const s = optimizer.stats()
      const names = optimizer.collector.exporters.map(x => x.name ?? 'anonymous')
      return rows(req, names.map(name => ({ name, errors: s.exporterErrors[name] ?? 0, stats: s.exporters[name] ? JSON.stringify(s.exporters[name]) : null })), 'name')
    })
    // only when the db exporter is on (see admin-usage-log.cds)
    const { UsageLog } = this.entities
    if (UsageLog) this.on('usage', (req) => usage(req, UsageLog))
    return super.init()
  }
}

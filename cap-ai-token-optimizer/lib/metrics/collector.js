'use strict'
const { EventEmitter } = require('node:events')
const log = require('../util/log')

const LATENCY_SAMPLES = 1000

function emptyTotals () {
  return {
    calls: 0,
    success: 0,
    errors: 0,
    cacheHits: 0,
    tokens: { prompt: 0, completion: 0, total: 0, cached: 0 },
    savedTokensEstimate: 0,
    costEstimate: 0
  }
}

/**
 * Receives call events, keeps in-memory aggregates, notifies listeners and fans out to exporters.
 * Listener and exporter failures are caught and counted — they never reach the AI call.
 */
class MetricsCollector extends EventEmitter {
  constructor () {
    super()
    /** @type {Array<import('../../index').Exporter>} */
    this.exporters = []
    this._timer = null
    this.reset()
  }

  reset () {
    this._since = new Date().toISOString()
    this._totals = emptyTotals()
    this._errorsByCategory = {}
    this._savingsByStep = {}
    this._byUseCase = {}
    this._byModel = {}
    this._latencies = []
    this._prefixChanges = {}
    this._listenerErrors = 0
    this._exporterErrors = {}
  }

  /** @param {import('../../index').Exporter} exporter */
  addExporter (exporter) {
    if (!exporter || typeof exporter.export !== 'function') throw new TypeError('Exporter must implement export(event)')
    this.exporters.push(exporter)
  }

  /**
   * Record one call event. Never throws.
   * @param {object} event
   */
  record (event) {
    try {
      this._aggregate(event)
    } catch (e) {
      log.warn('metrics aggregation failed:', e?.message)
    }
    this._safeEmit('call', event)
    for (const exporter of this.exporters) {
      try {
        const r = exporter.export(event)
        if (r && typeof r.catch === 'function') r.catch(err => this._exporterFailed(exporter, err))
      } catch (err) {
        this._exporterFailed(exporter, err)
      }
    }
  }

  /** Emit a non-call event (e.g. 'warning'). Never throws. */
  notify (type, payload) {
    this._safeEmit(type, payload)
  }

  _safeEmit (type, payload) {
    for (const listener of this.rawListeners(type)) {
      try {
        const r = listener.call(this, payload)
        if (r && typeof r.catch === 'function') r.catch(e => { this._listenerErrors++; log.warn(`'${type}' listener failed:`, e?.message) })
      } catch (e) {
        this._listenerErrors++
        log.warn(`'${type}' listener failed:`, e?.message)
      }
    }
  }

  _exporterFailed (exporter, err) {
    const name = exporter.name ?? 'anonymous'
    this._exporterErrors[name] = (this._exporterErrors[name] ?? 0) + 1
    log.warn(`exporter '${name}' failed:`, err?.message)
  }

  _aggregate (e) {
    const buckets = [this._totals, bucket(this._byUseCase, e.useCase ?? 'default'), bucket(this._byModel, e.model ?? 'unknown')]
    for (const b of buckets) {
      b.calls++
      if (e.status === 'error') b.errors++
      else b.success++
      if (e.savings?.cacheHit) b.cacheHits++
      b.tokens.prompt += e.tokens?.prompt ?? 0
      b.tokens.completion += e.tokens?.completion ?? 0
      b.tokens.total += e.tokens?.total ?? 0
      b.tokens.cached += e.tokens?.cached ?? 0
      b.savedTokensEstimate += e.savings?.estimatedTokens ?? 0
      b.costEstimate = round6(b.costEstimate + (e.costEstimate ?? 0))
    }
    if (e.status === 'error') {
      const cat = e.error?.category ?? 'UNKNOWN'
      this._errorsByCategory[cat] = (this._errorsByCategory[cat] ?? 0) + 1
    }
    for (const [step, saved] of Object.entries(e.savings?.byStep ?? {})) {
      this._savingsByStep[step] = (this._savingsByStep[step] ?? 0) + (Number(saved) || 0)
    }
    if (e.advisory?.promptPrefixChanged) {
      const uc = e.useCase ?? 'default'
      this._prefixChanges[uc] = (this._prefixChanges[uc] ?? 0) + 1
    }
    if (Number.isFinite(e.latencyMs)) {
      this._latencies.push(e.latencyMs)
      if (this._latencies.length > LATENCY_SAMPLES) this._latencies.shift()
    }
  }

  /** Aggregated stats since start or last reset(). Returns a fresh copy. */
  stats () {
    return structuredClone({
      since: this._since,
      ...this._totals,
      errorsByCategory: this._errorsByCategory,
      savingsByStep: this._savingsByStep,
      latencyMs: latencyStats(this._latencies),
      byUseCase: this._byUseCase,
      byModel: this._byModel,
      // prompt-caching advisory: calls whose system prompt or tools changed, per use case
      promptPrefixChanges: this._prefixChanges,
      listenerErrors: this._listenerErrors,
      exporterErrors: this._exporterErrors,
      exporters: this._exporterStats()
    })
  }

  /** Stats reported by exporters that have a stats() method (e.g. http: queued, sent, dropped). */
  _exporterStats () {
    const out = {}
    for (const x of this.exporters) {
      if (typeof x.stats !== 'function') continue
      try { out[x.name ?? 'anonymous'] = x.stats() } catch { /* stats are best effort */ }
    }
    return out
  }

  /**
   * Start periodic flushing of buffering exporters.
   * @param {number} intervalMs
   */
  start (intervalMs) {
    if (this._timer || !(intervalMs > 0)) return
    this._timer = setInterval(() => { this.flush() }, intervalMs)
    this._timer.unref?.()
  }

  /** Stop periodic flushing. */
  stop () {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }

  /** Flush all exporters. Never rejects. */
  async flush () {
    await Promise.all(this.exporters.map(async (x) => {
      try { await x.flush?.() } catch (err) { this._exporterFailed(x, err) }
    }))
  }

  /** Stop the timer, flush and shut down all exporters. Never rejects. */
  async shutdown () {
    this.stop()
    await this.flush()
    await Promise.all(this.exporters.map(async (x) => {
      try { await x.shutdown?.() } catch (err) { this._exporterFailed(x, err) }
    }))
  }
}

function bucket (map, key) {
  map[key] ??= emptyTotals()
  return map[key]
}

function latencyStats (samples) {
  if (!samples.length) return { count: 0, avg: null, p50: null, p95: null, max: null }
  const sorted = [...samples].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
  return {
    count: sorted.length,
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1]
  }
}

const round6 = (n) => Math.round(n * 1e6) / 1e6

module.exports = { MetricsCollector }

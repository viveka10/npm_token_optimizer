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

/** Rows for a READ, honouring a key lookup (e.g. UseCases('ask')). */
function rows (req, list, key) {
  const wanted = req.data?.[key]
  if (wanted === undefined) return list
  return list.find(r => r[key] === wanted) ?? null
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
    return super.init()
  }
}

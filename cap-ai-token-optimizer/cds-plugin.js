'use strict'
/**
 * CAP plugin, loaded automatically by @sap/cds when this package is a dependency.
 * Reads cds.requires.tokenOptimizer, starts the exporters and flushes them on shutdown.
 */
const cds = globalThis.cds ?? require('@sap/cds')
const { optimizer, countText } = require('./index')
const log = require('./lib/util/log')
const path = require('node:path')

try {
  optimizer.configure(cds.env.requires?.tokenOptimizer)
  log.debug('configured, mode =', optimizer.config.mode, 'exporters =', optimizer.config.metrics.exporters)
  setupModels(optimizer.config)
} catch (e) {
  log.error('could not configure token optimizer:', e?.message)
}

/**
 * Add our CDS models to the app's model when the features using them are enabled:
 * the TokenUsageLog entity for the db exporter, the read-only admin service, and the
 * UsageLog projection when both are on. Plugins load before the model, so adding a `model`
 * to our cds.requires entry is enough.
 */
function setupModels (cfg) {
  const exporters = cfg.metrics.exporters ?? []
  const dbLog = exporters.includes('db') || exporters.includes('hana')
  const admin = cfg.admin?.enabled
  const models = []
  if (dbLog) models.push('db/token-usage-log')
  if (admin) models.push('srv/admin-service')
  if (admin && dbLog) models.push('srv/admin-usage-log')
  if (!models.length) return

  const req = cds.env.requires.tokenOptimizer ??= {}
  req.model = [...new Set([].concat(req.model ?? [], models.map(m => path.join(__dirname, m))))]
  if (!admin) return
  const role = cfg.admin.role || 'TokenOptimizerAdmin'
  cds.on('loaded', (csn) => {
    const srv = csn?.definitions?.TokenOptimizerService
    if (srv) srv['@requires'] = role
  })
}

// Load the tokenizer tables once the server is up, so the first AI call doesn't pay for it.
cds.once('served', () => setImmediate(() => {
  try { countText('warm up', 'gpt-4o') } catch { /* estimation falls back to the heuristic */ }
}))

cds.on('shutdown', () => optimizer.shutdown())

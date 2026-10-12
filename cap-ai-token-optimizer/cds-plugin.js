'use strict'
/**
 * CAP plugin, loaded automatically by @sap/cds when this package is a dependency.
 * Reads cds.requires.tokenOptimizer, starts the exporters and flushes them on shutdown.
 */
const cds = globalThis.cds ?? require('@sap/cds')
const { optimizer, countText } = require('./index')
const log = require('./lib/util/log')

try {
  optimizer.configure(cds.env.requires?.tokenOptimizer)
  log.debug('configured, mode =', optimizer.config.mode, 'exporters =', optimizer.config.metrics.exporters)
  setupAdminRole(optimizer.config)
  setupDashboard(optimizer.config)
} catch (e) {
  log.error('could not configure token optimizer:', e?.message)
}

/**
 * The CDS models (usage log entity, admin service) are added through `model` in .cdsrc.js, so
 * they are also part of `cds build` and `cds deploy`. Here we only set the admin service's role.
 */
function setupAdminRole (cfg) {
  if (!cfg.admin?.enabled) return
  const role = cfg.admin.role || 'TokenOptimizerAdmin'
  cds.on('loaded', (csn) => {
    const srv = csn?.definitions?.TokenOptimizerService
    if (srv) srv['@requires'] = role
  })
}

/** The web dashboard is mounted on the app's express instance before the services are served. */
function setupDashboard (cfg) {
  if (!cfg.dashboard?.enabled) return
  cds.on('bootstrap', (app) => {
    try {
      const at = require('./lib/dashboard').mountDashboard(app, cfg, cds)
      log.info('dashboard served at', at)
    } catch (e) {
      log.error('could not serve the dashboard:', e?.message)
    }
  })
}

// Load the tokenizer tables once the server is up, so the first AI call doesn't pay for it.
cds.once('served', () => setImmediate(() => {
  try { countText('warm up', 'gpt-4o') } catch { /* estimation falls back to the heuristic */ }
}))

cds.on('shutdown', () => optimizer.shutdown())

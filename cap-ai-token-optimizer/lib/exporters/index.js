'use strict'
const log = require('../util/log')
const { createConsoleExporter } = require('./console')
const { createHttpExporter } = require('./http')
const { createOtelExporter } = require('./otel')
const { createDbExporter } = require('./db')

/** Built-in exporter factories. */
const FACTORIES = {
  console: (cfg, deps) => createConsoleExporter(deps.console),
  http: (cfg, deps) => createHttpExporter(cfg.metrics.http, deps.http),
  otel: (cfg, deps) => createOtelExporter(cfg.metrics.otel, deps.otel),
  db: (cfg, deps) => createDbExporter(cfg.metrics.db, deps.db)
}
// `hana` is the name used in the docs for the database exporter
FACTORIES.hana = FACTORIES.db

/**
 * Create exporters listed in `cfg.metrics.exporters`. Entries may be names of built-ins
 * or exporter objects. Unknown names are skipped with a warning.
 * @param {object} cfg resolved config
 * @param {object} [deps] injectable dependencies for tests
 */
function createExporters (cfg, deps = {}) {
  const out = []
  const entries = [...(cfg.metrics?.exporters ?? [])]
  // `metrics.otel.enabled: true` is a shortcut for listing 'otel'
  if (cfg.metrics?.otel?.enabled && !entries.includes('otel')) entries.push('otel')
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && typeof entry.export === 'function') { out.push(entry); continue }
    const factory = FACTORIES[entry]
    if (!factory) { log.warn(`Unknown metrics exporter '${entry}' — skipped`); continue }
    try {
      out.push(factory(cfg, deps))
    } catch (e) {
      log.warn(`Could not create exporter '${entry}':`, e?.message)
    }
  }
  return out
}

module.exports = { createExporters, FACTORIES }

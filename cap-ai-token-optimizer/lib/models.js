'use strict'
/**
 * The CDS models this plugin adds to the app, depending on its configuration: the
 * TokenUsageLog entity for the db exporter, the read-only admin service (also needed by the
 * dashboard), and the UsageLog projection when both are on.
 */
const { name } = require('../package.json')

/**
 * @param {object} [cfg] cds.requires.tokenOptimizer (raw, as in cds.env)
 * @returns {string[]} model ids, resolved from the app root like `using from '<id>'`
 */
function modelsFor (cfg) {
  const exporters = [].concat(cfg?.metrics?.exporters ?? [])
  const dbLog = exporters.includes('db') || exporters.includes('hana')
  const dashboard = cfg?.dashboard === true || cfg?.dashboard?.enabled === true
  const admin = cfg?.admin?.enabled === true || dashboard
  const models = []
  if (dbLog) models.push(`${name}/db/token-usage-log`)
  if (admin) models.push(`${name}/srv/admin-service`)
  if (admin && dbLog) models.push(`${name}/srv/admin-usage-log`)
  return models
}

module.exports = { modelsFor }

'use strict'
/**
 * Plugin configuration defaults, read by cds.env. cds.env is also rebuilt from these files
 * after plugins are loaded (`cds build`, `cds deploy`), so anything cds-plugin.js wrote into
 * cds.env would be lost there.
 *
 * `model` is therefore a getter: CAP's config merge keeps getters, and CAP reads `model`
 * when it resolves the app's models, after the app's own configuration and profiles have been
 * merged. Models the app sets explicitly are kept.
 */
const { modelsFor } = require('./lib/models')

module.exports = {
  requires: {
    tokenOptimizer: {
      kind: 'token-optimizer',
      get model () {
        const own = [].concat(this._model ?? [])
        const models = [...new Set([...own, ...modelsFor(this)])]
        return models.length ? models : undefined
      },
      set model (value) {
        Object.defineProperty(this, '_model', { value, writable: true, configurable: true, enumerable: false })
      }
    }
  }
}

'use strict'
const { TokenOptimizer } = require('./lib/optimizer')
const { resolveConfig, DEFAULTS } = require('./lib/config')
const { classifyError, CATEGORIES } = require('./lib/metrics/classifier')
const { estimateMessages, countText } = require('./lib/tokens/estimator')
const { createConsoleExporter } = require('./lib/exporters/console')
const { MemoryCacheStore } = require('./lib/cache')

// One optimizer per process, even if two copies of this package get loaded
// (e.g. a `file:` install next to a registry install).
const KEY = Symbol.for('cap-ai-token-optimizer.singleton')
globalThis[KEY] ??= new TokenOptimizer()

/** @type {TokenOptimizer} */
const optimizer = globalThis[KEY]

/**
 * Create a separate optimizer instance with its own config, stats and exporters.
 * @param {object} [config]
 * @param {object} [deps]
 */
const createOptimizer = (config = {}, deps) => new TokenOptimizer(config, deps)

module.exports = {
  optimizer,
  createOptimizer,
  TokenOptimizer,
  resolveConfig,
  DEFAULTS,
  classifyError,
  CATEGORIES,
  estimateMessages,
  countText,
  createConsoleExporter,
  MemoryCacheStore
}

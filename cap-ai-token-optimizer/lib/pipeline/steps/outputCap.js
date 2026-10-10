'use strict'
/**
 * outputCap: set max_tokens from the (per-use-case) config when the caller set no limit.
 * Reasoning models (o1/o3/o4, gpt-5) spend output tokens on hidden reasoning, so a cap can
 * produce empty answers; they are skipped unless `reasoningModels: true`.
 * Saves output tokens, which cannot be known before the call, so it reports 0 saved prompt tokens.
 */
const { baseModelName } = require('../../tokens/estimator')

const DEFAULTS = { default: 1024, reasoningModels: false }
const REASONING = /^(o\d|gpt-5)/

/**
 * @param {import('../index').StepInput} input
 * @param {object} options
 */
function outputCap ({ params, model }, options) {
  const opts = { ...DEFAULTS, ...options }
  const p = params ?? {}
  if (p.max_tokens != null || p.max_completion_tokens != null) return { params, notes: [] }
  if (!(opts.default > 0)) return { params, notes: [] }
  if (REASONING.test(baseModelName(model)) && !opts.reasoningModels) {
    return { params, notes: ['skipped: reasoning model'] }
  }
  return { params: { ...p, max_tokens: opts.default }, notes: [`max_tokens set to ${opts.default}`] }
}

module.exports = { outputCap, DEFAULTS }

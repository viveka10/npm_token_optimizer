'use strict'
/**
 * Optimization pipeline. Steps run in this order: normalize, dedupe, history, tools, outputCap.
 * (The response cache runs around the call, see lib/cache.)
 *
 * Each step receives { messages, tools, params, model } and returns any of
 * { messages, tools, params, notes }. The runner measures what each step saved
 * (estimated prompt tokens before minus after), so every step reports its savings the same way.
 * A step that throws aborts the whole pipeline; the caller then sends the original request.
 */
const { normalize } = require('./steps/normalize')
const { dedupe } = require('./steps/dedupe')
const { history } = require('./steps/history')
const { tools } = require('./steps/tools')
const { outputCap } = require('./steps/outputCap')
const { createMemoEstimator } = require('../tokens/estimator')

/**
 * @typedef {object} StepInput
 * @property {object[]} messages
 * @property {object[]|undefined} tools
 * @property {object} params
 * @property {string|null} model
 */

const STEPS = [
  { name: 'normalize', run: normalize },
  { name: 'dedupe', run: dedupe },
  { name: 'history', run: history },
  { name: 'tools', run: tools, needs: 'tools' },
  { name: 'outputCap', run: outputCap, needs: 'params' }
]

/**
 * Step config → options object, or null when the step is disabled.
 * Accepts false/true/object; `{ enabled: false }` also disables.
 */
function stepOptions (value) {
  if (value === true) return {}
  if (value && typeof value === 'object' && value.enabled !== false) return value
  return null
}

/**
 * @param {object} input
 * @param {object[]} input.messages
 * @param {object[]} [input.tools]
 * @param {object} [input.params]
 * @param {string|null} [input.model]
 * @param {object} input.steps steps config
 * @param {{ tools?: boolean, params?: boolean }} [input.editable] whether tools / params can be changed for this client
 */
async function runPipeline ({ messages, tools: toolDefs, params = {}, model = null, steps = {}, editable = { tools: true, params: true } }) {
  const est = createMemoEstimator(model)
  let state = { messages: messages ?? [], tools: toolDefs, params: params ?? {} }
  const byStep = {}
  const notes = []
  const before = est.estimate(state.messages, state.tools).tokens

  for (const step of STEPS) {
    const options = stepOptions(steps[step.name])
    if (!options) continue
    if (step.needs && editable[step.needs] === false) {
      notes.push(`${step.name}: skipped, the client's ${step.needs} are fixed`)
      continue
    }
    const start = est.estimate(state.messages, state.tools).tokens
    const result = await step.run({ ...state, model }, options)
    state = {
      messages: result?.messages ?? state.messages,
      tools: result && 'tools' in result ? result.tools : state.tools,
      params: result?.params ?? state.params
    }
    if (!Array.isArray(state.messages)) throw new Error(`step ${step.name} returned invalid messages`)
    byStep[step.name] = start - est.estimate(state.messages, state.tools).tokens
    for (const n of result?.notes ?? []) notes.push(`${step.name}: ${n}`)
  }

  const after = est.estimate(state.messages, state.tools).tokens
  return {
    ...state,
    byStep,
    notes,
    estimateBefore: before,
    estimateAfter: after,
    savedTokensEstimate: before - after
  }
}

module.exports = { runPipeline, stepOptions, STEPS }

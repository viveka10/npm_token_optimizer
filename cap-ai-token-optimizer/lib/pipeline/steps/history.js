'use strict'
/**
 * history: keep system messages plus the last N conversation turns.
 *
 * A turn starts at a user message and includes the assistant and tool messages that follow,
 * so tool calls are never separated from their results. Locked (orchestration template)
 * messages are always kept.
 *
 * Pluggable: `strategy` may be a function `({ messages, maxTurns }) => messages`.
 * Optional `summarizer`: `async ({ dropped, kept }) => message | null`; the returned
 * message is inserted after the leading system messages. No summarizer is built in.
 */
const { isLocked, isSystem, ORIGIN } = require('../messages')

const DEFAULTS = { maxTurns: 10, strategy: 'sliding-window', summarizer: null }

/**
 * Default strategy.
 * @param {{ messages: object[], maxTurns: number }} input
 * @returns {object[]}
 */
function slidingWindow ({ messages, maxTurns }) {
  // index where each turn starts
  const starts = []
  messages.forEach((m, i) => { if (m?.role === 'user' && !isSystem(m)) starts.push(i) })
  if (starts.length <= maxTurns) return messages
  const cut = starts[starts.length - maxTurns]
  return messages.filter((m, i) => i >= cut || isSystem(m) || isLocked(m))
}

const STRATEGIES = { 'sliding-window': slidingWindow }

/**
 * @param {import('../index').StepInput} input
 * @param {object} options
 */
async function history ({ messages, model }, options) {
  const opts = { ...DEFAULTS, ...options }
  if (!(opts.maxTurns > 0)) return { messages, notes: [] }
  const strategy = typeof opts.strategy === 'function' ? opts.strategy : STRATEGIES[opts.strategy]
  if (!strategy) throw new Error(`Unknown history strategy "${opts.strategy}"`)

  const kept = strategy({ messages, maxTurns: opts.maxTurns, model })
  if (!Array.isArray(kept)) throw new Error('history strategy must return an array of messages')
  if (kept.length === messages.length) return { messages, notes: [] }
  const keptSet = new Set(kept)
  const dropped = messages.filter(m => !keptSet.has(m))
  if (dropped.some(isLocked)) throw new Error('history strategy dropped a template message')
  const notes = [`${dropped.length} message(s) outside the last ${opts.maxTurns} turns removed`]

  if (typeof opts.summarizer === 'function') {
    const summary = await opts.summarizer({ dropped, kept, model })
    if (summary) {
      const at = kept.findIndex(m => !isSystem(m))
      const tagged = { ...summary, [ORIGIN]: dropped[0]?.[ORIGIN] }
      kept.splice(at < 0 ? kept.length : at, 0, tagged)
      notes.push('summary of removed turns inserted')
    }
  }
  return { messages: kept, notes }
}

module.exports = { history, slidingWindow, STRATEGIES, DEFAULTS }

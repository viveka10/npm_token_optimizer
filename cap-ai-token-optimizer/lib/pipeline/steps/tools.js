'use strict'
/**
 * tools: for agents and MCP servers with many tools.
 *  - When there are more than `maxTools` tool definitions, keep the most relevant ones.
 *    Always kept: tools named in `pinned`, tools already used in the conversation, and the
 *    tool forced by `tool_choice`. The rest are ranked by keyword overlap with the latest
 *    user message (ties keep the original order). The original order is preserved.
 *  - Descriptions longer than `maxDescriptionLength` are shortened (at a sentence end
 *    when possible), for the tool and for its parameters.
 *
 * Pluggable: `selector` may be a function `({ tools, messages, maxTools, keep }) => tools`
 * where `keep` is the Set of names that must be kept.
 */
const { toolName } = require('../messages')

const DEFAULTS = { maxTools: 15, maxDescriptionLength: 600, pinned: [], selector: null }

const STOPWORDS = new Set(('the and for with that this from have what which when where will would could should about into ' +
  'your you are was were been can not but all any our out get set use using please there their them then than ' +
  'also just like make need want show give tell does did has had its it\'s let me my mine how who why').split(' '))

/** Lower-case keywords of a text, splitting snake_case and camelCase. */
function keywords (text) {
  return new Set(String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w)))
}

function toolKeywords (t) {
  const fn = t?.function ?? t
  const params = fn?.parameters?.properties ? Object.keys(fn.parameters.properties).join(' ') : ''
  return keywords(`${toolName(t) ?? ''} ${fn?.description ?? ''} ${params}`)
}

/** Names of tools the conversation already used. */
function usedToolNames (messages) {
  const names = new Set()
  for (const m of messages) {
    for (const tc of m?.tool_calls ?? []) if (tc?.function?.name) names.add(tc.function.name)
    if (m?.role === 'tool' && m.name) names.add(m.name)
  }
  return names
}

function contentText (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
  return ''
}

/**
 * Default selector: keyword overlap with the latest user message.
 * @param {{ tools: object[], messages: object[], maxTools: number, keep: Set<string> }} input
 */
function keywordSelector ({ tools, messages, maxTools, keep }) {
  const lastUser = [...messages].reverse().find(m => m?.role === 'user')
  const query = keywords(contentText(lastUser?.content))
  const scored = tools.map((t, i) => {
    let score = 0
    for (const w of toolKeywords(t)) if (query.has(w)) score++
    return { t, i, score, must: keep.has(toolName(t)) || t?.type !== undefined && t.type !== 'function' }
  })
  const chosen = new Set(scored.filter(s => s.must).map(s => s.i))
  const rest = scored.filter(s => !s.must).sort((a, b) => b.score - a.score || a.i - b.i)
  for (const s of rest) {
    if (chosen.size >= maxTools) break
    chosen.add(s.i)
  }
  return tools.filter((_t, i) => chosen.has(i))
}

/**
 * Shorten text to at most `max` characters, at a sentence end if one is in the second half.
 * @param {string} text
 * @param {number} max
 */
function shorten (text, max) {
  if (typeof text !== 'string' || text.length <= max) return text
  const head = text.slice(0, max)
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (sentenceEnd >= max / 2) return head.slice(0, sentenceEnd + 1)
  return `${head.slice(0, max - 1).trimEnd()}…`
}

function shortenSchema (schema, max) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  let changed = false
  const out = { ...schema }
  if (typeof schema.description === 'string') {
    const d = shorten(schema.description, max)
    if (d !== schema.description) { out.description = d; changed = true }
  }
  for (const key of ['properties', '$defs', 'definitions']) {
    if (schema[key] && typeof schema[key] === 'object') {
      const next = {}
      let sub = false
      for (const [k, v] of Object.entries(schema[key])) {
        next[k] = shortenSchema(v, max)
        if (next[k] !== v) sub = true
      }
      if (sub) { out[key] = next; changed = true }
    }
  }
  if (schema.items) {
    const items = shortenSchema(schema.items, max)
    if (items !== schema.items) { out.items = items; changed = true }
  }
  return changed ? out : schema
}

function shortenTool (t, max) {
  const fn = t?.function
  if (!fn) return t
  const description = shorten(fn.description, max)
  const parameters = shortenSchema(fn.parameters, max)
  if (description === fn.description && parameters === fn.parameters) return t
  return { ...t, function: { ...fn, ...(description !== undefined ? { description } : {}), ...(parameters !== undefined ? { parameters } : {}) } }
}

/**
 * @param {import('../index').StepInput} input
 * @param {object} options
 */
function tools ({ messages, tools: defs, params }, options) {
  const opts = { ...DEFAULTS, ...options }
  if (!Array.isArray(defs) || !defs.length) return { tools: defs, notes: [] }
  const notes = []
  let out = defs

  if (opts.maxTools > 0 && defs.length > opts.maxTools) {
    const keep = new Set([...(opts.pinned ?? []), ...usedToolNames(messages)])
    const forced = params?.tool_choice?.function?.name
    if (forced) keep.add(forced)
    const selector = typeof opts.selector === 'function' ? opts.selector : keywordSelector
    out = selector({ tools: defs, messages, maxTools: opts.maxTools, keep })
    if (!Array.isArray(out)) throw new Error('tools selector must return an array')
    const names = new Set(out.map(toolName))
    const missing = [...keep].filter(n => defs.some(t => toolName(t) === n) && !names.has(n))
    if (missing.length) throw new Error(`tools selector dropped required tools: ${missing.join(', ')}`)
    if (out.length < defs.length) notes.push(`${defs.length - out.length} of ${defs.length} tools removed`)
  }

  if (opts.maxDescriptionLength > 0) {
    let shortened = 0
    out = out.map(t => {
      const s = shortenTool(t, opts.maxDescriptionLength)
      if (s !== t) shortened++
      return s
    })
    if (shortened) notes.push(`${shortened} tool description(s) shortened`)
  }
  return { tools: out, notes }
}

module.exports = { tools, keywordSelector, keywords, shorten, usedToolNames, DEFAULTS }

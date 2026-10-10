'use strict'
/**
 * normalize: trim, collapse repeated spaces and blank lines, minify JSON blocks.
 * Fenced code blocks, inline code and indented (code-like) lines keep their whitespace.
 * JSON is minified on the text itself, so numbers, key order and duplicate keys are kept.
 */
const { splitFences, joinSegments, tryMinifyJson, splitJsonBlocks } = require('../text')
const { mapText, isLocked } = require('../messages')

const DEFAULTS = { minifyJson: true, minifyJsonFences: true, collapseSpaces: true }

/**
 * @param {import('../index').StepInput} input
 * @param {object} options
 */
function normalize ({ messages }, options) {
  const opts = { ...DEFAULTS, ...options }
  let changed = 0
  const out = messages.map(m => {
    let next = mapText(m, text => normalizeText(text, opts))
    if (opts.minifyJson && Array.isArray(next?.tool_calls) && !isLocked(next)) {
      next = minifyToolCallArguments(next)
    }
    if (next !== m) changed++
    return next
  })
  return { messages: out, notes: changed ? [`${changed} message(s) normalized`] : [] }
}

function minifyToolCallArguments (m) {
  let changed = false
  const toolCalls = m.tool_calls.map(tc => {
    const args = tc?.function?.arguments
    if (typeof args !== 'string') return tc
    const min = tryMinifyJson(args)
    if (min === null || min === args) return tc
    changed = true
    return { ...tc, function: { ...tc.function, arguments: min } }
  })
  return changed ? { ...m, tool_calls: toolCalls } : m
}

/**
 * @param {string} text
 * @param {typeof DEFAULTS} opts
 */
function normalizeText (text, opts = DEFAULTS) {
  const all = splitFences(text)
  const segments = all.map((seg, i) => {
    if (seg.type === 'code') return opts.minifyJsonFences && /^json\b/i.test(seg.info ?? '') ? minifyJsonFence(seg) : seg
    const parts = splitJsonBlocks(seg.text).map(p => {
      if (p.type === 'json') return opts.minifyJson ? tryMinifyJson(p.text) : p.text
      return normalizeProse(p.text, opts)
    })
    // blank lines are collapsed in prose only; code keeps its blank lines.
    // Next to a fence, the newline added when segments are joined counts too.
    let prose = parts.join('').replace(/\n{3,}/g, '\n\n')
    if (i > 0) prose = prose.replace(/^\n{2,}/, '\n')
    if (i < all.length - 1) prose = prose.replace(/\n{2,}$/, '\n')
    return { ...seg, text: prose }
  })
  return joinSegments(segments).trim()
}

function minifyJsonFence (seg) {
  const lines = seg.text.split('\n')
  if (lines.length < 3) return seg
  const body = lines.slice(1, -1).join('\n')
  const min = tryMinifyJson(body)
  return min === null ? seg : { ...seg, text: `${lines[0].trim()}\n${min}\n${lines.at(-1).trim()}` }
}

/**
 * @param {string} text
 * @param {typeof DEFAULTS} opts
 */
function normalizeProse (text, opts) {
  return text.split('\n').map(line => {
    const trimmed = line.replace(/[ \t\r]+$/, '')
    if (!opts.collapseSpaces || /^( {4,}|\t)/.test(trimmed)) return trimmed
    const indent = /^[ \t]*/.exec(trimmed)[0]
    // keep inline code spans as they are
    const body = trimmed.slice(indent.length).split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/ {2,}/g, ' '))).join('')
    return indent + body
  }).join('\n')
}

module.exports = { normalize, normalizeText, DEFAULTS }

'use strict'
/**
 * Pre-call token estimation.
 * Uses js-tiktoken for OpenAI model families and a chars/4 heuristic for everything else
 * (Anthropic, Gemini, Mistral, … tokenizers are not public / not bundled).
 * Estimates are approximate; post-call metrics prefer real usage from the response.
 */

// Overhead per message / per reply, following OpenAI's published counting recipe.
const TOKENS_PER_MESSAGE = 3
const REPLY_PRIMING = 3
// Rough flat cost for a non-text content part (e.g. an image) when estimating.
const NON_TEXT_PART_TOKENS = 85

const FAMILIES = [
  // order matters: more specific prefixes first
  { re: /^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|gpt-oss|o1|o3|o4|chatgpt-4o|gpt-realtime)/, encoding: 'o200k_base' },
  { re: /^(gpt-4|gpt-3\.5|text-embedding-3|text-embedding-ada)/, encoding: 'cl100k_base' }
]

const encoders = new Map()
let tiktoken // lazy: the rank tables are large

/**
 * Strip vendor prefixes used by AI Core model names, e.g. "azure-openai--gpt-4.1" or "openai/gpt-4.1".
 * @param {string} model
 */
const baseModelName = (model) => String(model ?? '').toLowerCase().replace(/^.*(--|\/)/, '')

/**
 * @param {string} [model]
 * @returns {string|null} tiktoken encoding name, or null when the heuristic should be used
 */
function encodingFor (model) {
  const name = baseModelName(model)
  return FAMILIES.find(f => f.re.test(name))?.encoding ?? null
}

function getEncoder (encoding) {
  if (!encoders.has(encoding)) {
    tiktoken ??= require('js-tiktoken')
    encoders.set(encoding, tiktoken.getEncoding(encoding))
  }
  return encoders.get(encoding)
}

/** @param {string} text */
const heuristic = (text) => Math.ceil(text.length / 4)

/**
 * Count tokens of a string.
 * @param {string} text
 * @param {string} [model]
 * @returns {{ tokens: number, method: 'tiktoken'|'heuristic' }}
 */
function countText (text, model) {
  const str = typeof text === 'string' ? text : String(text ?? '')
  if (!str) return { tokens: 0, method: encodingFor(model) ? 'tiktoken' : 'heuristic' }
  const encoding = encodingFor(model)
  if (encoding) {
    try {
      return { tokens: getEncoder(encoding).encode(str).length, method: 'tiktoken' }
    } catch { /* fall through to heuristic */ }
  }
  return { tokens: heuristic(str), method: 'heuristic' }
}

/**
 * Flatten message content into text and count non-text parts.
 * @param {any} content
 * @returns {{ text: string, extraTokens: number }}
 */
function contentText (content) {
  if (content == null) return { text: '', extraTokens: 0 }
  if (typeof content === 'string') return { text: content, extraTokens: 0 }
  if (Array.isArray(content)) {
    let text = ''
    let extraTokens = 0
    for (const part of content) {
      if (typeof part === 'string') text += part
      else if (typeof part?.text === 'string') text += part.text
      else extraTokens += NON_TEXT_PART_TOKENS
    }
    return { text, extraTokens }
  }
  return { text: JSON.stringify(content), extraTokens: 0 }
}

/**
 * Tokens of one message, including the per-message overhead.
 * @param {object} m
 * @param {string} [model]
 */
function messageTokens (m, model) {
  if (!m) return 0
  const { text, extraTokens } = contentText(m.content)
  const parts = [m.role ?? '', text]
  if (m.name) parts.push(m.name)
  if (m.tool_calls) parts.push(JSON.stringify(m.tool_calls))
  if (m.tool_call_id) parts.push(m.tool_call_id)
  return TOKENS_PER_MESSAGE + countText(parts.join('\n'), model).tokens + extraTokens
}

/**
 * Tokens of one tool definition (serialised JSON; providers use a similar but not
 * identical internal format).
 * @param {object} tool
 * @param {string} [model]
 */
const toolTokens = (tool, model) => countText(JSON.stringify(tool ?? null), model).tokens

/**
 * Estimate the prompt tokens of a chat request.
 * @param {Array<object>} messages
 * @param {{ model?: string, tools?: Array<object> }} [opts]
 * @returns {{ tokens: number, method: 'tiktoken'|'heuristic' }}
 */
function estimateMessages (messages, { model, tools } = {}) {
  return createMemoEstimator(model).estimate(messages, tools)
}

/**
 * Estimate tokens consumed by tool definitions.
 * @param {Array<object>} tools
 * @param {string} [model]
 */
function estimateTools (tools, model) {
  const method = encodingFor(model) ? 'tiktoken' : 'heuristic'
  if (!Array.isArray(tools) || !tools.length) return { tokens: 0, method }
  return { tokens: tools.reduce((n, t) => n + toolTokens(t, model), 0), method }
}

/**
 * Estimator that remembers the count of every message and tool object it has seen.
 * Pipeline steps keep unchanged messages by identity, so re-estimating after each
 * step only counts what the step changed.
 * @param {string} [model]
 */
function createMemoEstimator (model) {
  const method = encodingFor(model) ? 'tiktoken' : 'heuristic'
  const memo = new WeakMap()
  const cached = (obj, fn) => {
    if (obj === null || typeof obj !== 'object') return fn(obj, model)
    if (!memo.has(obj)) memo.set(obj, fn(obj, model))
    return memo.get(obj)
  }
  return {
    /**
     * @param {Array<object>} messages
     * @param {Array<object>} [tools]
     * @returns {{ tokens: number, method: 'tiktoken'|'heuristic' }}
     */
    estimate (messages, tools) {
      let tokens = 0
      for (const m of messages ?? []) tokens += cached(m, messageTokens)
      if (tokens > 0) tokens += REPLY_PRIMING
      if (Array.isArray(tools)) for (const t of tools) tokens += cached(t, toolTokens)
      return { tokens, method }
    }
  }
}

module.exports = { countText, estimateMessages, estimateTools, createMemoEstimator, encodingFor, baseModelName }

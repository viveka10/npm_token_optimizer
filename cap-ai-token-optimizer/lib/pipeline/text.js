'use strict'
/**
 * Text helpers for the pipeline: split text into code / JSON / prose segments and
 * minify JSON without changing its value.
 */

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(.*)$/

/**
 * @typedef {{ type: 'code'|'prose', text: string, info?: string }} Segment
 */

/**
 * Split text into fenced code blocks and prose. Fence lines belong to the code segment.
 * An unclosed fence runs to the end of the text (as in CommonMark).
 * @param {string} text
 * @returns {Segment[]}
 */
function splitFences (text) {
  const lines = text.split('\n')
  const out = []
  let buf = []
  let fence = null
  const push = (type, info) => {
    if (!buf.length) return
    out.push({ type, text: buf.join('\n'), ...(info !== undefined ? { info } : {}) })
    buf = []
  }
  for (const line of lines) {
    if (!fence) {
      const m = FENCE_OPEN.exec(line)
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        push('prose')
        fence = { char: m[1][0], len: m[1].length, info: m[2].trim() }
        buf.push(line)
        continue
      }
      buf.push(line)
    } else {
      buf.push(line)
      const close = new RegExp(`^[ \\t]*${fence.char === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`)
      if (close.test(line)) {
        push('code', fence.info)
        fence = null
      }
    }
  }
  push(fence ? 'code' : 'prose', fence?.info)
  // re-joining with '\n' between segments restores the original text
  return out
}

/** Join segments produced by splitFences (or transformed copies of them). */
const joinSegments = (segments) => segments.map(s => s.text).join('\n')

/**
 * Remove insignificant whitespace from valid JSON. Works on the text, so numbers,
 * key order and duplicate keys stay exactly as written.
 * @param {string} json must already be valid JSON
 */
function minifyJson (json) {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      out += ch
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      out += ch
    }
  }
  return out
}

/**
 * Minify `text` if it is a JSON object or array; otherwise return null.
 * @param {string} text
 * @returns {string|null}
 */
function tryMinifyJson (text) {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  let parsed
  try { parsed = JSON.parse(t) } catch { return null }
  if (parsed === null || typeof parsed !== 'object') return null
  return minifyJson(t)
}

/**
 * Find the end index (exclusive) of the JSON value that starts with a bracket at `start`,
 * respecting strings. Returns -1 if the brackets never balance.
 * @param {string} text
 * @param {number} start
 */
function matchBracket (text, start) {
  const stack = []
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const open = stack.pop()
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return -1
      if (!stack.length) return i + 1
    }
  }
  return -1
}

/**
 * Split prose into JSON blocks and the text around them. A JSON block starts with `{` or `[`
 * at the beginning of a line (after indentation), ends at the end of a line, and parses
 * as a JSON object or array.
 * @param {string} text
 * @returns {Array<{ type: 'json'|'text', text: string }>}
 */
function splitJsonBlocks (text) {
  const out = []
  let last = 0
  let i = 0
  while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === '\n'
    if (lineStart) {
      let j = i
      while (text[j] === ' ' || text[j] === '\t') j++
      if (text[j] === '{' || text[j] === '[') {
        const end = matchBracket(text, j)
        if (end > 0) {
          let k = end
          while (text[k] === ' ' || text[k] === '\t' || text[k] === '\r') k++
          if (k >= text.length || text[k] === '\n') {
            const candidate = text.slice(j, end)
            if (tryMinifyJson(candidate) !== null) {
              if (j > last) out.push({ type: 'text', text: text.slice(last, j) })
              out.push({ type: 'json', text: candidate })
              last = end
              i = end
              continue
            }
          }
        }
      }
    }
    const nl = text.indexOf('\n', i)
    if (nl < 0) break
    i = nl + 1
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

module.exports = { splitFences, joinSegments, minifyJson, tryMinifyJson, splitJsonBlocks, matchBracket }

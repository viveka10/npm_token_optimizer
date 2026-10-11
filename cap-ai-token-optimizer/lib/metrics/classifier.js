'use strict'
/**
 * Failure classifier — pure function, no I/O.
 *
 * @sap-ai-sdk 2.x throws `ErrorWithCause("Request failed with status code N.")` whose `.cause`
 * is an AxiosError carrying `status`, `code`, `response.headers` and `response.data`
 * (orchestration: `{ error: { code, message, location } }`, Azure OpenAI: `{ error: { code, message, innererror } }`).
 * Deployment-resolution and OAuth failures wrap further levels of `cause`. We therefore walk the
 * whole cause chain (and AggregateError.errors) and collect every signal before deciding.
 *
 * Errors inside a stream are thrown by the SDK's SSE parser as
 * `Error("Error received from the server.\n<JSON error>")`, wrapped in
 * `ErrorWithCause("Error while iterating over SSE stream.")`; the JSON is read like a response body.
 */

const CATEGORIES = Object.freeze([
  'RATE_LIMIT', 'CONTENT_FILTER', 'CONTEXT_LENGTH', 'TIMEOUT', 'AUTH',
  'DEPLOYMENT_NOT_FOUND', 'SERVER', 'NETWORK', 'UNKNOWN'
])

const MAX_MESSAGE_LENGTH = 300
const MAX_DEPTH = 8

const RE_CONTENT_FILTER = /content[_ ]?filter|ResponsibleAIPolicyViolation|filtering module|filtered due to safety|content management policy|content_policy_violation/i
const RE_CONTEXT_LENGTH = /context_length_exceeded|maximum context length|context window|prompt is too long|input is too long|too many tokens|exceeds? the (maximum|max) (number of )?tokens|string_above_max_length/i
const RE_RATE_LIMIT = /rate[ _-]?limit|too many requests|quota exceeded/i
const RE_TIMEOUT = /timeout of \d+ms exceeded|timed? ?out|deadline exceeded/i
const RE_DEPLOYMENT = /no deployment matched|deployment not found|DeploymentNotFound|has no deployment url/i
const RE_AUTH = /unauthori[sz]ed|forbidden|invalid[_ ]client|could not fetch client credentials token/i
const RE_NETWORK = /socket hang up|network error|fetch failed|getaddrinfo|connect ECONN/i
const RE_SSE_ERROR = /^Error received from the server\.\n(\{[\s\S]*\})$/

const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ERR_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ERR_NETWORK', 'UND_ERR_SOCKET'])

/**
 * @typedef {object} ClassifiedError
 * @property {string} category one of CATEGORIES
 * @property {number|null} httpStatus
 * @property {string|null} code provider or system error code
 * @property {string} message truncated, never contains request content from us
 * @property {number|null} retryAfterMs parsed Retry-After header, if present
 */

/**
 * @param {unknown} err
 * @param {{ now?: number }} [opts] `now` makes HTTP-date Retry-After parsing deterministic in tests
 * @returns {ClassifiedError}
 */
function classifyError (err, { now = Date.now() } = {}) {
  const s = collectSignals(err)
  const status = s.statuses[0] ?? null
  const hasStatus = (pred) => s.statuses.some(pred)
  const text = s.texts.join(' | ')
  const codesText = s.codes.join(' ')

  let category = 'UNKNOWN'
  // Content-related 400s first — they are the most specific signals.
  if (RE_CONTENT_FILTER.test(codesText) || RE_CONTENT_FILTER.test(text) || s.locations.some(l => /filter/i.test(l))) {
    category = 'CONTENT_FILTER'
  } else if (RE_CONTEXT_LENGTH.test(codesText) || RE_CONTEXT_LENGTH.test(text) || hasStatus(x => x === 413)) {
    category = 'CONTEXT_LENGTH'
  } else if (hasStatus(x => x === 429) || RE_RATE_LIMIT.test(text)) {
    category = 'RATE_LIMIT'
  } else if (hasStatus(x => x === 401 || x === 403)) {
    category = 'AUTH'
  } else if (hasStatus(x => x === 404) || RE_DEPLOYMENT.test(text) || RE_DEPLOYMENT.test(codesText)) {
    category = 'DEPLOYMENT_NOT_FOUND'
  } else if (hasStatus(x => x === 408 || x === 504) || s.codes.some(c => TIMEOUT_CODES.has(c)) ||
    s.names.some(n => n === 'TimeoutError') || RE_TIMEOUT.test(text)) {
    category = 'TIMEOUT'
  } else if (hasStatus(x => x >= 500 && x <= 599)) {
    category = 'SERVER'
  } else if (s.codes.some(c => NETWORK_CODES.has(c)) || RE_NETWORK.test(text)) {
    category = 'NETWORK'
  } else if (RE_AUTH.test(text)) {
    category = 'AUTH'
  }

  return {
    category,
    httpStatus: status,
    code: s.providerCodes[0] ?? s.codes[0] ?? null,
    message: truncate(s.providerMessages[0] ?? s.texts.find(Boolean) ?? String(err ?? 'Unknown error')),
    retryAfterMs: parseRetryAfter(s.retryAfter, now)
  }
}

function collectSignals (root) {
  const s = { statuses: [], codes: [], providerCodes: [], texts: [], providerMessages: [], locations: [], names: [], retryAfter: null }
  const seen = new Set()
  const queue = [{ e: root, depth: 0 }]
  while (queue.length) {
    const { e, depth } = queue.shift()
    if (e == null || depth > MAX_DEPTH || seen.has(e)) continue
    if (typeof e !== 'object' && typeof e !== 'function') { s.texts.push(String(e)); continue }
    seen.add(e)

    pushNum(s.statuses, e.status, e.statusCode, e.httpStatus, e.response?.status)
    if (typeof e.code === 'string' && e.code) s.codes.push(e.code)
    if (typeof e.name === 'string') s.names.push(e.name)
    if (typeof e.message === 'string' && e.message) s.texts.push(e.message)
    s.retryAfter ??= header(e.response?.headers, 'retry-after') ?? header(e.headers, 'retry-after')

    const body = parseBody(e.response?.data ?? e.body ?? sseErrorBody(e.message))
    const errors = providerErrors(body)
    // a non-JSON body (e.g. a gateway's "Payload Too Large") is the most useful message we have
    if (!errors.length && typeof body?.message === 'string' && body.message) {
      s.providerMessages.push(body.message)
      s.texts.push(body.message)
    }
    for (const pe of errors) {
      if (pe.code != null) {
        const code = String(pe.code)
        s.providerCodes.push(code)
        s.codes.push(code)
        if (/^\d{3}$/.test(code)) pushNum(s.statuses, Number(code))
      }
      if (pe.innererror?.code) s.codes.push(String(pe.innererror.code))
      if (typeof pe.message === 'string') { s.providerMessages.push(pe.message); s.texts.push(pe.message) }
      if (typeof pe.location === 'string') s.locations.push(pe.location)
    }
    if (typeof body?.error_description === 'string') s.texts.push(body.error_description)

    queue.push({ e: e.cause, depth: depth + 1 })
    if (Array.isArray(e.errors)) for (const x of e.errors) queue.push({ e: x, depth: depth + 1 })
  }
  return s
}

function providerErrors (body) {
  if (!body || typeof body !== 'object') return []
  const err = body.error
  if (Array.isArray(err)) return err.filter(x => x && typeof x === 'object')
  if (err && typeof err === 'object') return [err]
  if (typeof body.code !== 'undefined' && typeof body.message === 'string') return [body]
  return []
}

/** The `{ error }` body of an error event in a stream, from the SDK's error message. */
function sseErrorBody (message) {
  const json = typeof message === 'string' ? RE_SSE_ERROR.exec(message)?.[1] : null
  if (!json) return undefined
  try { return { error: JSON.parse(json) } } catch { return undefined }
}

function parseBody (data) {
  if (typeof data === 'string') {
    try { return JSON.parse(data) } catch { return { message: data } }
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return parseBody(data.toString('utf8'))
  return data
}

function header (headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name) ?? null
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  return key ? headers[key] : null
}

function pushNum (arr, ...values) {
  for (const v of values) {
    const n = typeof v === 'string' ? Number(v) : v
    if (Number.isInteger(n) && n >= 100 && n <= 599 && !arr.includes(n)) arr.push(n)
  }
}

/**
 * @param {string|number|null} value seconds or HTTP-date
 * @param {number} now
 * @returns {number|null} milliseconds
 */
function parseRetryAfter (value, now) {
  if (value == null || value === '') return null
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000))
  const at = Date.parse(String(value))
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function truncate (msg) {
  const str = String(msg)
  return str.length > MAX_MESSAGE_LENGTH ? `${str.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : str
}

module.exports = { classifyError, parseRetryAfter, CATEGORIES }

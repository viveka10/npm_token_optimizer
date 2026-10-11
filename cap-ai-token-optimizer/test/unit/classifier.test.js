'use strict'
const { classifyError, parseRetryAfter, CATEGORIES } = require('../../lib/metrics/classifier')

// Shapes captured from @sap-ai-sdk 2.16.0 against the mock server:
// ErrorWithCause("Request failed with status code N.") -> cause: AxiosError { status, code, response }
function sdkError (status, data, { headers = {}, code } = {}) {
  const axios = Object.assign(new Error(`Request failed with status code ${status}`), {
    name: 'AxiosError',
    code: code ?? (status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST'),
    status,
    response: { status, headers, data }
  })
  return Object.assign(new Error(`Request failed with status code ${status}.`), { name: 'ErrorWithCause', cause: axios })
}
const orch = (code, location, message) => ({ error: { request_id: 'r1', code, message: `${code} - ${location}: ${message}`, location } })

describe('classifyError', () => {
  test.each([
    ['orchestration 429', sdkError(429, orch(429, 'LLM Module', 'Rate limit exceeded.'), { headers: { 'retry-after': '2' } }), 'RATE_LIMIT', 429],
    ['azure 429', sdkError(429, { error: { code: '429', message: 'Rate limit exceeded.' } }), 'RATE_LIMIT', 429],
    ['orchestration input filter', sdkError(400, orch(400, 'Filtering Module - Input Filter', 'Prompt filtered due to safety violations.')), 'CONTENT_FILTER', 400],
    ['orchestration output filter', sdkError(400, orch(400, 'Filtering Module - Output Filter', 'Content filtered.')), 'CONTENT_FILTER', 400],
    ['azure content_filter', sdkError(400, { error: { code: 'content_filter', message: 'filtered', innererror: { code: 'ResponsibleAIPolicyViolation' } } }), 'CONTENT_FILTER', 400],
    ['orchestration context length', sdkError(400, orch(400, 'LLM Module', "This model's maximum context length is 128000 tokens.")), 'CONTEXT_LENGTH', 400],
    ['azure context_length_exceeded', sdkError(400, { error: { code: 'context_length_exceeded', message: 'too long' } }), 'CONTEXT_LENGTH', 400],
    ['413 payload too large', sdkError(413, 'Payload Too Large'), 'CONTEXT_LENGTH', 413],
    ['401', sdkError(401, { error: 'unauthorized' }), 'AUTH', 401],
    ['403', sdkError(403, {}), 'AUTH', 403],
    ['404 deployment', sdkError(404, { error: { code: 'DeploymentNotFound', message: 'Deployment not found' } }), 'DEPLOYMENT_NOT_FOUND', 404],
    ['500', sdkError(500, orch(500, 'Orchestration', 'Internal server error')), 'SERVER', 500],
    ['503', sdkError(503, 'Service Unavailable'), 'SERVER', 503],
    ['504 gateway timeout', sdkError(504, ''), 'TIMEOUT', 504],
    ['400 other', sdkError(400, { error: { code: 'invalid_request', message: 'bad param' } }), 'UNKNOWN', 400]
  ])('%s -> %s', (_name, err, category, httpStatus) => {
    const c = classifyError(err)
    expect(c.category).toBe(category)
    expect(c.httpStatus).toBe(httpStatus)
    expect(CATEGORIES).toContain(c.category)
  })

  test.each([
    [{ code: 429, message: 'Rate limit exceeded' }, 'RATE_LIMIT', 429],
    [{ code: 500, message: 'Internal error', location: 'LLM Module' }, 'SERVER', 500],
    [{ code: 400, message: 'Output filtered', location: 'Filtering Module - Output Filter' }, 'CONTENT_FILTER', 400]
  ])('error event inside a stream: %j', (error, category, httpStatus) => {
    const inner = new Error(`Error received from the server.\n${JSON.stringify(error)}`)
    const err = new Error('Error while iterating over SSE stream.', { cause: inner })
    expect(classifyError(err)).toMatchObject({ category, httpStatus, message: error.message })
  })

  test('a stream error message with invalid JSON is not parsed', () => {
    const err = new Error('Error while iterating over SSE stream.', { cause: new Error('Error received from the server.\n{oops}') })
    expect(classifyError(err)).toMatchObject({ category: 'UNKNOWN', httpStatus: null })
  })

  test('axios timeout', () => {
    const axios = Object.assign(new Error('timeout of 300ms exceeded'), { name: 'AxiosError', code: 'ECONNABORTED' })
    const err = Object.assign(new Error('Request failed with status code undefined.'), { cause: axios })
    expect(classifyError(err)).toMatchObject({ category: 'TIMEOUT', httpStatus: null, code: 'ECONNABORTED' })
  })

  test('AbortSignal.timeout TimeoutError', () => {
    expect(classifyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).category).toBe('TIMEOUT')
  })

  test('connection refused wrapped in AggregateError', () => {
    const agg = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    ], '')
    agg.code = 'ECONNREFUSED'
    const err = Object.assign(new Error('Request failed with status code undefined.'), { cause: Object.assign(new Error('x'), { cause: agg }) })
    expect(classifyError(err).category).toBe('NETWORK')
  })

  test('DNS failure', () => {
    expect(classifyError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })).category).toBe('NETWORK')
  })

  test('OAuth failure deep in the cause chain', () => {
    const inner = sdkError(401, { error: 'unauthorized', error_description: 'Bad credentials' })
    const err = new Error('Could not fetch client credentials token for service of type "aicore".', { cause: inner })
    expect(classifyError(err)).toMatchObject({ category: 'AUTH', httpStatus: 401 })
  })

  test('OAuth failure by message only', () => {
    expect(classifyError(new Error('Could not fetch client credentials token for service of type "aicore".')).category).toBe('AUTH')
  })

  test('deployment resolution failure without HTTP status', () => {
    expect(classifyError(new Error('No deployment matched the given criteria: {"scenarioId":"foundation-models"}')).category).toBe('DEPLOYMENT_NOT_FOUND')
  })

  test('rate limit by message only', () => {
    expect(classifyError(new Error('Too Many Requests')).category).toBe('RATE_LIMIT')
  })

  test('statusCode / httpStatus fields and string statuses', () => {
    expect(classifyError({ statusCode: 502 }).category).toBe('SERVER')
    expect(classifyError({ httpStatus: '429' }).category).toBe('RATE_LIMIT')
  })

  test('string and Buffer response bodies', () => {
    expect(classifyError(sdkError(400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x' } }))).category).toBe('CONTEXT_LENGTH')
    expect(classifyError(sdkError(400, Buffer.from('{"error":{"code":"content_filter","message":"x"}}'))).category).toBe('CONTENT_FILTER')
    expect(classifyError(sdkError(400, 'plain text body')).message).toBe('plain text body')
  })

  test('error array bodies and top-level code/message bodies', () => {
    expect(classifyError(sdkError(400, { error: [{ code: 'content_filter', message: 'x' }] })).category).toBe('CONTENT_FILTER')
    expect(classifyError(sdkError(404, { code: '404', message: 'Deployment not found' })).code).toBe('404')
  })

  test('prefers the provider message and code', () => {
    const c = classifyError(sdkError(429, orch(429, 'LLM Module', 'Rate limit exceeded.')))
    expect(c.message).toBe('429 - LLM Module: Rate limit exceeded.')
    expect(c.code).toBe('429')
  })

  test('truncates long messages', () => {
    const c = classifyError(new Error('x'.repeat(1000)))
    expect(c.message.length).toBe(300)
    expect(c.message.endsWith('…')).toBe(true)
  })

  test('Retry-After in seconds, HTTP date and Headers objects', () => {
    expect(classifyError(sdkError(429, {}, { headers: { 'Retry-After': '3' } })).retryAfterMs).toBe(3000)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(classifyError(sdkError(429, {}, { headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' } }), { now }).retryAfterMs).toBe(5000)
    const headers = new Headers({ 'retry-after': '1' })
    expect(classifyError({ status: 429, headers }).retryAfterMs).toBe(1000)
    expect(classifyError(sdkError(500, {})).retryAfterMs).toBeNull()
  })

  test('parseRetryAfter edge cases', () => {
    expect(parseRetryAfter(null, 0)).toBeNull()
    expect(parseRetryAfter('', 0)).toBeNull()
    expect(parseRetryAfter('garbage', 0)).toBeNull()
    expect(parseRetryAfter(-5, 0)).toBe(0)
    expect(parseRetryAfter('0.5', 0)).toBe(500)
  })

  test('non-errors and cycles', () => {
    expect(classifyError(undefined)).toMatchObject({ category: 'UNKNOWN', message: 'Unknown error' })
    expect(classifyError('boom').message).toBe('boom')
    const a = new Error('a'); const b = new Error('b', { cause: a }); a.cause = b
    expect(classifyError(a).category).toBe('UNKNOWN')
  })

  test('stops at a maximum depth', () => {
    let e = Object.assign(new Error('bottom'), { status: 429 })
    for (let i = 0; i < 20; i++) e = new Error(`level ${i}`, { cause: e })
    expect(classifyError(e).category).toBe('UNKNOWN')
  })
})

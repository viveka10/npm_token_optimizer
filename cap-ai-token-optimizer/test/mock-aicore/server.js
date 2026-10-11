'use strict'
/**
 * Mock SAP AI Core server for tests and local development.
 *
 * Mimics the endpoints used by @sap-ai-sdk/* 2.x:
 *   POST /oauth/token                                     (XSUAA client credentials)
 *   GET  /v2/lm/deployments[/:id]                         (deployment resolution)
 *   POST /v2/inference/deployments/:id/v2/completion      (orchestration)
 *   POST /v2/inference/deployments/:id/chat/completions   (foundation-models, Azure OpenAI)
 *
 * Streaming requests (orchestration `config.stream.enabled`, chat completions `stream: true`)
 * are answered as server-sent events, with token usage in the last chunk.
 *
 * Scenario selection, highest precedence first:
 *   1. request header   `x-mock-scenario: rate_limit`
 *   2. a marker in any message content `[[mock:rate_limit]]`
 *   3. the server default, set via `setScenario()` or `POST /__mock/scenario`
 *
 * Scenarios: ok | rate_limit | content_filter | context_length | server_error | slow | not_found | auth
 *            | stream_error (streams fail after the first chunk; other calls answer normally)
 *
 * Run standalone: `node test/mock-aicore/server.js` – prints the AICORE_SERVICE_KEY to use.
 */
const express = require('express')

const SCENARIOS = ['ok', 'rate_limit', 'content_filter', 'context_length', 'server_error', 'slow', 'not_found', 'auth', 'stream_error']
const MARKER = /\[\[mock:([a-z_]+)\]\]/

const DEPLOYMENTS = [
  { id: 'd-orch', scenarioId: 'orchestration', executableId: 'orchestration', model: null },
  { id: 'd-gpt41', scenarioId: 'foundation-models', executableId: 'azure-openai', model: { name: 'gpt-4.1', version: 'latest' } },
  { id: 'd-gpt41-mini', scenarioId: 'foundation-models', executableId: 'azure-openai', model: { name: 'gpt-4.1-mini', version: 'latest' } }
]

function serviceKey (baseUrl) {
  return {
    clientid: 'mock-client-id',
    clientsecret: 'mock-client-secret',
    url: baseUrl,
    identityzone: 'mock',
    identityzoneid: 'mock-zone',
    appname: 'mock-aicore',
    serviceurls: { AI_API_URL: baseUrl }
  }
}

function contentToText (content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join(' ')
  return ''
}

/** Collect every message in an orchestration or chat-completions body. */
function collectMessages (body) {
  if (!body || typeof body !== 'object') return []
  if (Array.isArray(body.messages)) return body.messages
  const modules = body.config?.modules
  const first = Array.isArray(modules) ? modules[0] : modules
  // orchestration places messages_history before the (template + request) messages
  return [
    ...(body.messages_history ?? []),
    ...(first?.prompt_templating?.prompt?.template ?? []),
    ...(body.messages ?? [])
  ]
}

function orchestrationModel (body) {
  const modules = body?.config?.modules
  const first = Array.isArray(modules) ? modules[0] : modules
  return first?.prompt_templating?.model?.name ?? 'unknown'
}

function roughTokens (text) {
  return Math.max(1, Math.ceil(text.length / 4))
}

function createMockAiCore (options = {}) {
  const state = {
    scenario: 'ok',
    delayMs: options.delayMs ?? 3000,
    retryAfterSeconds: options.retryAfterSeconds ?? 1,
    cachedTokens: 0,
    answer: null,
    requests: [],
    tokenRequests: 0
  }
  let server = null
  let baseUrl = null

  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use(express.urlencoded({ extended: false }))

  const scenarioFor = (req) => {
    const header = req.get('x-mock-scenario')
    if (header && SCENARIOS.includes(header)) return header
    for (const m of collectMessages(req.body)) {
      const hit = MARKER.exec(contentToText(m?.content))
      if (hit && SCENARIOS.includes(hit[1])) return hit[1]
    }
    return state.scenario
  }

  // --- control API --------------------------------------------------------
  app.post('/__mock/scenario', (req, res) => {
    Object.assign(state, pick(req.body, ['scenario', 'delayMs', 'retryAfterSeconds', 'cachedTokens', 'answer']))
    res.json({ scenario: state.scenario })
  })
  app.get('/__mock/requests', (req, res) => res.json(state.requests))
  app.delete('/__mock/requests', (req, res) => { state.requests.length = 0; res.status(204).end() })

  // --- OAuth --------------------------------------------------------------
  app.post('/oauth/token', (req, res) => {
    state.tokenRequests++
    if (state.scenario === 'auth') {
      return res.status(401).json({ error: 'unauthorized', error_description: 'Bad credentials' })
    }
    res.json({ access_token: mockJwt(baseUrl), token_type: 'bearer', expires_in: 3600, scope: 'mock', jti: 'mock' })
  })

  // --- deployments ----------------------------------------------------------
  const deploymentJson = (d) => ({
    id: d.id,
    deploymentUrl: `${baseUrl}/v2/inference/deployments/${d.id}`,
    configurationId: `cfg-${d.id}`,
    configurationName: `cfg-${d.id}`,
    scenarioId: d.scenarioId,
    executableId: d.executableId,
    status: 'RUNNING',
    targetStatus: 'RUNNING',
    createdAt: '2026-01-01T00:00:00Z',
    modifiedAt: '2026-01-01T00:00:00Z',
    details: { resources: { backendDetails: d.model ? { model: d.model } : {} } }
  })
  app.get('/v2/lm/deployments', (req, res) => {
    const { scenarioId, executableIds } = req.query
    const exec = executableIds ? String(executableIds).split(',') : null
    const resources = DEPLOYMENTS
      .filter(d => !scenarioId || d.scenarioId === scenarioId)
      .filter(d => !exec || exec.includes(d.executableId))
      .map(deploymentJson)
    res.json({ count: resources.length, resources })
  })
  app.get('/v2/lm/deployments/:id', (req, res) => {
    const d = DEPLOYMENTS.find(x => x.id === req.params.id)
    if (!d) return res.status(404).json({ code: '404', message: 'Deployment not found' })
    res.json(deploymentJson(d))
  })

  // --- inference ------------------------------------------------------------
  const handleInference = (kind) => async (req, res) => {
    const scenario = scenarioFor(req)
    state.requests.push({
      kind,
      scenario,
      deploymentId: req.params.id,
      path: req.path,
      headers: pick(req.headers, ['ai-resource-group', 'ai-client-type', 'x-mock-scenario']),
      body: req.body,
      at: Date.now()
    })
    if (!DEPLOYMENTS.some(d => d.id === req.params.id) || scenario === 'not_found') {
      return res.status(404).json(errorBody(kind, 404, 'Deployment not found', 'Request Handler', 'DeploymentNotFound'))
    }
    switch (scenario) {
      case 'rate_limit':
        res.set('Retry-After', String(state.retryAfterSeconds))
        return res.status(429).json(errorBody(kind, 429, 'Rate limit exceeded. Please retry after some time.', 'LLM Module', '429'))
      case 'content_filter':
        return res.status(400).json(kind === 'orchestration'
          ? errorBody(kind, 400, 'Prompt filtered due to safety violations. Please modify the prompt and try again.', 'Filtering Module - Input Filter')
          : { error: { code: 'content_filter', message: 'The response was filtered due to the prompt triggering Azure OpenAI\'s content management policy.', innererror: { code: 'ResponsibleAIPolicyViolation' } } })
      case 'context_length':
        return res.status(400).json(kind === 'orchestration'
          ? errorBody(kind, 400, 'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.', 'LLM Module')
          : { error: { code: 'context_length_exceeded', message: 'This model\'s maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.' } })
      case 'server_error':
        return res.status(500).json(errorBody(kind, 500, 'Internal server error', 'Orchestration'))
      case 'slow':
        // stop waiting as soon as the client gives up, so no timer outlives the test
        await new Promise(resolve => {
          const timer = setTimeout(resolve, state.delayMs)
          res.on('close', () => { clearTimeout(timer); resolve() })
        })
        if (res.destroyed || req.socket.destroyed || res.writableEnded) return
        break
    }
    const response = kind === 'orchestration' ? orchestrationResponse(req.body) : chatResponse(req.body, req.params.id)
    if (isStreamRequest(kind, req.body)) return sendStream(res, kind, response, scenario === 'stream_error')
    res.json(response)
  }

  const isStreamRequest = (kind, body) => kind === 'orchestration' ? body?.config?.stream?.enabled === true : body?.stream === true

  /**
   * Send a complete response as server-sent events: the answer in two content deltas, the
   * finish reason in the second, and the usage in the last chunk (orchestration: with the
   * second delta, chat completions: a separate chunk without choices, as with
   * `stream_options.include_usage`). With `fail`, an error event follows the first chunk.
   */
  const sendStream = (res, kind, response, fail) => {
    const llm = kind === 'orchestration' ? response.final_result : response
    const content = llm.choices[0].message.content
    const half = Math.ceil(content.length / 2)
    const base = { id: llm.id, object: 'chat.completion.chunk', created: llm.created, model: llm.model }
    const delta = (text, finish, extra = {}) => ({
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finish }],
      ...extra
    })
    const chunks = kind === 'orchestration'
      ? [delta(content.slice(0, half), null), delta(content.slice(half), 'stop', { usage: llm.usage })]
        .map(final => ({ request_id: response.request_id, intermediate_results: {}, final_result: final }))
      : [delta(content.slice(0, half), null), delta(content.slice(half), 'stop'), { ...base, choices: [], usage: llm.usage }]
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (data) => res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    if (fail) {
      send(chunks[0])
      send({ error: { code: 500, message: 'Mock: stream interrupted' } })
      return res.end()
    }
    for (const chunk of chunks) send(chunk)
    send('[DONE]')
    res.end()
  }

  const usageFor = (messages, completion) => {
    const prompt = roughTokens(messages.map(m => contentToText(m?.content)).join('\n'))
    const completionTokens = roughTokens(completion)
    return {
      prompt_tokens: prompt,
      completion_tokens: completionTokens,
      total_tokens: prompt + completionTokens,
      prompt_tokens_details: { cached_tokens: Math.min(state.cachedTokens, prompt) }
    }
  }

  const answerFor = (messages) => {
    if (state.answer) return state.answer
    const lastUser = [...messages].reverse().find(m => m?.role === 'user')
    return `Mock answer (${messages.length} messages): ${contentToText(lastUser?.content).slice(0, 40)}`
  }

  const orchestrationResponse = (body) => {
    const messages = collectMessages(body)
    const content = answerFor(messages)
    const llm = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: orchestrationModel(body),
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: usageFor(messages, content)
    }
    return { request_id: `req-${state.requests.length}`, intermediate_results: { templating: messages, llm }, final_result: llm }
  }

  const chatResponse = (body, deploymentId) => {
    const messages = collectMessages(body)
    const content = answerFor(messages)
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: DEPLOYMENTS.find(d => d.id === deploymentId)?.model?.name ?? 'unknown',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: usageFor(messages, content)
    }
  }

  app.post('/v2/inference/deployments/:id/v2/completion', handleInference('orchestration'))
  app.post('/v2/inference/deployments/:id/chat/completions', handleInference('chat'))

  app.use((req, res) => res.status(404).json({ error: { code: 404, message: `Mock: no route for ${req.method} ${req.path}` } }))

  return {
    app,
    state,
    get url () { return baseUrl },
    get serviceKey () { return serviceKey(baseUrl) },
    /** @param {string} name @param {object} [opts] */
    setScenario (name, opts = {}) {
      if (!SCENARIOS.includes(name)) throw new Error(`Unknown mock scenario: ${name}`)
      Object.assign(state, opts, { scenario: name })
    },
    reset () {
      Object.assign(state, { scenario: 'ok', cachedTokens: 0, answer: null, tokenRequests: 0 })
      state.requests.length = 0
    },
    start (port = options.port ?? 0) {
      return new Promise((resolve, reject) => {
        server = app.listen(port, '127.0.0.1', err => {
          if (err) return reject(err)
          baseUrl = `http://localhost:${server.address().port}`
          resolve(baseUrl)
        })
      })
    },
    stop () {
      if (!server) return Promise.resolve()
      server.closeAllConnections?.()
      return new Promise(resolve => server.close(() => resolve()))
    }
  }
}

function errorBody (kind, code, message, location, errCode) {
  if (kind === 'orchestration') {
    return { error: { request_id: 'req-mock-error', code, message: `${code} - ${location}: ${message}`, location } }
  }
  return { error: { code: errCode ?? String(code), message } }
}

/** Unsigned JWT – the Cloud SDK decodes (but does not verify) client-credentials tokens. */
function mockJwt (issuer) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  return [
    b64({ alg: 'none', typ: 'JWT' }),
    b64({ iss: `${issuer}/oauth/token`, zid: 'mock-zone', client_id: 'mock-client-id', iat: now, exp: now + 3600, scope: ['mock'] }),
    'mock-signature'
  ].join('.')
}

function pick (obj, keys) {
  const out = {}
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k]
  return out
}

module.exports = { createMockAiCore, serviceKey, SCENARIOS }

if (require.main === module) {
  const mock = createMockAiCore()
  mock.start(Number(process.env.MOCK_AICORE_PORT ?? 8811)).then(url => {
    console.log(`Mock AI Core listening on ${url}`)
    console.log(`export AICORE_SERVICE_KEY='${JSON.stringify(mock.serviceKey)}'`)
  })
}

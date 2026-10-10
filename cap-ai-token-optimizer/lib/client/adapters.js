'use strict'
/**
 * SDK adapters: read a call's messages, tools and params from each supported
 * @sap-ai-sdk client method, and build the (optimized) call to send. Verified against
 * @sap-ai-sdk/* 2.16.0:
 *
 *   OrchestrationClient.chatCompletion(request?, requestConfig?)
 *   OrchestrationClient.stream(request?, signal?, options?, requestConfig?)
 *   AzureOpenAiChatClient.run(request, requestConfig?)
 *   AzureOpenAiChatClient.stream(request, signal?, requestConfig?)
 *
 * OrchestrationClient fixes model, params and tools at construction time and keeps them in
 * its (TypeScript-private, runtime-visible) `config`, `deploymentConfig` and `destination`
 * fields. When the pipeline changes tools or params, we construct a sibling client with a
 * modified copy of the config, so the caller's client is never mutated and concurrent calls
 * stay independent. The parsed config is accepted again by the constructor.
 */
const { ORIGIN, tag, untag } = require('../pipeline/messages')
const { stableStringify, sha256 } = require('../util/hash')
const { loadPeer } = require('../util/peer')

/**
 * @typedef {object} CallInfo
 * @property {string|null} model
 * @property {string|null} deploymentId
 * @property {string|null} resourceGroup
 * @property {Array<object>} messages all messages that reach the model, in order, tagged with their origin
 * @property {Array<object>|undefined} tools
 * @property {object} params model parameters (max_tokens, temperature, …)
 * @property {{ tools: boolean, params: boolean }} editable whether tools / params can be changed per call
 */

const DERIVED_CLIENTS_PER_CLIENT = 32
const derivedClients = new WeakMap()

const sameJson = (a, b) => stableStringify(a) === stableStringify(b)
const byOrigin = (messages, ...origins) => messages.filter(m => origins.includes(m[ORIGIN])).map(untag)

const orchestration = {
  sdk: 'orchestration',
  /** method name → { operation, requestConfigIndex } */
  methods: {
    chatCompletion: { operation: 'chat', requestConfigIndex: 1 },
    stream: { operation: 'stream', requestConfigIndex: 3 }
  },
  matches: (client) => typeof client?.chatCompletion === 'function',

  /** @returns {CallInfo} */
  extract (client, args) {
    const request = args[0] ?? {}
    const config = client.config
    const module = firstModuleConfig(config)
    const tpl = module?.promptTemplating
    const template = Array.isArray(tpl?.prompt?.template) ? tpl.prompt.template : []
    const dc = client.deploymentConfig ?? {}
    // only a single inline module config of a real client class can be modified per call
    const single = isInlineConfig(config) && canDerive(client)
    return {
      model: tpl?.model?.name ?? null,
      deploymentId: dc.deploymentId ?? null,
      resourceGroup: dc.resourceGroup ?? null,
      // orchestration sends messages_history first, then template + request messages
      messages: [
        ...(request.messagesHistory ?? []).map(m => tag(m, 'history')),
        ...template.map(m => tag(m, 'template')),
        ...(request.messages ?? []).map(m => tag(m, 'request'))
      ],
      tools: tpl?.prompt?.tools,
      params: tpl?.model?.params ?? {},
      editable: { tools: single, params: single }
    }
  },

  /**
   * Build the call that sends `result` (the pipeline output).
   * @returns {{ client: object, args: any[], keyMaterial: object }}
   */
  apply (client, args, info, result) {
    const request = args[0] ?? {}
    const nextRequest = { ...request }
    const history = byOrigin(result.messages, 'history')
    const messages = result.messages.filter(m => m[ORIGIN] !== 'history' && m[ORIGIN] !== 'template').map(untag)
    if (history.length) nextRequest.messagesHistory = history
    else delete nextRequest.messagesHistory
    if (messages.length || request.messages) nextRequest.messages = messages

    let target = client
    let config = client.config
    const toolsChanged = !sameJson(result.tools, info.tools)
    const paramsChanged = !sameJson(result.params, info.params)
    if ((toolsChanged || paramsChanged) && isInlineConfig(config) && canDerive(client)) {
      const pt = config.promptTemplating
      const prompt = { ...(pt.prompt ?? {}) }
      if (result.tools?.length) prompt.tools = result.tools
      else delete prompt.tools
      config = { ...config, promptTemplating: { ...pt, model: { ...pt.model, params: result.params }, prompt } }
      target = derivedClient(client, config)
    }
    return {
      client: target,
      args: [nextRequest, ...args.slice(1)],
      keyMaterial: { sdk: 'orchestration', deployment: client.deploymentConfig ?? null, destination: destinationId(client.destination), config, request: nextRequest }
    }
  },

  responseClass: () => loadPeer('@sap-ai-sdk/orchestration', 'the response cache').OrchestrationResponse
}

const foundationModels = {
  sdk: 'foundation-models',
  methods: {
    run: { operation: 'chat', requestConfigIndex: 1 },
    stream: { operation: 'stream', requestConfigIndex: 2 }
  },
  matches: (client) => typeof client?.run === 'function' && 'modelDeployment' in client,

  /** @returns {CallInfo} */
  extract (client, args) {
    const request = args[0] ?? {}
    const md = client.modelDeployment
    const { messages, tools, ...params } = request
    return {
      model: typeof md === 'string' ? md : (md?.modelName ?? null),
      deploymentId: typeof md === 'object' ? (md?.deploymentId ?? null) : null,
      resourceGroup: typeof md === 'object' ? (md?.resourceGroup ?? null) : null,
      messages: (messages ?? []).map(m => tag(m, 'request')),
      tools,
      params,
      editable: { tools: true, params: true }
    }
  },

  apply (client, args, info, result) {
    const request = args[0] ?? {}
    const { messages: _m, tools: _t, ...rest } = request
    const nextRequest = { ...rest, ...result.params, messages: result.messages.map(untag) }
    if (result.tools?.length || 'tools' in request) nextRequest.tools = result.tools
    if (nextRequest.tools === undefined) delete nextRequest.tools
    return {
      client,
      args: [nextRequest, ...args.slice(1)],
      keyMaterial: { sdk: 'foundation-models', deployment: client.modelDeployment ?? null, destination: destinationId(client.destination), request: nextRequest }
    }
  },

  responseClass: () => loadPeer('@sap-ai-sdk/foundation-models', 'the response cache').AzureOpenAiChatCompletionResponse
}

const ADAPTERS = [orchestration, foundationModels]

/** @param {object} client */
function detectAdapter (client) {
  return ADAPTERS.find(a => a.matches(client)) ?? null
}

/**
 * A sibling of `client` built with `config`. Reused per (client, config) so repeated calls
 * with the same optimized config don't construct new clients.
 */
function derivedClient (client, config) {
  let byConfig = derivedClients.get(client)
  if (!byConfig) { byConfig = new Map(); derivedClients.set(client, byConfig) }
  const key = sha256(stableStringify(config))
  let derived = byConfig.get(key)
  if (!derived) {
    const Ctor = client.constructor
    derived = new Ctor(config, client.deploymentConfig, client.destination)
    byConfig.set(key, derived)
    if (byConfig.size > DERIVED_CLIENTS_PER_CLIENT) byConfig.delete(byConfig.keys().next().value)
  }
  return derived
}

/** Identify a destination for the cache key without including credentials. */
function destinationId (destination) {
  if (!destination || typeof destination !== 'object') return null
  return destination.destinationName ?? destination.name ?? destination.url ?? null
}

const canDerive = (client) => typeof client?.constructor === 'function' && client.constructor !== Object

const isInlineConfig = (config) => !!config && typeof config === 'object' && !Array.isArray(config) && !!config.promptTemplating

/**
 * Return a copy of `args` whose requestConfig carries `timeout`, unless the caller set one.
 * @param {any[]} args
 * @param {number} index position of requestConfig
 * @param {number|null} timeoutMs
 */
function withTimeout (args, index, timeoutMs) {
  if (!(timeoutMs > 0)) return args
  const current = args[index]
  if (current?.timeout != null) return args
  const next = [...args]
  while (next.length < index) next.push(undefined)
  next[index] = { ...(current ?? {}), timeout: timeoutMs }
  return next
}

/**
 * The orchestration config may be an object, a module-fallback list, a JSON string or a
 * stored-config reference. Return the first inline module config, if any.
 */
function firstModuleConfig (config) {
  if (Array.isArray(config)) return config[0]
  if (config && typeof config === 'object' && config.promptTemplating) return config
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config)
      const modules = parsed?.config?.modules ?? parsed?.modules
      const first = Array.isArray(modules) ? modules[0] : modules
      const pt = first?.prompt_templating
      return pt ? { promptTemplating: { model: pt.model, prompt: pt.prompt } } : null
    } catch { return null }
  }
  return null
}

const CACHED_HEADERS = ['x-aicore-request-id']

/**
 * Plain-JSON form of an SDK response for the cache, or null if it has no data.
 * @param {string} sdk
 * @param {any} response
 */
function serializeResponse (sdk, response) {
  const data = response?._data ?? response?.rawResponse?.data
  if (!data || typeof data !== 'object') return null
  const headers = {}
  const raw = response.rawResponse?.headers ?? {}
  for (const name of CACHED_HEADERS) if (raw[name] != null) headers[name] = String(raw[name])
  return structuredClone({ sdk, data, headers })
}

const responseClasses = new Map()

/** Remember the response class of a live response, so cached entries can be rebuilt. */
function rememberResponseClass (sdk, response) {
  if (response && typeof response.constructor === 'function' && response.constructor !== Object) {
    responseClasses.set(sdk, response.constructor)
  }
}

/**
 * Rebuild an SDK response object from a cache entry. Each call gets its own copy.
 * @param {{ sdk: string, data: object, headers: object }} entry
 */
function rehydrateResponse (entry) {
  const adapter = ADAPTERS.find(a => a.sdk === entry.sdk)
  const Cls = responseClasses.get(entry.sdk) ?? adapter.responseClass()
  return new Cls({ data: structuredClone(entry.data), headers: { ...entry.headers }, status: 200 })
}

module.exports = {
  orchestration,
  foundationModels,
  detectAdapter,
  withTimeout,
  firstModuleConfig,
  serializeResponse,
  rememberResponseClass,
  rehydrateResponse
}

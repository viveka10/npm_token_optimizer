'use strict'
/**
 * TokenOptimizer: wraps @sap-ai-sdk clients, optimizes prompts, measures every call and reports it.
 *
 * Modes:
 *  - active: send the optimized request; serve exact-match cache hits without calling AI Core.
 *  - shadow: run the pipeline and cache lookup, record what would have been saved, but send
 *            the original request (and never serve from cache).
 *  - off:    no optimization and no cache; calls are still measured.
 *
 * Rule: nothing the optimizer does may break the AI call. If the pipeline fails, the original
 * request is sent. Only errors thrown by the SDK itself reach the caller, unchanged.
 *
 * Streaming calls are recorded when the caller has read the stream to the end, so the event
 * has AI Core's token usage, finish reason and the full latency. A stream that fails, is
 * closed early or is not read within STREAM_RECORD_TIMEOUT_MS is recorded at that point.
 */
const { resolveConfig, forUseCase } = require('./config')
const { MetricsCollector } = require('./metrics/collector')
const { buildEvent, estimateCost, usageToTokens, cdsContextInfo } = require('./metrics/events')
const { classifyError } = require('./metrics/classifier')
const { createExporters } = require('./exporters')
const { estimateMessages } = require('./tokens/estimator')
const { fingerprint, sha256, stableStringify } = require('./util/hash')
const { detectAdapter, withTimeout, serializeResponse, rememberResponseClass, rehydrateResponse } = require('./client/adapters')
const { runPipeline } = require('./pipeline')
const { untag, isSystem } = require('./pipeline/messages')
const { MemoryCacheStore, cacheKey, isCacheable } = require('./cache')
const { loadPeer } = require('./util/peer')
const instrument = require('./client/instrument')
const log = require('./util/log')

const WRAPPED = Symbol.for('cap-ai-token-optimizer.wrapped')
const LANGCHAIN_WRAPPED = Symbol.for('cap-ai-token-optimizer.langchain')
const MAX_PREFIXES = 1000
const ADVISORY_LOG_INTERVAL_MS = 10 * 60 * 1000
const STREAM_RECORD_TIMEOUT_MS = 10 * 60 * 1000

class TokenOptimizer {
  /**
   * @param {object|boolean} [config] user configuration (same shape as cds.requires.tokenOptimizer)
   * @param {object} [deps] injectable dependencies (exporter options, sleep) for tests
   */
  constructor (config, deps = {}) {
    this.collector = new MetricsCollector()
    this._deps = deps
    this._sleep = deps.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
    this._streamRecordTimeoutMs = deps.streamRecordTimeoutMs ?? STREAM_RECORD_TIMEOUT_MS
    this._configured = false
    this.cache = null
    // last prompt prefix (system + tools) per use case and model, for the prompt-caching advisory
    this._prefixes = new Map()
    if (config !== undefined) this.configure(config)
    else this.config = resolveConfig(undefined, log)
  }

  /**
   * (Re)configure: resolve config, replace exporters and cache store, restart the flush timer.
   * Existing exporters are shut down (flushed) in the background.
   * @param {object|boolean} [config]
   */
  configure (config) {
    const previous = this.collector.exporters
    this.config = resolveConfig(config, log)
    this.collector.exporters = []
    if (previous.length) {
      Promise.all(previous.map(x => Promise.resolve().then(() => x.shutdown?.()).catch(() => {}))).catch(() => {})
    }
    for (const exporter of createExporters(this.config, this._deps)) this.collector.addExporter(exporter)
    this.cache = this.config.cache.store ?? new MemoryCacheStore({ maxEntries: this.config.cache.maxEntries })
    this.collector.stop()
    this.collector.start(this.config.metrics.flushIntervalMs)
    this._configured = true
    try {
      const auto = this.config.autoInstrument
      if (auto?.enabled) instrument.enableAuto(this, { useCase: auto.useCase })
      else instrument.disableAuto(this)
    } catch (e) {
      log.warn('autoInstrument could not be set up:', e?.message)
    }
    return this
  }

  /**
   * Run `fn` so that @sap-ai-sdk calls made inside it (by any client, also ones created by
   * libraries) are optimized and measured with `useCase`.
   * @template T
   * @param {string} useCase
   * @param {() => T} fn
   * @param {{ cdsService?: string }} [opts]
   * @returns {T}
   */
  withUseCase (useCase, fn, opts = {}) {
    this._ensureConfigured()
    return instrument.runInScope(this, { ...opts, useCase }, fn)
  }

  /**
   * Instrument a LangChain chat model from @sap-ai-sdk/langchain (OrchestrationClient,
   * AzureOpenAiChatClient). The model is returned with the same API; its AI Core calls
   * (invoke, batch, stream, bound tools, structured output) are optimized and measured.
   * @template T
   * @param {T} model
   * @param {{ useCase?: string, cdsService?: string }} [opts]
   * @returns {T}
   */
  wrapLangChain (model, opts = {}) {
    if (model?.[LANGCHAIN_WRAPPED]) return model
    if (typeof model?._generate !== 'function') {
      throw new TypeError('optimizer.wrapLangChain(): expected a LangChain chat model from @sap-ai-sdk/langchain')
    }
    this._ensureConfigured()
    const self = this
    const generate = model._generate
    model._generate = function (...args) {
      return instrument.runInScope(self, opts, () => generate.apply(this, args))
    }
    const stream = model._streamResponseChunks
    if (typeof stream === 'function') {
      // generator bodies run in the context of each next() call, so scope every step
      model._streamResponseChunks = async function * (...args) {
        const it = stream.apply(this, args)
        try {
          for (;;) {
            const r = await instrument.runInScope(self, opts, () => it.next())
            if (r.done) return r.value
            yield r.value
          }
        } finally {
          await it.return?.()
        }
      }
    }
    Object.defineProperty(model, LANGCHAIN_WRAPPED, { value: true })
    return model
  }

  /** Configure from cds.env on first use, if configure() was never called. */
  _ensureConfigured () {
    if (this._configured) return
    let cfg
    try { cfg = globalThis.cds?.env?.requires?.tokenOptimizer } catch { /* cds.env not ready */ }
    this.configure(cfg)
  }

  /**
   * Wrap an SDK client. The returned object has the same API as the client; supported
   * methods (OrchestrationClient.chatCompletion/stream, AzureOpenAiChatClient.run/stream)
   * are optimized and measured, everything else is forwarded untouched.
   * @template T
   * @param {T} client
   * @param {{ useCase?: string, cdsService?: string }} [opts]
   * @returns {T}
   */
  wrap (client, opts = {}) {
    if (client && client[WRAPPED]) return client
    const adapter = detectAdapter(client)
    if (!adapter) {
      throw new TypeError('optimizer.wrap(): unsupported client. Expected an OrchestrationClient or AzureOpenAiChatClient from @sap-ai-sdk.')
    }
    const self = this
    const cache = new Map()
    return new Proxy(client, {
      get (target, prop) {
        if (prop === WRAPPED) return true
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        if (cache.has(prop)) return cache.get(prop)
        const method = Object.hasOwn(adapter.methods, prop) ? adapter.methods[prop] : null
        const fn = method
          ? (...args) => self._call({ adapter, method, methodName: prop, client: target, args, opts })
          : value.bind(target)
        cache.set(prop, fn)
        return fn
      }
    })
  }

  /**
   * Explicit call without creating a client yourself.
   * Uses the orchestration service by default, or foundation models with `sdk: 'foundation-models'`.
   * @param {import('../index').ChatOptions} opts
   * @returns {Promise<import('../index').ChatResult>}
   */
  async chat (opts = {}) {
    const { useCase, cdsService, sdk = 'orchestration', model, messages, tools, maxTokens, temperature, params = {}, deploymentId, resourceGroup, requestConfig } = opts
    if (!model && !deploymentId) throw new TypeError('optimizer.chat(): `model` is required')
    if (!Array.isArray(messages) || !messages.length) throw new TypeError('optimizer.chat(): `messages` must be a non-empty array')
    const modelParams = { ...params }
    if (maxTokens != null) modelParams.max_tokens = maxTokens
    if (temperature != null) modelParams.temperature = temperature

    let client, response
    if (sdk === 'foundation-models') {
      const { AzureOpenAiChatClient } = loadPeer('@sap-ai-sdk/foundation-models', 'optimizer.chat({ sdk: "foundation-models" })')
      const deployment = deploymentId ? { deploymentId, resourceGroup } : { modelName: model, resourceGroup }
      client = this.wrap(new AzureOpenAiChatClient(deployment), { useCase, cdsService })
      response = await client.run({ messages, ...(tools?.length ? { tools } : {}), ...modelParams }, requestConfig)
    } else if (sdk === 'orchestration') {
      const { OrchestrationClient } = loadPeer('@sap-ai-sdk/orchestration', 'optimizer.chat()')
      const promptTemplating = { model: { name: model, params: modelParams }, ...(tools?.length ? { prompt: { tools } } : {}) }
      const deployment = deploymentId ? { deploymentId, resourceGroup } : (resourceGroup ? { resourceGroup } : undefined)
      client = this.wrap(new OrchestrationClient({ promptTemplating }, deployment), { useCase, cdsService })
      response = await client.chatCompletion({ messages }, requestConfig)
    } else {
      throw new TypeError(`optimizer.chat(): unknown sdk "${sdk}". Use "orchestration" or "foundation-models".`)
    }
    return {
      content: safe(() => response.getContent()) ?? null,
      toolCalls: safe(() => response.getToolCalls()) ?? null,
      finishReason: safe(() => response.getFinishReason()) ?? null,
      usage: safe(() => response.getTokenUsage()) ?? null,
      response
    }
  }

  /** Aggregated in-memory stats. */
  stats () { return this.collector.stats() }

  /** Subscribe to events: 'call' (one per AI call). */
  on (type, listener) { this.collector.on(type, listener); return this }
  off (type, listener) { this.collector.off(type, listener); return this }
  once (type, listener) { this.collector.once(type, listener); return this }

  /** Flush buffering exporters. Never rejects. */
  flush () { return this.collector.flush() }

  /** Stop timers, flush and shut down exporters. Never rejects. */
  shutdown () { return this.collector.shutdown() }

  /** Clear in-memory stats. */
  resetStats () { this.collector.reset() }

  /** Optimize, send and measure one SDK call. */
  async _call ({ adapter, method, methodName, client, args, opts }) {
    this._ensureConfigured()
    const started = performance.now()
    const ctx = await this._prepare({ adapter, method, client, args, opts })
    const cfg = ctx.cfg
    // what we send: the optimized call in active mode, otherwise the original
    const plan = cfg.mode === 'active' && ctx.optimized ? ctx.optimized : { client, args }

    if (ctx.cacheKey) {
      const entry = await this._cacheGet(ctx.cacheKey)
      if (entry) {
        const response = cfg.mode === 'active' ? safe(() => rehydrateResponse(entry), (e) => log.warn('could not rebuild cached response:', e?.message)) : null
        if (response) {
          safe(() => this._record(ctx, { started, retries: 0, response, cacheEntry: entry }), logRecordError)
          return response
        }
        if (cfg.mode === 'shadow') ctx.wouldHitCache = entry
      }
    }

    const callArgs = safe(() => withTimeout(plan.args, method.requestConfigIndex, cfg.timeoutMs)) ?? plan.args
    let retries = 0
    for (;;) {
      try {
        // the original method: a hooked one would route the call through an optimizer again
        const response = await instrument.originalOf(plan.client[methodName]).apply(plan.client, callArgs)
        if (ctx.cacheKey) this._cacheSet(ctx, response)
        if (method.operation === 'stream' && safe(() => this._trackStream(ctx, { started, retries, response }), logRecordError)) return response
        safe(() => this._record(ctx, { started, retries, response }), logRecordError)
        return response
      } catch (err) {
        const classified = safe(() => classifyError(err)) ?? unknownError(err)
        const delay = this._retryDelay(cfg, classified, retries)
        if (delay != null) {
          retries++
          log.debug(`retrying after ${classified.category} in ${delay}ms (attempt ${retries})`)
          await this._sleep(delay)
          continue
        }
        safe(() => this._record(ctx, { started, retries, error: classified }), logRecordError)
        throw err
      }
    }
  }

  /**
   * Record a streaming call when its stream ends: replaces `response.stream` with a stream of
   * the same class that passes every chunk through unchanged and records the event once, when
   * the stream is read to the end (with AI Core's usage), fails (the error is classified and
   * rethrown), is closed early by the caller, or is not read within the record timeout.
   * @returns {boolean} false if the stream can't be tracked; the caller then records right away
   */
  _trackStream (ctx, { started, retries, response }) {
    const original = response?.stream
    const Stream = original?.constructor
    if (typeof original?.[Symbol.asyncIterator] !== 'function' || typeof Stream !== 'function' || Stream === Object) return false

    let recorded = false
    const record = (outcome = {}) => {
      if (recorded) return
      recorded = true
      clearTimeout(timer)
      safe(() => this._record(ctx, { started, retries, response, ...outcome }), logRecordError)
    }
    const timer = setTimeout(() => record({ note: 'stream: not read to the end within the record timeout' }), this._streamRecordTimeoutMs)
    timer.unref?.()

    async function * tracked () {
      let ended = false
      try {
        for await (const chunk of original) yield chunk
        ended = true
      } catch (err) {
        record({ error: safe(() => classifyError(err)) ?? unknownError(err) })
        throw err
      } finally {
        record(ended ? {} : { note: 'stream: closed by the caller before the end' })
      }
    }
    response.stream = new Stream(() => tracked(), original.controller)
    return true
  }

  /**
   * Everything known before the call: call info, estimates, pipeline result and cache key.
   * Never throws: a failure leaves the call unoptimized.
   */
  async _prepare ({ adapter, method, client, args, opts }) {
    const ctx = { cfg: this.config, sdk: adapter.sdk, operation: method.operation, useCase: opts.useCase, cdsService: opts.cdsService }
    try {
      ctx.cfg = forUseCase(this.config, opts.useCase)
      ctx.context = cdsContextInfo()
      const info = ctx.info = adapter.extract(client, args)
      ctx.estimate = estimateMessages(info.messages, { model: info.model, tools: info.tools })
      Object.assign(ctx, fingerprint(info.messages.map(untag)))
    } catch (e) {
      log.warn('could not read call details:', e?.message)
      return ctx
    }
    if (ctx.cfg.mode === 'off' || method.operation !== 'chat') return ctx

    const { info } = ctx
    let result = null
    try {
      result = await runPipeline({ messages: info.messages, tools: info.tools, params: info.params, model: info.model, steps: ctx.cfg.steps, editable: info.editable })
      ctx.optimized = adapter.apply(client, args, info, result)
      ctx.pipeline = result
    } catch (e) {
      log.warn('optimizer pipeline failed, sending the original request:', e?.message)
      ctx.pipelineFailed = true
      ctx.optimized = null
      result = null
    }
    try {
      const params = result?.params ?? info.params
      if (isCacheable(ctx.cfg.cache, params)) {
        const material = (ctx.optimized ?? adapter.apply(client, args, info, info)).keyMaterial
        ctx.cacheKey = cacheKey(material, { scope: ctx.cfg.cache.scope, tenant: ctx.context?.tenant, userId: ctx.context?.userId })
      }
    } catch (e) {
      log.warn('could not compute cache key:', e?.message)
    }
    try {
      const sent = ctx.cfg.mode === 'active' && ctx.pipeline ? ctx.pipeline : info
      ctx.prefix = { original: prefixOf(info.messages, info.tools), sent: prefixOf(sent.messages, sent.tools) }
    } catch { /* advisory only */ }
    return ctx
  }

  /**
   * Prompt-caching advisory: providers cache the start of the prompt (system messages, tools).
   * When it changes between calls of the same use case and model, that cache can't be used.
   * @returns {{ promptPrefixChanged: boolean, changed: string[], causedByOptimizer: boolean } | null}
   */
  _checkPrefix (ctx) {
    if (!ctx.cfg.advisories?.promptCache || !ctx.prefix) return null
    const key = `${ctx.useCase ?? 'default'}|${ctx.info?.model ?? ''}`
    const prev = this._prefixes.get(key)
    this._prefixes.delete(key)
    this._prefixes.set(key, { ...ctx.prefix, loggedAt: prev?.loggedAt ?? 0 })
    if (this._prefixes.size > MAX_PREFIXES) this._prefixes.delete(this._prefixes.keys().next().value)
    if (!prev) return { promptPrefixChanged: false, changed: [], causedByOptimizer: false }

    const changed = ['system', 'tools'].filter(part => prev.sent[part] !== ctx.prefix.sent[part])
    if (!changed.length) return { promptPrefixChanged: false, changed, causedByOptimizer: false }
    // the caller sent the same prefix as last time, so the optimizer changed it
    const causedByOptimizer = changed.every(part => prev.original[part] === ctx.prefix.original[part])
    const entry = this._prefixes.get(key)
    const now = Date.now()
    if (now - entry.loggedAt > ADVISORY_LOG_INTERVAL_MS) {
      entry.loggedAt = now
      log.warn(`prompt prefix (${changed.join(', ')}) changed for use case "${ctx.useCase ?? 'default'}"${causedByOptimizer ? ' by the optimizer' : ''}; ` +
        'provider prompt caching cannot be used. Keep system prompts and tool definitions stable per use case.')
    }
    const advisory = { promptPrefixChanged: true, changed, causedByOptimizer }
    this.collector.notify('advisory', { type: 'PROMPT_PREFIX_CHANGED', useCase: ctx.useCase ?? 'default', model: ctx.info?.model ?? null, ...advisory })
    return advisory
  }

  async _cacheGet (key) {
    try {
      return (await this.cache.get(key)) ?? null
    } catch (e) {
      log.warn('cache read failed:', e?.message)
      return null
    }
  }

  _cacheSet (ctx, response) {
    try {
      rememberResponseClass(ctx.sdk, response)
      const entry = serializeResponse(ctx.sdk, response)
      if (!entry) return
      Promise.resolve(this.cache.set(ctx.cacheKey, entry, ctx.cfg.cache.ttlSeconds * 1000))
        .catch(e => log.warn('cache write failed:', e?.message))
    } catch (e) {
      log.warn('cache write failed:', e?.message)
    }
  }

  _retryDelay (cfg, classified, retries) {
    const r = cfg.retry
    if (!r?.enabled || retries >= r.maxRetries || !r.on?.includes(classified.category)) return null
    if (classified.retryAfterMs != null) return Math.min(classified.retryAfterMs, r.maxDelayMs)
    const backoff = r.baseDelayMs * 2 ** retries
    return Math.min(r.maxDelayMs, Math.round(backoff / 2 + Math.random() * backoff / 2))
  }

  _record (ctx, { started, retries, response, error, cacheEntry, note }) {
    const latencyMs = Math.round(performance.now() - started)
    const cfg = ctx.cfg
    const info = ctx.info ?? {}
    const pipeline = ctx.pipeline
    const before = ctx.estimate?.tokens ?? null
    const after = pipeline ? pipeline.estimateAfter : before

    // A cache hit consumed no AI Core tokens; what it saved is the cached call's usage.
    // In shadow mode a would-be hit is recorded as savings, the usage is real.
    const usage = cacheEntry
      ? { prompt: 0, completion: 0, total: 0, cached: 0 }
      : usageToTokens(response ? safe(() => response.getTokenUsage?.()) : null)
    const byStep = { ...(pipeline?.byStep ?? {}) }
    const hitEntry = cacheEntry ?? ctx.wouldHitCache
    if (hitEntry) {
      const saved = usageToTokens(hitEntry.data?.final_result?.usage ?? hitEntry.data?.usage)
      byStep.cache = saved.total ?? after ?? 0
    }
    const promptSaved = before != null && after != null ? before - after : 0
    const model = info.model ?? null
    const notes = [...(pipeline?.notes ?? [])]
    if (ctx.pipelineFailed) notes.push('pipeline failed; original request sent')
    if (note) notes.push(note)
    const advisory = cacheEntry ? null : safe(() => this._checkPrefix(ctx))

    const event = buildEvent({
      tenant: ctx.context?.tenant,
      userId: ctx.context?.userId,
      cdsService: ctx.cdsService ?? ctx.context?.cdsService,
      useCase: ctx.useCase,
      mode: cfg.mode,
      model,
      deploymentId: info.deploymentId,
      resourceGroup: info.resourceGroup,
      sdk: ctx.sdk,
      operation: ctx.operation,
      requestId: response && !cacheEntry ? safe(() => response.getRequestId?.()) : null,
      finishReason: response ? safe(() => response.getFinishReason?.()) : null,
      estimateMethod: ctx.estimate?.method,
      tokens: { promptEstimatedBefore: before, promptEstimatedAfter: after, ...usage },
      savings: {
        estimatedTokens: promptSaved + (byStep.cache ?? 0),
        byStep,
        cacheHit: !!hitEntry,
        notes,
        failed: !!ctx.pipelineFailed
      },
      costEstimate: estimateCost(model, usage, cfg.pricing),
      latencyMs,
      retries,
      status: error ? 'error' : 'success',
      error,
      promptHash: ctx.promptHash,
      promptLength: ctx.promptLength,
      advisory,
      content: cfg.captureContent ? captured(ctx, response) : undefined
    }, { userHashSalt: cfg.metrics?.userHashSalt })
    this.collector.record(event)
  }
}

/** Raw content, only when captureContent is explicitly enabled. */
function captured (ctx, response) {
  const sent = ctx.cfg.mode === 'active' && ctx.pipeline ? ctx.pipeline.messages : ctx.info?.messages
  return {
    messages: (sent ?? []).map(untag),
    completion: response ? safe(() => response.getContent?.()) ?? null : null
  }
}

/** Hashes of the parts of a prompt that provider prompt caching depends on. */
function prefixOf (messages, tools) {
  const system = (messages ?? []).filter(isSystem).map(m => m.content)
  return { system: sha256(stableStringify(system)), tools: sha256(stableStringify(tools ?? [])) }
}

const logRecordError = (e) => log.warn('could not record call metrics:', e?.message)

const unknownError = (err) => ({ category: 'UNKNOWN', httpStatus: null, code: null, message: String(err?.message ?? err), retryAfterMs: null })

/**
 * Run `fn`, returning undefined instead of throwing.
 * @template T
 * @param {() => T} fn
 * @param {(e: any) => void} [onError]
 * @returns {T|undefined}
 */
function safe (fn, onError) {
  try { return fn() } catch (e) { onError?.(e); return undefined }
}

module.exports = { TokenOptimizer, WRAPPED }

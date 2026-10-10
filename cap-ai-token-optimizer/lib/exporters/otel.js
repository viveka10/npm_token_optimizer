'use strict'
/**
 * OpenTelemetry exporter (SAP Cloud ALM, Dynatrace, any OTLP backend).
 *
 * Uses only @opentelemetry/api and the globally registered providers. It never creates an
 * SDK or providers itself: install @cap-js/telemetry (or the SAP Cloud ALM agent) to set them
 * up and choose where data goes. Without registered providers, everything is a no-op.
 *
 * Emits per call:
 *  - metrics: gen_ai.client.token.usage and gen_ai.client.operation.duration (OpenTelemetry
 *    GenAI semantic conventions), plus cap_ai_optimizer.calls / .errors / .tokens.saved /
 *    .cache.hits / .cost
 *  - one span `chat <model>` (kind CLIENT) with token, savings and error attributes, as a child
 *    of the active span (e.g. the CAP request span). Prompt and completion text are never added.
 *
 * Instruments are created on the first event, not at startup: meters taken before
 * @cap-js/telemetry registers its MeterProvider would stay no-ops.
 */
const log = require('../util/log')
const { loadPeer } = require('../util/peer')

const { name: SCOPE, version: VERSION } = require('../../package.json')
const PROVIDER = 'sap.ai_core'

/**
 * @param {{ tenantAttribute?: boolean }} [cfg] metrics.otel config
 * @param {{ api?: object }} [deps]
 * @returns {import('../../index').Exporter}
 */
function createOtelExporter (cfg = {}, deps = {}) {
  const api = deps.api ?? loadPeer('@opentelemetry/api', 'the otel exporter')
  const tenantAttribute = cfg.tenantAttribute !== false
  let instruments = null

  function init () {
    const meterProvider = api.metrics.getMeterProvider()
    if (meterProvider?.constructor?.name === 'NoopMeterProvider') {
      log.warn('otel exporter: no OpenTelemetry MeterProvider is registered, metrics are not exported. Install @cap-js/telemetry.')
    }
    const meter = api.metrics.getMeter(SCOPE, VERSION)
    instruments = {
      tracer: api.trace.getTracer(SCOPE, VERSION),
      tokenUsage: meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}', description: 'Tokens used per AI Core call' }),
      duration: meter.createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'Duration of AI Core calls' }),
      calls: meter.createCounter('cap_ai_optimizer.calls', { unit: '{call}', description: 'AI Core calls' }),
      errors: meter.createCounter('cap_ai_optimizer.errors', { unit: '{call}', description: 'Failed AI Core calls by category' }),
      saved: meter.createCounter('cap_ai_optimizer.tokens.saved', { unit: '{token}', description: 'Estimated tokens saved, by optimization step' }),
      cacheHits: meter.createCounter('cap_ai_optimizer.cache.hits', { unit: '{call}', description: 'Calls answered from the response cache' }),
      cost: meter.createCounter('cap_ai_optimizer.cost', { description: 'Estimated cost, in the currency of the configured prices' }),
      prefixChanges: meter.createCounter('cap_ai_optimizer.prompt_cache.prefix_changes', { unit: '{call}', description: 'Calls whose system prompt or tools changed for the same use case and model (defeats provider prompt caching)' })
    }
    return instruments
  }

  function attributes (e) {
    const a = {
      'gen_ai.operation.name': e.operation ?? 'chat',
      'gen_ai.provider.name': PROVIDER,
      'cap_ai_optimizer.use_case': e.useCase,
      'cap_ai_optimizer.mode': e.mode,
      'cap_ai_optimizer.sdk': e.sdk ?? 'unknown'
    }
    if (e.model) a['gen_ai.request.model'] = e.model
    if (tenantAttribute && e.tenant) a['sap.tenancy.tenant_id'] = e.tenant
    if (e.status === 'error') a['error.type'] = e.error?.category ?? 'UNKNOWN'
    return a
  }

  function recordMetrics (i, e, attrs) {
    if (Number.isFinite(e.latencyMs)) i.duration.record(e.latencyMs / 1000, attrs)
    if (Number.isFinite(e.tokens?.prompt)) i.tokenUsage.record(e.tokens.prompt, { ...attrs, 'gen_ai.token.type': 'input' })
    if (Number.isFinite(e.tokens?.completion)) i.tokenUsage.record(e.tokens.completion, { ...attrs, 'gen_ai.token.type': 'output' })
    i.calls.add(1, attrs)
    if (e.status === 'error') i.errors.add(1, attrs)
    if (e.savings?.cacheHit) i.cacheHits.add(1, attrs)
    for (const [step, saved] of Object.entries(e.savings?.byStep ?? {})) {
      if (saved > 0) i.saved.add(saved, { ...attrs, 'cap_ai_optimizer.step': step })
    }
    if (e.costEstimate > 0) i.cost.add(e.costEstimate, attrs)
    if (e.advisory?.promptPrefixChanged) {
      i.prefixChanges.add(1, { ...attrs, 'cap_ai_optimizer.prefix_part': e.advisory.changed.join(','), 'cap_ai_optimizer.caused_by_optimizer': !!e.advisory.causedByOptimizer })
    }
  }

  function recordSpan (i, e, attrs) {
    const end = Date.parse(e.timestamp)
    const endTime = Number.isFinite(end) ? end : Date.now()
    const startTime = endTime - (Number.isFinite(e.latencyMs) ? e.latencyMs : 0)
    const spanAttrs = { ...attrs }
    const set = (k, v) => { if (v !== null && v !== undefined) spanAttrs[k] = v }
    set('gen_ai.usage.input_tokens', e.tokens?.prompt)
    set('gen_ai.usage.output_tokens', e.tokens?.completion)
    if (e.finishReason) spanAttrs['gen_ai.response.finish_reasons'] = [e.finishReason]
    set('sap.ai_core.request_id', e.requestId)
    set('sap.ai_core.deployment_id', e.deploymentId)
    set('sap.ai_core.resource_group', e.resourceGroup)
    set('cap_ai_optimizer.event_id', e.id)
    set('cap_ai_optimizer.tokens.prompt_estimated_before', e.tokens?.promptEstimatedBefore)
    set('cap_ai_optimizer.tokens.prompt_estimated_after', e.tokens?.promptEstimatedAfter)
    set('cap_ai_optimizer.tokens.cached', e.tokens?.cached)
    set('cap_ai_optimizer.savings.estimated_tokens', e.savings?.estimatedTokens)
    set('cap_ai_optimizer.cache_hit', e.savings?.cacheHit)
    set('cap_ai_optimizer.retries', e.retries)
    set('cap_ai_optimizer.cost_estimate', e.costEstimate)
    set('cap_ai_optimizer.prompt_prefix_changed', e.advisory?.promptPrefixChanged)
    if (e.status === 'error') set('http.response.status_code', e.error?.httpStatus)

    const span = i.tracer.startSpan(`${e.operation ?? 'chat'}${e.model ? ` ${e.model}` : ''}`, { kind: api.SpanKind.CLIENT, startTime, attributes: spanAttrs }, api.context.active())
    if (e.status === 'error') span.setStatus({ code: api.SpanStatusCode.ERROR, message: e.error?.category })
    span.end(endTime)
  }

  return {
    name: 'otel',
    export (event) {
      const i = instruments ?? init()
      const attrs = attributes(event)
      recordMetrics(i, event, attrs)
      recordSpan(i, event, attrs)
    },
    flush () {},
    shutdown () {}
  }
}

module.exports = { createOtelExporter }

'use strict'
const api = require('@opentelemetry/api')
const { MeterProvider, PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } = require('@opentelemetry/sdk-metrics')
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks')
const { createOtelExporter } = require('../../lib/exporters/otel')
const { createExporters } = require('../../lib/exporters')
const log = require('../../lib/util/log')

const warn = jest.fn()
beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
afterAll(() => log._set(undefined))

const event = (over = {}) => ({
  id: 'e1',
  timestamp: '2026-10-10T10:00:01.000Z',
  tenant: 't1',
  useCase: 'agent',
  mode: 'active',
  model: 'gpt-4.1',
  deploymentId: 'd1',
  resourceGroup: 'default',
  sdk: 'orchestration',
  operation: 'chat',
  requestId: 'req-1',
  finishReason: 'stop',
  tokens: { promptEstimatedBefore: 900, promptEstimatedAfter: 500, prompt: 480, completion: 40, total: 520, cached: 0 },
  savings: { estimatedTokens: 400, byStep: { history: 300, tools: 100, normalize: 0 }, cacheHit: false },
  costEstimate: 0.0012,
  latencyMs: 250,
  retries: 0,
  status: 'success',
  error: null,
  ...over
})

describe('otel exporter', () => {
  let metricExporter, reader, spanExporter, tracerProvider, contextManager

  beforeAll(() => {
    contextManager = new AsyncLocalStorageContextManager().enable()
    api.context.setGlobalContextManager(contextManager)
    metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60000 })
    api.metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
    spanExporter = new InMemorySpanExporter()
    tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] })
    api.trace.setGlobalTracerProvider(tracerProvider)
  })
  afterAll(async () => {
    await reader.shutdown()
    api.metrics.disable()
    api.trace.disable()
    api.context.disable()
  })

  async function collectMetrics () {
    await reader.forceFlush()
    const all = metricExporter.getMetrics().flatMap(rm => rm.scopeMetrics.flatMap(sm => sm.metrics))
    const byName = {}
    for (const m of all) byName[m.descriptor.name] = m.dataPoints
    return byName
  }

  test('records GenAI metrics, savings, cache hits, errors and cost', async () => {
    const x = createOtelExporter()
    x.export(event())
    x.export(event({ status: 'error', error: { category: 'RATE_LIMIT', httpStatus: 429 }, tokens: {}, savings: { byStep: {}, cacheHit: false }, costEstimate: null }))
    x.export(event({ savings: { estimatedTokens: 520, byStep: { cache: 520 }, cacheHit: true }, tokens: { prompt: 0, completion: 0 }, latencyMs: null }))
    const m = await collectMetrics()

    const input = m['gen_ai.client.token.usage'].find(p => p.attributes['gen_ai.token.type'] === 'input')
    expect(input.value.sum).toBe(480)
    expect(input.attributes).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'sap.ai_core', 'gen_ai.request.model': 'gpt-4.1', 'cap_ai_optimizer.use_case': 'agent', 'sap.tenancy.tenant_id': 't1' })
    expect(m['gen_ai.client.operation.duration'].reduce((n, p) => n + p.value.count, 0)).toBe(2)
    expect(m['cap_ai_optimizer.calls'].reduce((n, p) => n + p.value, 0)).toBe(3)
    expect(m['cap_ai_optimizer.errors']).toEqual([expect.objectContaining({ value: 1, attributes: expect.objectContaining({ 'error.type': 'RATE_LIMIT' }) })])
    const saved = Object.fromEntries(m['cap_ai_optimizer.tokens.saved'].map(p => [p.attributes['cap_ai_optimizer.step'], p.value]))
    expect(saved).toEqual({ history: 300, tools: 100, cache: 520 })
    expect(m['cap_ai_optimizer.cache.hits'][0].value).toBe(1)
    expect(m['cap_ai_optimizer.cost'][0].value).toBeCloseTo(0.0024)
  })

  test('creates one span per call under the active span, without content', async () => {
    spanExporter.reset()
    const x = createOtelExporter({ tenantAttribute: false })
    const tracer = api.trace.getTracer('test')
    await tracer.startActiveSpan('POST /odata/v4/agent/ask', async (parent) => {
      x.export(event({ content: { messages: [{ role: 'user', content: 'secret' }] } }))
      x.export(event({ model: null, status: 'error', error: { category: 'TIMEOUT', httpStatus: null }, timestamp: 'invalid', finishReason: null }))
      parent.end()
    })
    const spans = spanExporter.getFinishedSpans()
    const [ok, failed, parent] = spans
    expect(ok.name).toBe('chat gpt-4.1')
    expect(ok.kind).toBe(api.SpanKind.CLIENT)
    expect(ok.parentSpanContext?.spanId ?? ok.parentSpanId).toBe(parent.spanContext().spanId)
    expect(ok.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 480,
      'gen_ai.usage.output_tokens': 40,
      'gen_ai.response.finish_reasons': ['stop'],
      'sap.ai_core.request_id': 'req-1',
      'cap_ai_optimizer.savings.estimated_tokens': 400,
      'cap_ai_optimizer.cache_hit': false
    })
    expect(ok.attributes).not.toHaveProperty('sap.tenancy.tenant_id')
    const durationMs = (ok.endTime[0] - ok.startTime[0]) * 1000 + (ok.endTime[1] - ok.startTime[1]) / 1e6
    expect(Math.round(durationMs)).toBe(250)
    expect(JSON.stringify(ok.attributes)).not.toContain('secret')
    expect(failed.name).toBe('chat')
    expect(failed.status).toEqual({ code: api.SpanStatusCode.ERROR, message: 'TIMEOUT' })
    expect(failed.attributes['error.type']).toBe('TIMEOUT')
  })

  test('is created by metrics.otel.enabled', () => {
    const out = createExporters({ metrics: { exporters: [], otel: { enabled: true } } })
    expect(out.map(x => x.name)).toEqual(['otel'])
    expect(createExporters({ metrics: { exporters: ['otel'], otel: { enabled: true } } })).toHaveLength(1)
  })

  test('warns when no MeterProvider is registered', () => {
    const noop = { metrics: { getMeterProvider: () => new (class NoopMeterProvider {})(), getMeter: () => api.createNoopMeter() }, trace: api.trace, context: api.context, SpanKind: api.SpanKind, SpanStatusCode: api.SpanStatusCode }
    const x = createOtelExporter({}, { api: noop })
    x.export(event())
    x.export(event())
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/no OpenTelemetry MeterProvider/)
    expect(x.flush()).toBeUndefined()
    expect(x.shutdown()).toBeUndefined()
  })
})

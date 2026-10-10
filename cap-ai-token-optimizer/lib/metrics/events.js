'use strict'
const { randomUUID } = require('node:crypto')
const { hashUser } = require('../util/hash')
const { getCds } = require('../util/cds')

const SCHEMA_VERSION = 1

/**
 * Read tenant / user / service from cds.context, if CAP is loaded.
 * `cdsService` falls back to the HTTP base path (e.g. /odata/v4/agent); pass `cdsService`
 * explicitly in wrap()/chat() options for the CDS service name.
 * @returns {{ tenant: string|null, userId: string|null, cdsService: string|null }}
 */
function cdsContextInfo () {
  try {
    const ctx = getCds()?.context
    if (!ctx) return { tenant: null, userId: null, cdsService: null }
    const user = ctx.user
    const userId = user && !user._is_anonymous && user.id !== 'anonymous' ? user.id : null
    return {
      tenant: ctx.tenant ?? null,
      userId: userId ?? null,
      cdsService: ctx.http?.req?.baseUrl || null
    }
  } catch {
    return { tenant: null, userId: null, cdsService: null }
  }
}

/**
 * Cost estimate from per-1k prices. Cached prompt tokens use `cachedInputPer1k` when configured.
 * @param {string|null} model
 * @param {{ prompt: number|null, completion: number|null, cached: number|null }} tokens
 * @param {Record<string, { inputPer1k?: number, outputPer1k?: number, cachedInputPer1k?: number }>} pricing
 * @returns {number|null}
 */
function estimateCost (model, tokens, pricing) {
  const price = model ? (pricing?.[model] ?? pricing?.[String(model).replace(/^.*(--|\/)/, '')]) : null
  if (!price || tokens.prompt == null) return null
  const cached = Math.min(tokens.cached ?? 0, tokens.prompt)
  const cachedRate = price.cachedInputPer1k ?? price.inputPer1k ?? 0
  const cost = ((tokens.prompt - cached) * (price.inputPer1k ?? 0) +
    cached * cachedRate +
    (tokens.completion ?? 0) * (price.outputPer1k ?? 0)) / 1000
  return Math.round(cost * 1e6) / 1e6
}

/**
 * Normalise SDK token usage into the event's token fields.
 * Works for orchestration and Azure OpenAI responses (same OpenAI-style usage shape).
 * @param {any} usage result of response.getTokenUsage()
 */
function usageToTokens (usage) {
  if (!usage || typeof usage !== 'object') return { prompt: null, completion: null, total: null, cached: null }
  const num = (v) => (Number.isFinite(v) ? v : null)
  const prompt = num(usage.prompt_tokens)
  const completion = num(usage.completion_tokens)
  return {
    prompt,
    completion,
    total: num(usage.total_tokens) ?? (prompt != null && completion != null ? prompt + completion : null),
    cached: num(usage.prompt_tokens_details?.cached_tokens) ?? 0
  }
}

/**
 * Build a complete metrics event. Missing fields get explicit null defaults so the
 * shape is stable for exporters.
 * @param {object} p
 * @param {object} [opts]
 * @param {string} [opts.userHashSalt]
 */
function buildEvent (p, { userHashSalt } = {}) {
  const tokens = {
    promptEstimatedBefore: p.tokens?.promptEstimatedBefore ?? null,
    promptEstimatedAfter: p.tokens?.promptEstimatedAfter ?? null,
    prompt: p.tokens?.prompt ?? null,
    completion: p.tokens?.completion ?? null,
    total: p.tokens?.total ?? null,
    cached: p.tokens?.cached ?? null
  }
  const event = {
    schemaVersion: SCHEMA_VERSION,
    id: p.id ?? randomUUID(),
    timestamp: p.timestamp ?? new Date().toISOString(),
    tenant: p.tenant ?? null,
    user: hashUser(p.userId, userHashSalt),
    cdsService: p.cdsService ?? null,
    useCase: p.useCase ?? 'default',
    mode: p.mode ?? 'active',
    model: p.model ?? null,
    deploymentId: p.deploymentId ?? null,
    resourceGroup: p.resourceGroup ?? null,
    sdk: p.sdk ?? null,
    operation: p.operation ?? 'chat',
    requestId: p.requestId ?? null,
    finishReason: p.finishReason ?? null,
    estimateMethod: p.estimateMethod ?? null,
    tokens,
    savings: {
      estimatedTokens: p.savings?.estimatedTokens ?? 0,
      byStep: p.savings?.byStep ?? {},
      cacheHit: p.savings?.cacheHit ?? false,
      // short step notes (counts only, never content), and whether the pipeline failed
      notes: p.savings?.notes ?? [],
      failed: p.savings?.failed ?? false
    },
    costEstimate: p.costEstimate ?? null,
    latencyMs: p.latencyMs ?? null,
    retries: p.retries ?? 0,
    status: p.status ?? 'success',
    error: p.error
      ? { category: p.error.category, httpStatus: p.error.httpStatus ?? null, code: p.error.code ?? null, message: p.error.message ?? '' }
      : null,
    promptHash: p.promptHash ?? null,
    promptLength: p.promptLength ?? null,
    // prompt-caching advisory; null when not checked (disabled, cache hit)
    advisory: p.advisory ?? null
  }
  if (p.content) event.content = p.content
  return event
}

module.exports = { buildEvent, estimateCost, usageToTokens, cdsContextInfo, SCHEMA_VERSION }

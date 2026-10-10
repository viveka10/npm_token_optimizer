'use strict'
/**
 * Configuration defaults and merge logic.
 * Users configure the optimizer via `cds.requires.tokenOptimizer` (or programmatically).
 */

const MODES = ['active', 'shadow', 'off']

/** @type {import('../index').TokenOptimizerConfig} */
const DEFAULTS = Object.freeze({
  mode: 'active',
  // Each step: false (off), true (defaults) or an options object. See lib/pipeline/steps/*.
  steps: {
    normalize: true,
    dedupe: true,
    history: { maxTurns: 10 },
    tools: { maxTools: 15, maxDescriptionLength: 600, pinned: [] },
    outputCap: { default: 1024 }
  },
  // Exact-match response cache. Only temperature <= maxTemperature is cached (null: any).
  // scope: 'tenant' (default), 'user' or 'global'. `store` may be set in code (CacheStore).
  cache: { enabled: true, ttlSeconds: 3600, maxEntries: 1000, maxTemperature: 0.2, scope: 'tenant' },
  metrics: {
    exporters: ['console'],
    flushIntervalMs: 15000,
    // Salt for the user-id hash in events. Set it from the environment, not in committed files.
    userHashSalt: '',
    // POST batches of events to a URL or a BTP destination (see lib/exporters/http.js for all options)
    http: { url: '', destination: '', headers: {}, batchSize: 100, maxQueueSize: 10000, maxRetries: 3, timeoutMs: 10000 },
    // OpenTelemetry metrics and spans through the providers registered by @cap-js/telemetry
    otel: { enabled: false, tenantAttribute: true },
    // TokenUsageLog rows in the app database (exporter `db`, alias `hana`)
    db: { batchSize: 50, maxQueueSize: 10000, retentionDays: 30 }
  },
  // Price per 1k tokens by model name. Empty by default — prices vary per contract.
  pricing: {},
  // Per-use-case overrides, e.g. { "invoice-agent": { steps: { outputCap: { default: 256 } } } }
  useCases: {},
  // Request timeout applied when the caller does not set one (ms). null = SDK default.
  timeoutMs: null,
  // Opt-in retries performed by the wrapper (the SDK itself does not retry).
  retry: {
    enabled: false,
    maxRetries: 2,
    baseDelayMs: 500,
    maxDelayMs: 10000,
    on: ['RATE_LIMIT', 'SERVER', 'NETWORK', 'TIMEOUT']
  },
  // promptCache: warn when the system prompt or tools sent for a use case and model change
  // between calls, which defeats the provider's prompt caching
  advisories: { promptCache: true },
  // Hook the @sap-ai-sdk client classes so existing code needs no changes. `true` or
  // { enabled, useCase }; useCase labels calls made outside withUseCase()/wrap().
  autoInstrument: { enabled: false, useCase: 'default' },
  // Read-only admin service at /odata/v4/token-optimizer, for users with `role`
  admin: { enabled: false, role: 'TokenOptimizerAdmin' },
  captureContent: false
})

// Only object literals merge; class instances (e.g. a custom cache store) are kept as they are.
const isPlainObject = (v) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))

/**
 * Deep merge. Objects merge recursively; arrays and scalars from `override` replace.
 * `undefined` in override is ignored. Neither input is mutated.
 * @template T
 * @param {T} base
 * @param {any} override
 * @returns {T}
 */
function deepMerge (base, override) {
  if (!isPlainObject(override)) return override === undefined ? clone(base) : clone(override)
  const out = isPlainObject(base) ? clone(base) : {}
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v)
  }
  return out
}

function clone (v) {
  if (Array.isArray(v)) return v.map(clone)
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]))
  return v
}

/**
 * Builds the effective configuration from user input on top of the defaults.
 * Accepts `true` (use defaults) or an object. Invalid values fall back to defaults with a warning.
 * @param {object|boolean|undefined} userConfig
 * @param {{ warn?: (msg: string) => void }} [log]
 */
function resolveConfig (userConfig, log = {}) {
  const input = isPlainObject(userConfig) ? stripCdsKeys(userConfig) : {}
  const cfg = deepMerge(DEFAULTS, input)
  if (!MODES.includes(cfg.mode)) {
    log.warn?.(`Invalid tokenOptimizer.mode "${cfg.mode}", using "active". Allowed: ${MODES.join(', ')}`)
    cfg.mode = 'active'
  }
  for (const [name, uc] of Object.entries(cfg.useCases ?? {})) {
    if (uc?.mode !== undefined && !MODES.includes(uc.mode)) {
      log.warn?.(`Invalid tokenOptimizer.useCases.${name}.mode "${uc.mode}", using "${cfg.mode}"`)
      delete uc.mode
    }
  }
  if (typeof cfg.autoInstrument === 'boolean') cfg.autoInstrument = { ...DEFAULTS.autoInstrument, enabled: cfg.autoInstrument }
  if (typeof cfg.metrics.exporters === 'string') cfg.metrics.exporters = [cfg.metrics.exporters]
  if (!Array.isArray(cfg.metrics.exporters)) cfg.metrics.exporters = [...DEFAULTS.metrics.exporters]
  return cfg
}

/** Remove CAP-internal keys (kind, impl, model, …) that cds adds to `requires` entries. */
function stripCdsKeys (obj) {
  const { kind, impl, model, ...rest } = obj
  return rest
}

/**
 * Effective config for a use case: global config with `useCases[useCase]` merged on top.
 * @param {object} cfg resolved config
 * @param {string} [useCase]
 */
function forUseCase (cfg, useCase) {
  const override = useCase && cfg.useCases?.[useCase]
  return override ? deepMerge(cfg, override) : cfg
}

module.exports = { DEFAULTS, MODES, resolveConfig, deepMerge, forUseCase }

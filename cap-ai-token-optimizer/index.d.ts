// Type definitions for @viveka/cap-ai-token-optimizer

export type Mode = 'active' | 'shadow' | 'off'

export type FailureCategory =
  | 'RATE_LIMIT' | 'CONTENT_FILTER' | 'CONTEXT_LENGTH' | 'TIMEOUT' | 'AUTH'
  | 'DEPLOYMENT_NOT_FOUND' | 'SERVER' | 'NETWORK' | 'UNKNOWN'

export interface ModelPrice {
  inputPer1k?: number
  outputPer1k?: number
  /** Price for cached prompt tokens; defaults to inputPer1k. */
  cachedInputPer1k?: number
}

type Message = Record<string, unknown>
type Tool = Record<string, unknown>
/** A step is off (false), on with defaults (true), or on with options ({ enabled?: false } turns it off). */
type Step<T> = boolean | (T & { enabled?: boolean })

export interface StepsConfig {
  normalize?: Step<{ minifyJson?: boolean, minifyJsonFences?: boolean, collapseSpaces?: boolean }>
  dedupe?: Step<{ messages?: boolean, paragraphs?: boolean, minParagraphLength?: number }>
  history?: Step<{
    maxTurns?: number
    /** 'sliding-window' (default) or a function returning the messages to keep. */
    strategy?: 'sliding-window' | ((input: { messages: Message[], maxTurns: number, model: string | null }) => Message[])
    /** Called with the removed messages; the returned message is inserted after the system messages. */
    summarizer?: ((input: { dropped: Message[], kept: Message[], model: string | null }) => Promise<Message | null> | Message | null) | null
  }>
  tools?: Step<{
    maxTools?: number
    maxDescriptionLength?: number
    /** Tool names that are never removed. */
    pinned?: string[]
    selector?: ((input: { tools: Tool[], messages: Message[], maxTools: number, keep: Set<string> }) => Tool[]) | null
  }>
  outputCap?: Step<{ default?: number, reasoningModels?: boolean }>
}

/** Response cache store. Methods may be sync or async. Values are plain JSON. */
export interface CacheStore {
  get(key: string): unknown | Promise<unknown>
  set(key: string, value: unknown, ttlMs: number): void | Promise<void>
  delete?(key: string): void | Promise<void>
  clear?(): void | Promise<void>
}

export declare class MemoryCacheStore implements CacheStore {
  constructor(opts?: { maxEntries?: number, now?: () => number })
  get(key: string): unknown
  set(key: string, value: unknown, ttlMs: number): void
  delete(key: string): void
  clear(): void
  readonly size: number
}

export interface TokenOptimizerConfig {
  mode?: Mode
  steps?: StepsConfig
  cache?: {
    enabled?: boolean
    ttlSeconds?: number
    maxEntries?: number
    /** Only calls with temperature <= this are cached. null caches regardless of temperature. Default 0.2. */
    maxTemperature?: number | null
    /** Who may share cached answers. Default 'tenant'. */
    scope?: 'tenant' | 'user' | 'global'
    /** Custom store (e.g. Redis), set in code. Default: in-memory LRU. */
    store?: CacheStore
  }
  metrics?: {
    /** Built-in exporter names ('console') or custom exporter objects. */
    exporters?: Array<string | Exporter> | string
    flushIntervalMs?: number
    /** Salt for the user-id hash. Set it from the environment, not in committed files. */
    userHashSalt?: string
    http?: {
      /** Endpoint URL. Use either url or destination. */
      url?: string
      /** BTP destination name (Internet destinations), resolved with @sap-cloud-sdk/connectivity. */
      destination?: string
      headers?: Record<string, string>
      batchSize?: number
      /** When full, the oldest events are dropped (and counted). */
      maxQueueSize?: number
      maxRetries?: number
      baseDelayMs?: number
      maxDelayMs?: number
      timeoutMs?: number
      destinationCacheMs?: number
    }
    /** TokenUsageLog rows in the app database (exporter `db`, alias `hana`). */
    db?: { batchSize?: number, maxQueueSize?: number, /** 0 keeps all rows. Default 30. */ retentionDays?: number }
    otel?: {
      /** Shortcut for adding 'otel' to exporters. */
      enabled?: boolean
      /** Add sap.tenancy.tenant_id to metrics and spans. Default true. */
      tenantAttribute?: boolean
    }
  }
  /** Price per 1k tokens by model name. */
  pricing?: Record<string, ModelPrice>
  /** Per-use-case overrides, merged over the global config. */
  useCases?: Record<string, Omit<TokenOptimizerConfig, 'useCases'>>
  /** Default request timeout (ms) when the caller sets none. null = SDK default. */
  timeoutMs?: number | null
  retry?: {
    enabled?: boolean
    maxRetries?: number
    baseDelayMs?: number
    maxDelayMs?: number
    on?: FailureCategory[]
  }
  /**
   * Hook the @sap-ai-sdk client classes so existing code needs no changes.
   * `useCase` labels calls made outside wrap(), withUseCase() and wrapLangChain(). Default off.
   */
  autoInstrument?: boolean | { enabled?: boolean, useCase?: string }
  /** promptCache: flag calls whose system prompt or tools changed for the same use case and model. Default true. */
  advisories?: { promptCache?: boolean }
  /** Read-only OData service at /odata/v4/token-optimizer. */
  admin?: { enabled?: boolean, role?: string }
  /** Include raw prompt and completion text in events. Off by default. */
  captureContent?: boolean
}

export interface CallEvent {
  schemaVersion: number
  id: string
  timestamp: string
  tenant: string | null
  /** Hashed user id. */
  user: string | null
  cdsService: string | null
  useCase: string
  mode: Mode
  model: string | null
  deploymentId: string | null
  resourceGroup: string | null
  sdk: 'orchestration' | 'foundation-models' | null
  operation: 'chat' | 'stream'
  requestId: string | null
  finishReason: string | null
  estimateMethod: 'tiktoken' | 'heuristic' | null
  tokens: {
    promptEstimatedBefore: number | null
    promptEstimatedAfter: number | null
    prompt: number | null
    completion: number | null
    total: number | null
    cached: number | null
  }
  /** In shadow mode all savings are what active mode would have saved. */
  savings: {
    estimatedTokens: number
    /** Estimated prompt tokens saved per step; `cache` holds the tokens of a cached call. */
    byStep: Record<string, number>
    cacheHit: boolean
    /** Short step notes (counts only, never content). */
    notes: string[]
    /** The pipeline failed and the original request was sent. */
    failed: boolean
  }
  costEstimate: number | null
  latencyMs: number | null
  retries: number
  status: 'success' | 'error'
  error: { category: FailureCategory, httpStatus: number | null, code: string | null, message: string } | null
  promptHash: string | null
  promptLength: number | null
  /** Prompt-caching advisory; null when not checked (disabled, cache hit). */
  advisory: { promptPrefixChanged: boolean, changed: Array<'system' | 'tools'>, causedByOptimizer: boolean } | null
  /** Only present when captureContent is true. */
  content?: { messages: unknown[], completion: string | null }
}

export interface Advisory {
  type: 'PROMPT_PREFIX_CHANGED'
  useCase: string
  model: string | null
  promptPrefixChanged: true
  changed: Array<'system' | 'tools'>
  /** The caller sent the same prefix as before; an optimizer step (e.g. tools) changed it. */
  causedByOptimizer: boolean
}

export interface Exporter {
  name?: string
  export(event: CallEvent): void | Promise<void>
  flush?(): void | Promise<void>
  shutdown?(): void | Promise<void>
  stats?(): Record<string, number>
}

export interface Totals {
  calls: number
  success: number
  errors: number
  cacheHits: number
  tokens: { prompt: number, completion: number, total: number, cached: number }
  savedTokensEstimate: number
  costEstimate: number
}

export interface Stats extends Totals {
  since: string
  errorsByCategory: Partial<Record<FailureCategory, number>>
  savingsByStep: Record<string, number>
  latencyMs: { count: number, avg: number | null, p50: number | null, p95: number | null, max: number | null }
  byUseCase: Record<string, Totals>
  byModel: Record<string, Totals>
  /** Calls whose system prompt or tools changed, per use case (prompt-caching advisory). */
  promptPrefixChanges: Record<string, number>
  listenerErrors: number
  exporterErrors: Record<string, number>
  /** From exporters with a stats() method, e.g. http: { queued, sent, dropped, failedAttempts, rejectedBatches }. */
  exporters: Record<string, Record<string, number>>
}

export interface WrapOptions {
  useCase?: string
  /** CDS service name; defaults to the request's base path from cds.context. */
  cdsService?: string
}

export interface ChatOptions extends WrapOptions {
  /** Default 'orchestration'. */
  sdk?: 'orchestration' | 'foundation-models'
  model?: string
  messages: Message[]
  tools?: Tool[]
  maxTokens?: number
  temperature?: number
  /** Other model parameters. */
  params?: Record<string, unknown>
  deploymentId?: string
  resourceGroup?: string
  /** Passed to the SDK as requestConfig (e.g. { timeout }). */
  requestConfig?: Record<string, unknown>
}

export interface ChatResult {
  content: string | null
  toolCalls: unknown[] | null
  finishReason: string | null
  usage: Record<string, unknown> | null
  /** The original SDK response object. */
  response: unknown
}

export declare class TokenOptimizer {
  constructor(config?: TokenOptimizerConfig | boolean, deps?: Record<string, unknown>)
  readonly config: Required<TokenOptimizerConfig>
  readonly collector: { readonly exporters: Exporter[] }
  configure(config?: TokenOptimizerConfig | boolean): this
  wrap<T extends object>(client: T, opts?: WrapOptions): T
  chat(opts: ChatOptions): Promise<ChatResult>
  /** Run fn so that @sap-ai-sdk calls inside it (any client, also ones created by libraries) are optimized and measured with useCase. */
  withUseCase<R>(useCase: string, fn: () => R, opts?: { cdsService?: string }): R
  /** Instrument a LangChain chat model from @sap-ai-sdk/langchain. Returns the same model. */
  wrapLangChain<T extends object>(model: T, opts?: WrapOptions): T
  stats(): Stats
  resetStats(): void
  on(type: 'call', listener: (event: CallEvent) => void): this
  on(type: 'advisory', listener: (advisory: Advisory) => void): this
  off(type: 'call' | 'advisory', listener: (arg: any) => void): this
  once(type: 'call', listener: (event: CallEvent) => void): this
  once(type: 'advisory', listener: (advisory: Advisory) => void): this
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export interface ClassifiedError {
  category: FailureCategory
  httpStatus: number | null
  code: string | null
  message: string
  retryAfterMs: number | null
}

/** Process-wide optimizer, configured from cds.requires.tokenOptimizer. */
export declare const optimizer: TokenOptimizer
export declare function createOptimizer(config?: TokenOptimizerConfig, deps?: Record<string, unknown>): TokenOptimizer
export declare function resolveConfig(config?: TokenOptimizerConfig | boolean, log?: { warn?: (msg: string) => void }): Required<TokenOptimizerConfig>
export declare const DEFAULTS: Readonly<Required<TokenOptimizerConfig>>
export declare function classifyError(err: unknown, opts?: { now?: number }): ClassifiedError
export declare const CATEGORIES: readonly FailureCategory[]
export declare function estimateMessages(messages: unknown[], opts?: { model?: string, tools?: unknown[] }): { tokens: number, method: 'tiktoken' | 'heuristic' }
export declare function countText(text: string, model?: string): { tokens: number, method: 'tiktoken' | 'heuristic' }
export declare function createConsoleExporter(opts?: { stream?: { write(s: string): unknown } }): Exporter

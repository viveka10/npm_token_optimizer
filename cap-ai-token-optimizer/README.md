# @viveka10/cap-ai-token-optimizer

[![npm](https://img.shields.io/npm/v/@viveka10/cap-ai-token-optimizer)](https://www.npmjs.com/package/@viveka10/cap-ai-token-optimizer)
[![CI](https://github.com/viveka10/npm_token_optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/viveka10/npm_token_optimizer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/LICENSE)
![Node](https://img.shields.io/node/v/@viveka10/cap-ai-token-optimizer)

**SAP CAP plugin** that reduces, measures and reports the LLM tokens your SAP CAP Node.js app
spends on **SAP AI Core**, and with them your generative AI costs.

```sh
npm add @viveka10/cap-ai-token-optimizer
```

- **Optimize** prompts without changing what they mean: whitespace and JSON, duplicate
  instructions, long histories, large tool lists, output limits, and an exact-match response cache.
- **Measure** every AI Core call: tokens, estimated savings, latency, cost, cache hits and
  classified failures, per tenant, use case and model.
- **Report** to the console, an HTTP endpoint or BTP destination, OpenTelemetry
  (SAP Cloud ALM, Dynatrace, …), a database table, and a read-only admin service.

Works with CAP apps, including CAP apps that act as MCP servers or AI agents, and with plain
Node.js. Wraps the SAP Cloud SDK for AI (`@sap-ai-sdk/orchestration`, `@sap-ai-sdk/foundation-models`).

> **Status: pre-release.** Not affiliated with or endorsed by SAP.

**New here?** [Add it to an existing CAP app in 5 minutes](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/docs/integration-guide.md): no code changes needed.
Deploying on SAP BTP with an AI Core binding and SAP Cloud ALM? See
[Existing CAP app on SAP BTP](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/docs/existing-cap-app-on-btp.md).

**Contents:** [Requirements](#requirements) · [Setup](#setup) · [Usage](#usage) ·
[Existing code and LangChain](#instrumenting-existing-code-and-langchain) · [Compatibility](#compatibility) ·
[How prompts are optimized](#how-prompts-are-optimized) · [Configuration reference](#configuration-reference) ·
[What is recorded](#what-is-recorded) · [Exporters](#exporters) · [Admin service](#admin-service) ·
[SAP Cloud ALM setup](#sap-cloud-alm-setup) · [Troubleshooting](#troubleshooting) ·
[Development](#development)

## Requirements

- Node.js ≥ 22.12. The SAP Cloud SDK for AI is ESM-only, and Node ≥ 22.12 can `require()` it.
- `@sap-ai-sdk/orchestration` and/or `@sap-ai-sdk/foundation-models` 2.8 or later (2.x)
- `@sap/cds` 9 or 10 (optional: the optimizer also works without CAP)
- Optional: `@sap-ai-sdk/langchain` 2.16+, `@cap-js/telemetry` for OpenTelemetry, a database
  for the usage log

See [Compatibility](#compatibility) for the tested versions.

## Setup

```sh
npm add @viveka10/cap-ai-token-optimizer @sap-ai-sdk/orchestration
```

In a CAP app the package is a CAP plugin: it is loaded automatically, reads
`cds.requires.tokenOptimizer`, starts the exporters and flushes them on shutdown.
Without any configuration it optimizes in `active` mode and writes one JSON line per call
to the console.

To roll out safely, start in shadow mode, which measures what would be saved but sends
your prompts unchanged:

```json
{
  "cds": {
    "requires": {
      "tokenOptimizer": {
        "mode": "shadow",
        "pricing": { "gpt-4.1": { "inputPer1k": 0.0, "outputPer1k": 0.0 } }
      }
    }
  }
}
```

Fill in `pricing` with the rates from your contract to get cost estimates.

AI Core credentials are read by the SAP Cloud SDK for AI as usual: from an `aicore` service
binding on BTP, `cds bind --exec` locally, or the `AICORE_SERVICE_KEY` environment variable.

## Usage

```js
const { optimizer } = require('@viveka10/cap-ai-token-optimizer')
const { OrchestrationClient } = require('@sap-ai-sdk/orchestration')

// Option A: wrap an existing client. Same API as the original.
const client = optimizer.wrap(new OrchestrationClient({
  promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } } }
}), { useCase: 'invoice-agent' })
const res = await client.chatCompletion({ messages: [{ role: 'user', content: 'Hi' }] })

// Option B: explicit call (orchestration by default, or sdk: 'foundation-models')
const { content, toolCalls, usage, response } = await optimizer.chat({
  useCase: 'invoice-agent', model: 'gpt-4.1', messages, tools, maxTokens: 256, temperature: 0
})

// Inspect
optimizer.stats()                                  // aggregated in-memory stats
optimizer.on('call', event => { /* one event per AI call */ })
optimizer.on('advisory', advisory => { /* prompt-caching advisories */ })
```

Wrap clients once (for example in your service's `init()`) and reuse them.

- **Supported clients:** `OrchestrationClient` (`chatCompletion`, `stream`) and
  `AzureOpenAiChatClient` (`run`, `stream`). Other methods are forwarded untouched.
- **Streaming:** `stream()` calls are passed through unoptimized. They are recorded when the
  stream has been read to the end, with AI Core's token usage, the finish reason and the latency
  of the whole answer. A failure inside the stream is recorded as an error. A stream closed early,
  or not read within 10 minutes, is recorded at that point without usage and with a note.
- **Errors:** SDK errors are rethrown unchanged. Use `classifyError(err)` to get the failure category.

```js
const { classifyError } = require('@viveka10/cap-ai-token-optimizer')
try { await client.chatCompletion(req) } catch (err) {
  const { category } = classifyError(err)   // e.g. 'RATE_LIMIT'
}
```

`useCase` groups calls in stats and lets you configure them separately
(`useCases.<name>`). Pass `cdsService` to `wrap()`/`chat()` to record the CDS service name;
otherwise the request path from `cds.context` is used.

## Instrumenting existing code and LangChain

### autoInstrument

Optimize and measure every call your app already makes, without code changes:

```json
"tokenOptimizer": { "autoInstrument": true, "mode": "shadow" }
```

This hooks the `@sap-ai-sdk` client classes `OrchestrationClient` (`chatCompletion`,
`stream`) and `AzureOpenAiChatClient` (`run`, `stream`), including the ones that
`@sap-ai-sdk/langchain` creates internally.

- **No double counting:** explicitly wrapped clients are measured once.
- **Off by default:** with `autoInstrument` off, the hooks are either not installed or call
  the original methods unchanged.
- **Use case:** calls without a use case are recorded as `autoInstrument.useCase`
  (default `default`).
- **Limits:** see the [integration guide](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/docs/integration-guide.md#limits-of-automatic-instrumentation).
  In short:
  - only these two classes from SDK 2.x, and only the SDK copy resolved from the app root;
  - process-wide, including libraries;
  - streaming is measured (with token usage) but not optimized.

### withUseCase

Label the calls made inside a function (any client, also ones created by libraries) without
changing the code that makes them:

```js
this.on('summarizeTicket', req =>
  optimizer.withUseCase('ticket-summary', () => summarize(req.data.ID), { cdsService: 'TicketService' }))
```

### LangChain

`@sap-ai-sdk/langchain` models create a new SDK client on every call, so wrap the model
instead of a client:

```js
const { OrchestrationClient } = require('@sap-ai-sdk/langchain')
const model = optimizer.wrapLangChain(
  new OrchestrationClient({ promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } } } }),
  { useCase: 'support-agent' }
)
await model.invoke('…')                        // also batch(), stream(), bindTools(), withStructuredOutput()
```

The same model object is returned. Its calls go through the optimizer, so bound tools are
reduced by the `tools` step and identical low-temperature calls are cached. Works for
`OrchestrationClient` and `AzureOpenAiChatClient`. `wrapLangChain` works whether or not
`autoInstrument` is on.

## Compatibility

Tested on 10 October 2026 with the Jest suite (278 tests: unit tests, integration tests with
the mock AI Core server, the real SDK, `@sap-ai-sdk/langchain` and the sample CAP app) and the
smoke test (`npm run test:smoke`: the real SDK, LangChain and the sample app, run with Node's
built-in test runner):

| Node.js | @sap/cds | @sap-ai-sdk/* | Jest suite | Smoke test |
|---|---|---|---|---|
| 24.17 | 10.1.1 | 2.16.0 | ✅ 278/278 | ✅ 5/5 |
| 24.17 | 10.1.1 | 2.12.0 | ✅ 278/278 | |
| 24.17 | 10.1.1 | 2.8.0 | ✅ 278/278 | |
| 24.17 | 9.9.3 | 2.16.0 | ✅ 278/278 | |
| 24.17 | 9.9.3 | 2.8.0 | ✅ 278/278 | ✅ 5/5 |
| 22.23.3 | 10.1.1 | 2.16.0 | n/a¹ | ✅ 5/5 |
| 22.23.3 | 9.9.3 | 2.8.0 | n/a¹ | ✅ 5/5 |
| 22.12.0 | 10.1.1 | 2.16.0 | n/a¹ | ✅ 4/4, sample app skipped² |
| 22.12.0 | 9.9.3 | 2.8.0 | n/a¹ | ✅ 4/4, sample app skipped² |

- **¹ Jest on Node 22:** Jest can only `require()` the ESM-only SDK on Node ≥ 24.9, so the Jest
  suite runs on Node 24. The package itself runs on Node 22.12+; the smoke test covers it there.
- **² Sample app on Node 22.12:** CAP's `@cap-js/sqlite` 3 needs `node:sqlite` features that
  Node 22.12 doesn't have, so the sample app's in-memory database can't start. This affects
  local SQLite only, not this package.
- **Node 22.12 warning:** it prints an `ExperimentalWarning` when the SDK is loaded with
  `require()`. It is harmless; later Node 22 releases don't print it.
- **`@sap-ai-sdk` before 2.8:** basic optimization works, but `requestId` is missing from
  events, and orchestration fallback lists need 2.8 (2.0 to 2.7 fail 1 to 4 of the 278 tests).
  Use 2.8 or later.
- **Version alignment:** all `@sap-ai-sdk/*` packages in an app must have the same version.
- **LangChain:** tested with `@sap-ai-sdk/langchain` 2.16.0, `@langchain/core` 1.2.12 and
  `langchain` 1.5.12.

The CI workflow ([`.github/workflows/ci.yml`](https://github.com/viveka10/npm_token_optimizer/blob/main/.github/workflows/ci.yml)) runs this matrix on every push and pull request.

## How prompts are optimized

Each step can be switched off and reports the prompt tokens it saved (`savings.byStep`).
They run in this order:

| Step | What it does | Never touches |
|---|---|---|
| `normalize` | Trims, collapses repeated spaces and blank lines, minifies JSON blocks, ```` ```json ```` fences and tool-call arguments. | Fenced code, inline code, indented lines, tabs, JSON string values, numbers and key order |
| `dedupe` | Drops repeated system messages and an identical user message sent twice in a row. Removes paragraphs (≥ 30 chars) that repeat a system paragraph, and older copies of paragraphs a later user message repeats. | Tool and assistant messages, messages with code fences; never empties a message |
| `history` | Keeps system messages and the last `maxTurns` turns. A turn starts at a user message, so tool calls stay with their results. Pluggable `strategy` and optional `summarizer` hook (no LLM summarizer is built in). | System messages |
| `tools` | Above `maxTools`, keeps the tools most relevant to the latest user message (keyword overlap; pluggable `selector`). Shortens tool and parameter descriptions longer than `maxDescriptionLength`. | `pinned` tools, tools already used in the conversation, the tool forced by `tool_choice` |
| `outputCap` | Sets `max_tokens` when the caller set none. Reasoning models (o-series, gpt-5) are skipped unless `reasoningModels: true`. | A limit the caller set |
| cache | Exact-match response cache (in-memory LRU with TTL, or your own `CacheStore`). | Streaming calls, failed calls, `temperature` above `maxTemperature` or unset |

- **Orchestration:** the client's template messages are never changed. When tools or model
  parameters change, the call goes through a copy of your client built with the optimized
  config; your client object is not modified. Clients built from a fallback list, a JSON string
  or a stored config reference keep their tools and parameters (the event notes this).
- **Failures:** if any step fails, the original request is sent and the event has
  `savings.failed: true`.

### Modes

| Mode | Sends | Cache | Savings in events |
|---|---|---|---|
| `active` | optimized request | serves hits | actual |
| `shadow` | original request | never serves; records would-be hits | what active mode would have saved |
| `off` | original request | not used | none (calls are still measured) |

Start with `shadow` in production, compare `savings` and answer quality, then switch to
`active`, possibly per use case (`useCases.<name>.mode`).

### Cache

- **Key:** the full model config and request, plus the tenant (`scope: "tenant"`, the
  default), the tenant and user (`"user"`) or nothing (`"global"`).
- **What is cached:** only successful, non-streaming calls with `temperature` ≤
  `maxTemperature` (default 0.2). A call without `temperature` uses the provider default
  (usually 1) and is not cached. Set `maxTemperature: null` to cache regardless.
- **Cache hits:** recorded with zero tokens, `savings.cacheHit: true`, and the cached call's
  tokens in `savings.byStep.cache`.
- **Other stores:** the in-memory store is per app instance. For a shared cache, pass a
  `CacheStore` (`get`, `set(key, value, ttlMs)`, sync or async) as `cache.store` in code.
  Values are plain JSON.

### Prompt-caching advisory

Providers cache the start of a prompt (system messages, tool definitions) and bill cached
tokens at a lower rate. When the system prompt or the tools sent for the same use case and
model change between calls, that cache can't be used. The optimizer then:

- sets `advisory.promptPrefixChanged` in the event, with the part that changed (`system`, `tools`);
- counts it in `stats().promptPrefixChanges` and the `cap_ai_optimizer.prompt_cache.prefix_changes` metric;
- emits an `advisory` event and logs a warning at most every 10 minutes per use case.

`causedByOptimizer: true` means your app sent the same prefix but an optimizer step changed
it. Usually this is the `tools` step picking different tools for different questions. If
prompt caching matters more than tool tokens for a use case, raise `maxTools`, pin the
tools, or turn the step off for that use case. Typical causes on the app side are dates,
user names or retrieved content in the system prompt. Move those to a user message.

### Benchmark

```sh
npm run bench                       # estimated savings per step for the prompt corpus (no network)
npm run bench -- --live             # also call AI Core in off and active mode, save both answers
npm run bench -- --live --mock      # the same against the local mock server
```

`--live` saves both answers per conversation to `bench/results/<timestamp>/` so you can
compare quality. Use `--model <name>` for a model deployed in your tenant, `--filter <text>`
to select fixtures and `--config <file>` for an optimizer configuration. The corpus in
`test/fixtures/prompts/` has 12 agent conversations with long histories, repeated
instructions, 36 and 40 tool definitions, code review, RAG context and a compact control
prompt. These are the estimated savings with the default config:

```
Fixture                                    Before  normalize  dedupe  history  tools  After  Saved
01-invoice-json-payload                      1339        525       0        0      0    814  39.2%
02-invoice-long-history                      1154          0       0      774      0    380  67.1%
03-mcp-s4hana-36-tools                       2929        126       0        0   1163   1640  44.0%
04-helpdesk-repeated-instructions             811          0     405        0      0    406  49.9%
05-travel-expense-tool-results               2606        720       0        0      0   1886  27.6%
06-hr-duplicate-system-prompt                 423          0      66        0      0    357  15.6%
07-procurement-40-tools-long-descriptions   10285         82       0        0   7231   2972  71.1%
08-code-review-code-blocks                    218          6       0        0      0    212   2.8%
09-customer-service-rag-context               193         20       0        0      0    173  10.4%
10-analytics-agent-large-results             6704       2340       0     1673      0   2691  59.9%
11-control-compact-prompt                      26          0       0        0      0     26   0.0%
12-multilingual-support-long                 1749          0     728      617      0    404  76.9%
TOTAL                                       28437       3819    1199     3064   8394  11961  57.9%
```

These are estimates on a synthetic corpus. Removing history and tools trades context for
tokens: check answer quality with `--live` and tune `maxTurns` and `maxTools` per use case.

## Configuration reference

Configure in `package.json` (`cds.requires.tokenOptimizer`), `.cdsrc.json`, or environment
variables (e.g. `cds_requires_tokenOptimizer_mode=shadow`). Profiles such as `[production]`
work as usual. Values not set use the defaults below.

```json
"tokenOptimizer": {
  "mode": "active",
  "steps": {
    "normalize": true,
    "dedupe": true,
    "history": { "maxTurns": 10 },
    "tools": { "maxTools": 15, "maxDescriptionLength": 600, "pinned": [] },
    "outputCap": { "default": 1024 }
  },
  "cache": { "enabled": true, "ttlSeconds": 3600, "maxEntries": 1000, "maxTemperature": 0.2, "scope": "tenant" },
  "metrics": {
    "exporters": ["console"],
    "flushIntervalMs": 15000,
    "userHashSalt": "",
    "http": { "url": "", "destination": "", "headers": {} },
    "otel": { "enabled": false, "tenantAttribute": true },
    "db": { "batchSize": 50, "maxQueueSize": 10000, "retentionDays": 30 }
  },
  "pricing": {},
  "useCases": {},
  "timeoutMs": null,
  "retry": { "enabled": false, "maxRetries": 2, "baseDelayMs": 500, "maxDelayMs": 10000,
             "on": ["RATE_LIMIT", "SERVER", "NETWORK", "TIMEOUT"] },
  "autoInstrument": { "enabled": false, "useCase": "default" },
  "advisories": { "promptCache": true },
  "admin": { "enabled": false, "role": "TokenOptimizerAdmin" },
  "captureContent": false
}
```

### General

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"active"` | `active`, `shadow` or `off`. See [Modes](#modes). |
| `useCases.<name>` | `{}` | Any of these settings for one use case, merged over the global ones. Example: `{ "agent": { "steps": { "tools": { "maxTools": 10 } } } }`. |
| `pricing.<model>` | `{}` | `inputPer1k`, `outputPer1k`, optional `cachedInputPer1k` (defaults to `inputPer1k`). Model names with an AI Core prefix (`azure-openai--gpt-4.1`) also match `gpt-4.1`. |
| `timeoutMs` | `null` | Request timeout for calls that set none. `null` uses the SDK default. |
| `retry.enabled` | `false` | Retry failed calls in the wrapper. The SDK itself does not retry. |
| `retry.maxRetries` | `2` | Retries after the first attempt. |
| `retry.baseDelayMs` / `maxDelayMs` | `500` / `10000` | Exponential backoff with jitter; `Retry-After` is used when present (capped at `maxDelayMs`). |
| `retry.on` | `RATE_LIMIT, SERVER, NETWORK, TIMEOUT` | Failure categories to retry. |
| `autoInstrument` | `false` | `true`, or `{ "enabled": true, "useCase": "default" }`. See [autoInstrument](#autoinstrument). |
| `advisories.promptCache` | `true` | [Prompt-caching advisory](#prompt-caching-advisory). |
| `captureContent` | `false` | Adds the messages that were sent and the completion to events (`content`). Keep it off in production: it is personal data. Never written to the database. |

### Steps

Each step accepts `false` (off), `true` (defaults) or an options object (`{ "enabled": false }` also turns it off).

| Key | Default | Meaning |
|---|---|---|
| `steps.normalize.minifyJson` | `true` | Minify JSON blocks that start a line, JSON tool messages and tool-call arguments. |
| `steps.normalize.minifyJsonFences` | `true` | Minify the content of ```` ```json ```` fences. |
| `steps.normalize.collapseSpaces` | `true` | Collapse runs of spaces in prose (not indentation, inline code, tabs). |
| `steps.dedupe.messages` | `true` | Drop repeated system messages and an identical consecutive user message. |
| `steps.dedupe.paragraphs` | `true` | Drop repeated instruction paragraphs. |
| `steps.dedupe.minParagraphLength` | `30` | Shorter paragraphs are never removed. |
| `steps.history.maxTurns` | `10` | Turns to keep. `0` keeps all. |
| `steps.history.strategy` | `"sliding-window"` | Or a function `({ messages, maxTurns, model }) => messages` (in code). |
| `steps.history.summarizer` | `null` | Function `async ({ dropped, kept, model }) => message \| null` (in code). |
| `steps.tools.maxTools` | `15` | Tools to keep when there are more. |
| `steps.tools.maxDescriptionLength` | `600` | Longer tool and parameter descriptions are shortened. `0` keeps them. |
| `steps.tools.pinned` | `[]` | Tool names that are always kept. |
| `steps.tools.selector` | keyword overlap | Function `({ tools, messages, maxTools, keep }) => tools` (in code). |
| `steps.outputCap.default` | `1024` | `max_tokens` for calls that set no limit. |
| `steps.outputCap.reasoningModels` | `false` | Also cap reasoning models. |

### Cache

| Key | Default | Meaning |
|---|---|---|
| `cache.enabled` | `true` | |
| `cache.ttlSeconds` | `3600` | |
| `cache.maxEntries` | `1000` | Size of the in-memory LRU. |
| `cache.maxTemperature` | `0.2` | Only calls with `temperature` at or below are cached. `null`: any. |
| `cache.scope` | `"tenant"` | `tenant`, `user` or `global`. |
| `cache.store` | in-memory | A `CacheStore` object (in code). |

### Metrics and exporters

| Key | Default | Meaning |
|---|---|---|
| `metrics.exporters` | `["console"]` | `console`, `http`, `otel`, `db` (alias `hana`), or exporter objects (in code). |
| `metrics.flushIntervalMs` | `15000` | How often buffering exporters (http, db) send. |
| `metrics.userHashSalt` | `""` | Salt for the user-id hash. Set it from the environment, not in committed files. |
| `metrics.http.url` / `destination` | | Target URL, or a BTP destination name. One is required for `http`. |
| `metrics.http.headers` | `{}` | Extra headers. Don't commit secrets; see [http](#http). |
| `metrics.http.batchSize` | `100` | Events per POST. |
| `metrics.http.maxQueueSize` | `10000` | When full, the oldest events are dropped. |
| `metrics.http.maxRetries` | `3` | Retries per batch per flush. |
| `metrics.http.timeoutMs` | `10000` | Per request. |
| `metrics.http.baseDelayMs` / `maxDelayMs` | `1000` / `30000` | Backoff between retries. |
| `metrics.http.destinationCacheMs` | `300000` | How long a resolved destination is reused. |
| `metrics.otel.enabled` | `false` | Same as adding `otel` to `exporters`. |
| `metrics.otel.tenantAttribute` | `true` | Add `sap.tenancy.tenant_id` to metrics and spans. |
| `metrics.db.batchSize` | `50` | Rows per insert. |
| `metrics.db.maxQueueSize` | `10000` | When full, the oldest rows are dropped. |
| `metrics.db.retentionDays` | `30` | Older rows are deleted (checked at most daily per tenant). `0` keeps all. |

### Admin service

| Key | Default | Meaning |
|---|---|---|
| `admin.enabled` | `false` | Serve the [admin service](#admin-service). |
| `admin.role` | `"TokenOptimizerAdmin"` | Role required to read it. |

### Configuring in code

Functions and stores can only be set in code. `configure()` replaces the whole configuration:

```js
const cds = require('@sap/cds')
const { optimizer } = require('@viveka10/cap-ai-token-optimizer')
const base = cds.env.requires.tokenOptimizer

optimizer.configure({
  ...base,
  steps: { ...base.steps, tools: { ...base.steps?.tools, selector: myEmbeddingSelector } },
  cache: { ...base.cache, store: myRedisStore }
})
```

The `db` exporter and the admin service also need their CDS models. The plugin adds them to
the app's model (also in `cds build` and `cds deploy`) when they are enabled in the
configuration, including profiles and environment variables. Enable them in the
configuration, not only in code.

`createOptimizer(config)` creates a separate instance with its own stats and exporters.

## What is recorded

One event per call:

```json
{ "schemaVersion": 1, "id": "…", "timestamp": "2026-10-10T09:46:29.190Z",
  "tenant": "t1", "user": "3b8d32346718b5af", "cdsService": "AgentService",
  "useCase": "invoice-agent", "mode": "active", "model": "gpt-4.1",
  "deploymentId": null, "resourceGroup": "default", "sdk": "orchestration", "operation": "chat",
  "requestId": "…", "finishReason": "stop", "estimateMethod": "tiktoken",
  "tokens": { "promptEstimatedBefore": 2015, "promptEstimatedAfter": 805,
              "prompt": 805, "completion": 41, "total": 846, "cached": 0 },
  "savings": { "estimatedTokens": 1210,
               "byStep": { "normalize": 96, "dedupe": 340, "history": 774, "tools": 0, "outputCap": 0 },
               "cacheHit": false,
               "notes": ["history: 40 message(s) outside the last 10 turns removed"], "failed": false },
  "costEstimate": 0.001938, "latencyMs": 640, "retries": 0, "status": "success", "error": null,
  "promptHash": "<sha256>", "promptLength": 3120,
  "advisory": { "promptPrefixChanged": false, "changed": [], "causedByOptimizer": false } }
```

- Prompt and completion text are never recorded by default; only a SHA-256 hash and the length.
  `user` is a salted hash of the user id.
- `tokens.prompt`/`completion`/`total`/`cached` come from the AI Core response, for streams
  from the last chunk. Orchestration streams don't report cached tokens (`cached` is 0).
  `promptEstimatedBefore`/`After` are estimates before and after optimization (js-tiktoken for
  OpenAI model families, characters ÷ 4 for other models).
- `savings.estimatedTokens` is estimated prompt tokens saved plus, for cache hits, the cached
  call's tokens. `outputCap` saves output tokens, which can't be known in advance, so it reports 0.
- Failures have `status: "error"` and `error: { category, httpStatus, code, message }` with
  `category` one of `RATE_LIMIT`, `CONTENT_FILTER`, `CONTEXT_LENGTH`, `TIMEOUT`, `AUTH`,
  `DEPLOYMENT_NOT_FOUND`, `SERVER`, `NETWORK`, `UNKNOWN`. The message is truncated to 300 characters.
- Metrics, listener and exporter failures are logged and never break the AI call.

`optimizer.stats()` returns totals since start: calls, success, errors, cacheHits, tokens,
savedTokensEstimate, costEstimate, errorsByCategory, savingsByStep, latency percentiles,
byUseCase, byModel, promptPrefixChanges, and per-exporter stats and errors.

## Exporters

All exporters run outside the AI call. A failing exporter is logged and counted in
`stats().exporterErrors`; it never throws to the caller.

### console

The default. Writes one JSON line per event to stdout, `{"type":"ai-core-call", ...}`.

### http

POSTs batches as `{ "events": [ ... ] }` to a URL or a BTP destination:

```json
"metrics": { "exporters": ["console", "http"], "http": { "destination": "TOKEN_METRICS" } }
```

- **Destinations:** resolved with `@sap-cloud-sdk/connectivity` (installed with
  `@sap-ai-sdk/*`), including their authentication headers, and cached for 5 minutes. Only
  Internet destinations are supported. Locally, the `destinations` environment variable works as usual.
- **When it sends:** on the flush interval, when a batch is full, and on shutdown.
- **Retries:** 429, 5xx, 401 and network errors are retried with backoff (`Retry-After` is
  honoured); other 4xx drop the batch. Batches that still fail stay queued for the next flush.
- **Queue limit:** capped at `maxQueueSize`; the oldest events are dropped when it is full.
  `stats().exporters.http` shows `queued`, `sent`, `dropped`, `failedAttempts`, `rejectedBatches`.
- **Secrets:** don't put secrets in `headers` in committed files. Prefer a destination, or set
  headers from the environment (`cds_requires_tokenOptimizer_metrics_http_headers_Authorization=…`)
  or `.cdsrc-private.json`.

### otel

OpenTelemetry metrics and spans for SAP Cloud ALM, Dynatrace or any OTLP backend.

```sh
npm add @cap-js/telemetry
```
```json
"metrics": { "exporters": ["console", "otel"] }
```

The exporter uses only `@opentelemetry/api` and the providers that `@cap-js/telemetry` (or the
SAP Cloud ALM agent) registers. It never creates its own SDK, so where data goes is
configured in `cds.requires.telemetry`. Without registered providers it logs a warning and
records nothing.

| Metric | Type | Extra attributes |
|---|---|---|
| `gen_ai.client.token.usage` | histogram `{token}` | `gen_ai.token.type` = `input` / `output` |
| `gen_ai.client.operation.duration` | histogram `s` | `error.type` on failures |
| `cap_ai_optimizer.calls` | counter | `error.type` on failures |
| `cap_ai_optimizer.errors` | counter | `error.type` = failure category |
| `cap_ai_optimizer.tokens.saved` | counter `{token}` | `cap_ai_optimizer.step` |
| `cap_ai_optimizer.cache.hits` | counter | |
| `cap_ai_optimizer.cost` | counter | in the currency of your `pricing` |
| `cap_ai_optimizer.prompt_cache.prefix_changes` | counter | `cap_ai_optimizer.prefix_part`, `cap_ai_optimizer.caused_by_optimizer` |

All carry `gen_ai.operation.name`, `gen_ai.provider.name` (`sap.ai_core`),
`gen_ai.request.model`, `cap_ai_optimizer.use_case`, `.mode`, `.sdk` and
`sap.tenancy.tenant_id`. The first two metrics follow the OpenTelemetry GenAI semantic conventions.

The exporter also creates one span per call, `chat <model>` (kind CLIENT), as a child of the
current span (for example the CAP request span from `@cap-js/telemetry`). It carries token
usage, savings, cache hit, AI Core request id, deployment and error attributes, but never
prompt or completion text. The span is recorded when the call ends, with its real start and
end time, so the SDK's HTTP spans are its siblings, not its children.

### db

The usage log for in-app reporting:

```json
"metrics": { "exporters": ["console", "db"] }
```

Writes one row per call to the entity `cap.ai.token_optimizer.TokenUsageLog`
(table `CAP_AI_TOKEN_OPTIMIZER_TOKENUSAGELOG`) through CAP's database service.

- **Databases:** SAP HANA, SQLite or PostgreSQL. `hana` is an alias for `db`.
- **Model:** the plugin adds the entity to your model when the exporter is configured, also in
  `cds build`, so it is part of the MTA's db deployer.
  Deploy as usual (`cds deploy`, or the MTA db deployer), and run your MTX upgrade for multitenant apps.
- **Multitenancy:** rows are inserted in batches on the flush interval with a privileged
  user. Each tenant's rows go to its own container.
- **Content:** only metrics, never prompt or completion text.
- **Retention:** rows older than `retentionDays` (default 30) are deleted.
- **Stats:** `stats().exporters.db` shows `queued`, `written`, `dropped`, `failedWrites`, `deleted`.

Query it from your own services, for example:

```cds
using { cap.ai.token_optimizer.TokenUsageLog } from '@viveka10/cap-ai-token-optimizer/db/token-usage-log';
service ReportingService { @readonly entity AiUsage as projection on TokenUsageLog; }
```

### Custom exporters

Pass an object with `export(event)` and optionally `flush()`, `shutdown()`, `stats()` in
`metrics.exporters` (in code).

## Admin service

```json
"tokenOptimizer": { "admin": { "enabled": true } }
```

Serves the read-only OData V4 service `TokenOptimizerService` at `/odata/v4/token-optimizer`
for users with the role `admin.role` (default `TokenOptimizerAdmin`):

| Path | Content |
|---|---|
| `summary()` | totals, mode, latency percentiles, since |
| `UseCases`, `Models` | totals per use case / model |
| `ErrorCategories` | failures per category |
| `StepSavings` | estimated tokens saved per step |
| `PromptPrefixChanges` | prompt-caching advisories per use case |
| `Exporters` | errors and stats per exporter |
| `UsageLog` | the `TokenUsageLog` rows, if the `db` exporter is enabled (supports `$filter`, `$orderby`, `$top`, …) |

All entries except `UsageLog` are in-memory stats of the app instance that answers, since it started.

To grant access, add the role to `xs-security.json` and a role collection:

```json
{
  "scopes": [{ "name": "$XSAPPNAME.TokenOptimizerAdmin", "description": "Read token optimizer statistics" }],
  "role-templates": [{ "name": "TokenOptimizerAdmin", "scope-references": ["$XSAPPNAME.TokenOptimizerAdmin"] }]
}
```

## SAP Cloud ALM setup

Cloud ALM receives the OpenTelemetry data through the SAP Cloud ALM agent. As documented in
the `@cap-js/telemetry` README ("Running with SAP Cloud ALM (beta)"):

1. **Onboard the app to Cloud ALM.** Install and configure the agent extension
   `@sap/xotel-agent-ext-js` (2.0.4 or later) as described in the SAP Cloud ALM documentation
   (Expert Portal → Data Collection Infrastructure). The agent owns the OpenTelemetry SDK.
2. **Add `@cap-js/telemetry` 2.1.0 or later:** `npm add @cap-js/telemetry`. It detects the
   agent and adds its span processor, metric reader and log processor as delegates to the
   agent instead of creating a second SDK. Version 2.0.x does not have this integration.
3. **Enable the `otel` exporter:** `"metrics": { "exporters": ["console", "otel"] }`.
   Its metrics and spans go through the same pipeline.
4. **Deploy and check.** On startup `@cap-js/telemetry` logs that it found
   `@sap/xotel-agent-ext-js`. The optimizer's spans appear under the CAP request spans.

Notes:

- The Cloud ALM integration in `@cap-js/telemetry` is beta. Running the Cloud ALM agent
  together with Dynatrace OneAgent is not supported.
- Not yet verified against a Cloud ALM tenant.
- Without Cloud ALM, the same exporter works with `@cap-js/telemetry`'s other targets
  (`to-dynatrace`, `to-cloud-logging`, `to-otlp`, …).

## Troubleshooting

**`ERR_REQUIRE_ESM` / "require() of ES Module … @sap-ai-sdk"**
Node.js is older than 22.12. Upgrade Node (`"engines": { "node": ">=22.12" }` in your app, and
the buildpack or `node_version` on Cloud Foundry).

**Jest: "Must use import to load ES Module"**
Jest needs `node --experimental-vm-modules node_modules/jest/bin/jest.js` to load the SDK.

**"Missing peer dependency …" / `PEER_DEPENDENCY_MISSING`**
Install the named package in your app (e.g. `@sap-ai-sdk/foundation-models` for
`chat({ sdk: 'foundation-models' })`, `@opentelemetry/api` for the otel exporter).

**"@sap/cds was loaded from different locations" when starting or testing**
Two copies of `@sap/cds` are loaded. Common causes:

- **`file:` / `npm link` installs:** the linked package's own `node_modules` contains
  `@sap/cds`. Run `npm dedupe`, or remove `node_modules` in the linked package.
- **SAP Business Application Studio:** `NODE_PATH` points to the global CAP tools. A missing
  local package (often `@cap-js/sqlite`, needed by `cds watch` / `cds.test`) is then loaded
  from there, together with its own `@sap/cds`. Install it locally: `npm add -D @cap-js/sqlite`.

**No cache hits**
Only calls with `temperature` ≤ `cache.maxTemperature` (0.2) are cached, and an unset
temperature is not. Streaming calls and failures are never cached. Cache keys include the
tenant, and any change in model config, messages or tools. In `shadow` mode the cache is
never served. Each app instance has its own in-memory cache.

**Note "tools: skipped, the client's tools are fixed"**
The orchestration client was built from a fallback list, a JSON string or a stored config
reference. Use a single inline config to let the `tools` and `outputCap` steps work.

**`model: null` in events**
The model isn't visible in the client config (stored config reference). Calls are unaffected.

**Answers are cut off or empty**
`outputCap` set `max_tokens` (default 1024) because the call set none. Set `max_tokens` in your
model params, or raise `steps.outputCap.default` for that use case.

**Answers lack earlier context or a tool**
Raise `steps.history.maxTurns` or `steps.tools.maxTools`, add tools to `pinned`, or turn the
step off for that use case. Use `shadow` mode and `npm run bench -- --live` to compare.

**Frequent "prompt prefix … changed" warnings**
See [Prompt-caching advisory](#prompt-caching-advisory).

**"otel exporter: no OpenTelemetry MeterProvider is registered"**
Install `@cap-js/telemetry`, and make sure it isn't disabled (`NO_TELEMETRY`) and has a
metrics exporter configured.

**"db exporter disabled: …"**
- *No service definition found for db:* the app has no database configured.
- *Entity … is not in the model:* the exporter was enabled only in code; enable it in
  `cds.requires.tokenOptimizer.metrics.exporters`.

The exporter disables itself in both cases, and calls continue.

**http exporter: events are not arriving**
Check `stats().exporters.http`, or `Exporters` in the admin service:

- `rejectedBatches` > 0: the endpoint answered with a 4xx (see the log).
- `dropped` growing: the endpoint is down longer than the queue holds.
- `destination "…" not found`: check the destination name and the destination service binding.

**Admin service returns 403 / 404**
- 403: the user lacks `admin.role`.
- 404: `admin.enabled` is false, or was set only in code.

**Debug logging**
`DEBUG=token-optimizer`, or `"cds": { "log": { "levels": { "token-optimizer": "debug" } } }`,
shows retries and exporter attempts.

## Sample app

[`sample-cap-agent`](https://github.com/viveka10/npm_token_optimizer/tree/main/sample-cap-agent) is a small CAP app using this package: an `ask`
action and an MCP-style agent with 32 tools and a multi-turn history. In the `development`
profile it starts the mock AI Core server; `hybrid` uses a real AI Core binding.

## Development

```sh
npm test               # unit + integration tests with coverage (mock AI Core server, sample app)
npm run lint
npm run bench          # token-savings benchmark
npm run mock:aicore    # start the mock AI Core server and print an AICORE_SERVICE_KEY to use
npm run test:smoke     # end-to-end smoke test with node:test (also runs on Node 22)
npm run test:live      # real AI Core, see below
```

Tests run Jest with `--experimental-vm-modules` so Jest can load the ESM-only SDK. The
sample-app tests need `npm install` in `../sample-cap-agent` and are skipped otherwise.

The mock AI Core server (`test/mock-aicore/server.js`) mimics the OAuth, deployment,
orchestration and chat-completion endpoints. It can answer normally, or with a rate limit
(429 with `Retry-After`), content filter, context length error, 500, 404, authentication
failure or a slow response. Pick a scenario with the `x-mock-scenario` header, a
`[[mock:<scenario>]]` marker in a message, or `POST /__mock/scenario`.

Live tests (`test/live/`) call a real SAP AI Core instance with one tiny prompt per model
and `max_tokens: 50`. They run only with `npm run test:live` and need credentials:

```sh
AICORE_SERVICE_KEY='{...}' LIVE_TEST_MODELS=gpt-4.1 npm run test:live
cds bind --exec -- npm run test:live          # in a CAP project with an aicore binding
```

`LIVE_TEST_FM_MODELS` adds foundation-models deployments, and `AICORE_RESOURCE_GROUP`
selects the resource group.

## Security

See [SECURITY.md](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/SECURITY.md) to report vulnerabilities and
for how the package handles data. Releases are published from GitHub Actions with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## Contributing

See [CONTRIBUTING.md](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/CONTRIBUTING.md) and the
[CHANGELOG](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/CHANGELOG.md).

## License

MIT. Not affiliated with or endorsed by SAP. SAP, SAP BTP, SAP HANA and SAP Cloud ALM are
trademarks of SAP SE.

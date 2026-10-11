# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-10-11

### Fixed

- **Token usage of streaming calls.** `stream()` calls (including LangChain models with
  streaming, as used by `@cap-js/agents`) were recorded when the stream opened, without token
  usage. They are now recorded when the stream ends, with AI Core's usage, finish reason, request
  id and cost.
- **Errors inside a stream** were not recorded, and the call counted as a success. They are now
  recorded as errors and classified from the error event AI Core sends (for example `SERVER`,
  `RATE_LIMIT`, `CONTENT_FILTER`).
- **`cds build` and `cds deploy` left out the plugin's models.** The `TokenUsageLog` entity and
  the admin service were added to `cds.env` when the plugin loaded, but `cds build` rebuilds
  `cds.env` afterwards, so the MTA had no usage-log table and no admin service. The models now
  come from the plugin's `.cdsrc.js` and are computed from the app's final configuration
  (profiles and environment variables included). Apps that worked around this by listing the
  models in `cds.requires.tokenOptimizer.model` keep working and can remove the list.
- **Admin service for Fiori elements:** the in-memory entities (`UseCases`, `Models`,
  `ErrorCategories`, `StepSavings`, `PromptPrefixChanges`, `Exporters`) answered `$count=true`
  with 0, so list reports showed empty tables, and `UseCases` and `Models` returned `tokens` as a
  nested object instead of the `tokens_*` columns of their OData metadata.

### Changed

- `latencyMs` of streaming calls now covers the whole answer instead of the time until the
  stream opened. A stream closed early by the caller, or not read within 10 minutes, is recorded
  at that point without usage and with a note in `savings.notes`.
- The mock AI Core server answers streaming requests as server-sent events and has a
  `stream_error` scenario.

## [0.1.1] - 2026-10-10

### Added

- Guide "Add to an existing CAP app on SAP BTP" (`docs/existing-cap-app-on-btp.md`): AI Core
  service binding, `mta.yaml`, secrets, HANA usage log, admin role, and SAP Cloud ALM setup.

### Changed

- Package description, keywords and README introduction, so the package is easier to find.

## [0.1.0] - 2026-10-10

First public release.

### Added

- **Client wrapper:** `optimizer.wrap()` for `OrchestrationClient` (`chatCompletion`, `stream`)
  and `AzureOpenAiChatClient` (`run`, `stream`) from `@sap-ai-sdk/*` 2.x. It keeps the client's
  API and never modifies the caller's client or request objects.
- **Explicit calls:** `optimizer.chat()` for orchestration or foundation models.
- **CAP plugin:** configuration from `cds.requires.tokenOptimizer`, exporter flush on shutdown,
  and tokenizer warm-up after the server starts.
- **Optimization pipeline:** `normalize`, `dedupe`, `history` (pluggable strategy, summarizer
  hook), `tools` (pluggable selector, pinned tools, description shortening) and `outputCap`.
  Each step can be switched off and reports its estimated savings. Per-use-case configuration.
- **Exact-match response cache:** in-memory LRU with TTL, a pluggable `CacheStore`, and tenant,
  user or global scope. Only temperature ≤ 0.2 by default.
- **Modes:** `active`, `shadow` (measures savings, sends the original request) and `off`.
- **Prompt-caching advisory:** a warning, event field, stat and metric when the system prompt or
  tools change between calls of the same use case and model, including whether the optimizer
  caused it.
- **Metrics:** one event per call with real and estimated tokens, savings per step, cost
  estimate, latency, retries, cache hit, hashed user, tenant and service from `cds.context`, and
  a classified error. Prompt and completion text only with `captureContent: true`.
- **Failure classifier:** `RATE_LIMIT`, `CONTENT_FILTER`, `CONTEXT_LENGTH`, `TIMEOUT`, `AUTH`,
  `DEPLOYMENT_NOT_FOUND`, `SERVER`, `NETWORK`, `UNKNOWN`.
- **Opt-in retries** with backoff and `Retry-After`, and a default request timeout.
- **Exporters:**
  - `console`
  - `http` (URL or BTP destination, batching, retries, bounded queue)
  - `otel` (OpenTelemetry GenAI metrics and spans through `@cap-js/telemetry` / SAP Cloud ALM)
  - `db` / `hana` (`TokenUsageLog` entity, multitenant, retention)
- **Admin service:** read-only `TokenOptimizerService` at `/odata/v4/token-optimizer` with a
  configurable role.
- **Testing and benchmark:**
  - token-savings benchmark (`npm run bench`) with 12 agent conversations, and `--live`
    off/active answer comparison
  - mock AI Core server for tests and local development
  - sample CAP app `sample-cap-agent`
- **Instrumenting existing code:** `autoInstrument` hooks the `@sap-ai-sdk` client classes so
  existing apps need no code changes. `optimizer.withUseCase()` labels the calls made inside a
  function.
- **LangChain:** `optimizer.wrapLangChain()` for `@sap-ai-sdk/langchain` chat models.
- **Compatibility:**
  - tested on Node 22.12+ and 24, `@sap/cds` 9 and 10, `@sap-ai-sdk` 2.8 to 2.16;
  - CI matrix (`.github/workflows/ci.yml`);
  - smoke test with `node:test` for Node 22.
- **Integration guide:** "Add to an existing CAP app in 5 minutes" (`docs/integration-guide.md`).
- **TypeScript definitions** (`index.d.ts`).

### Known limitations

- `stream()` calls are passed through without optimization or token usage.
- `autoInstrument` only hooks the SDK copy resolved from the app root, and is process-wide.
- The Jest suite needs Node ≥ 24.9; the runtime supports Node ≥ 22.12.
- Clients built from orchestration fallback lists, JSON strings or stored config references
  keep their tools and model parameters (the `tools` and `outputCap` steps are skipped).
- Token estimates use tiktoken for OpenAI model families and characters ÷ 4 for others.
- The `http` exporter supports Internet destinations only.
- Not yet verified against SAP Cloud ALM; live AI Core tests are opt-in.

[Unreleased]: https://github.com/viveka10/npm_token_optimizer/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/viveka10/npm_token_optimizer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/viveka10/npm_token_optimizer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/viveka10/npm_token_optimizer/releases/tag/v0.1.0

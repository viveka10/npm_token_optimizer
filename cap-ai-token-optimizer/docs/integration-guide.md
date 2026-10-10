# Add @viveka10/cap-ai-token-optimizer to an existing CAP app in 5 minutes

This guide adds token measurement to a CAP Node.js app that already calls SAP AI Core
through the SAP Cloud SDK for AI. The first steps change no code and no prompts. You start
in shadow mode, look at the numbers, and switch to optimization when you're ready.

## 1. Check the prerequisites (30 seconds)

```sh
node --version                                  # v22.12 or later
npm ls @sap/cds @sap-ai-sdk/orchestration @sap-ai-sdk/foundation-models
```

You need `@sap/cds` 9 or 10, and `@sap-ai-sdk/orchestration` and/or
`@sap-ai-sdk/foundation-models` 2.8 or later. Each `@sap-ai-sdk` package should appear once in
the tree (see [Limits](#limits-of-automatic-instrumentation)).

## 2. Install (1 minute)

```sh
npm add @viveka10/cap-ai-token-optimizer
```

The package is a CAP plugin, so there's nothing to register.

## 3. Turn on measurement without code changes (1 minute)

Add to `package.json` (or `.cdsrc.json`):

```json
{
  "cds": {
    "requires": {
      "tokenOptimizer": {
        "mode": "shadow",
        "autoInstrument": true
      }
    }
  }
}
```

- `autoInstrument` hooks the SDK's `OrchestrationClient` and `AzureOpenAiChatClient`, so every
  call your app already makes is measured.
- `shadow` runs the optimizer but sends your original prompts: you see what would be saved,
  and nothing about your AI calls changes.

## 4. Run and look (1 minute)

```sh
cds watch
```

Use the feature of your app that calls AI Core. Each call prints one line like:

```json
{"type":"ai-core-call","useCase":"default","mode":"shadow","model":"gpt-4.1",
 "tokens":{"promptEstimatedBefore":2015,"promptEstimatedAfter":805,"prompt":2010,"completion":41,...},
 "savings":{"estimatedTokens":1210,"byStep":{"history":774,"dedupe":340,"normalize":96,...},...},
 "status":"success","latencyMs":640,...}
```

`savings.estimatedTokens` is what active mode would have saved on this call;
`savings.byStep` shows which step saved it.

For a summary, enable the admin service in the same configuration block
(`"admin": { "enabled": true }`), give your user the `TokenOptimizerAdmin` role, and open
`/odata/v4/token-optimizer/summary()`.

## 5. Name your use cases (1 minute, optional)

Calls found by `autoInstrument` are grouped under the use case `default`. Name them where
your handlers call AI Core, without touching the client code:

```js
const { optimizer } = require('@viveka10/cap-ai-token-optimizer')

this.on('summarizeTicket', req =>
  optimizer.withUseCase('ticket-summary', () => summarize(req.data.ID)))
```

For LangChain models from `@sap-ai-sdk/langchain`, wrap the model once:

```js
const { OrchestrationClient } = require('@sap-ai-sdk/langchain')
const model = optimizer.wrapLangChain(new OrchestrationClient(config), { useCase: 'support-agent' })
```

For clients you create yourself, you can also use `optimizer.wrap(client, { useCase })`.

## 6. Switch on optimization (30 seconds)

When the savings and the answers look right, switch the mode, for one use case or for all:

```json
"tokenOptimizer": {
  "mode": "shadow",
  "autoInstrument": true,
  "useCases": {
    "ticket-summary": { "mode": "active" }
  }
}
```

In `active` mode the optimized prompt is sent and identical low-temperature calls are
answered from the cache. Compare answer quality before and after with
`npm run bench -- --live` in the package, or by comparing `shadow` and `active` events
for the same requests.

## Before going to production

- **`pricing`:** set prices per model from your contract to get `costEstimate`.
- **`metrics.userHashSalt`:** set it from the environment
  (`cds_requires_tokenOptimizer_metrics_userHashSalt`), not in committed files.
- **Reporting:** add `otel` (with `@cap-js/telemetry`, for SAP Cloud ALM or Dynatrace), `db`
  (usage log table) or `http` to `metrics.exporters`.
- **`captureContent`:** keep it off.
- **Admin role:** add the `TokenOptimizerAdmin` role to `xs-security.json` if you enabled the
  admin service.

## Limits of automatic instrumentation

- **Clients:** only `OrchestrationClient` (`chatCompletion`, `stream`) and
  `AzureOpenAiChatClient` (`run`, `stream`) from `@sap-ai-sdk` 2.x are hooked. This includes the
  ones that `@sap-ai-sdk/langchain` creates internally. Embedding clients and direct HTTP calls
  to AI Core are not measured.
- **SDK copy:** the hooks are installed on the copy of each SDK package resolved from your
  app's root. If `npm ls @sap-ai-sdk/orchestration` shows a second, nested copy, calls through
  that copy are not measured; run `npm dedupe` or align the versions.
- **Scope:** the hooks apply to every caller in the process, including libraries. If you want
  to choose exactly which calls are optimized, leave `autoInstrument` off and use `wrap()`,
  `withUseCase()` and `wrapLangChain()` instead.
- **Streaming:** `stream()` calls are measured but not optimized, and have no token usage.
- **Use cases:** without `withUseCase()`, all hooked calls share the use case set in
  `autoInstrument.useCase` (default `default`), so per-use-case settings apply to all of them.
- **Start-up:** the hooks are installed when the CAP plugin loads. Outside CAP, call
  `optimizer.configure({ autoInstrument: true })`.
- **Turning it off:** `"autoInstrument": false` or
  `cds_requires_tokenOptimizer_autoInstrument=false`. With it off, the hooks call the SDK's
  original methods unchanged.

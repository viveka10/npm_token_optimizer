# Add @viveka10/cap-ai-token-optimizer to an existing CAP app on SAP BTP

This guide is for a CAP Node.js app on SAP BTP Cloud Foundry that already calls SAP AI Core
through the SAP Cloud SDK for AI (`@sap-ai-sdk/*`) with an **AI Core service binding**. It
covers the changes to the app, deployment (`mta.yaml`, `xs-security.json`) and SAP Cloud ALM.

**What stays the same**

- **AI Core binding:** no change. The SDK keeps reading it from `VCAP_SERVICES`.
- **AI code:** no change needed. Automatic instrumentation measures the existing calls.
- **Prompts:** you start in `shadow` mode, which sends your original prompts unchanged.

**Contents**

1. [Check the prerequisites](#1-check-the-prerequisites)
2. [Install the package](#2-install-the-package)
3. [Configure it](#3-configure-it)
4. [Code changes (optional)](#4-code-changes-optional)
5. [Local testing with the AI Core binding](#5-local-testing-with-the-ai-core-binding)
6. [Secrets and environment](#6-secrets-and-environment)
7. [Usage log in SAP HANA (optional)](#7-usage-log-in-sap-hana-optional)
8. [Admin service and roles (optional)](#8-admin-service-and-roles-optional)
9. [SAP Cloud ALM](#9-sap-cloud-alm)
10. [Deploy and verify](#10-deploy-and-verify)
11. [Switch from shadow to active](#11-switch-from-shadow-to-active)
12. [Turn it off or roll back](#12-turn-it-off-or-roll-back)

---

## 1. Check the prerequisites

In the app's root folder:

```sh
node --version
npm ls @sap/cds @sap-ai-sdk/orchestration @sap-ai-sdk/foundation-models @sap-ai-sdk/langchain
```

| Requirement | Why |
|---|---|
| Node.js **22.12 or later**, locally and on Cloud Foundry | The SAP Cloud SDK for AI is ESM-only; Node 22.12+ can load it from CommonJS. |
| `"engines": { "node": ">=22.12" }` in the app's `package.json` | The Cloud Foundry Node.js buildpack picks the Node version from `engines`. |
| `@sap/cds` 9 or 10 | Tested versions. |
| `@sap-ai-sdk/*` **2.8 or later**, all packages on the **same** version, each listed **once** | The packages share internal APIs. Automatic instrumentation only hooks the copy resolved from the app root. If `npm ls` shows nested copies, run `npm dedupe` or align the versions. |

## 2. Install the package

```sh
npm add @viveka10/cap-ai-token-optimizer
```

It is a CAP plugin, so there's nothing to register: CAP loads it at startup.

## 3. Configure it

Add the `tokenOptimizer` block to `cds.requires` in the app's `package.json` (or `.cdsrc.json`).
This starting configuration measures everything without changing any AI call:

```json
{
  "cds": {
    "requires": {
      "tokenOptimizer": {
        "mode": "shadow",
        "autoInstrument": true,
        "pricing": {
          "gpt-4.1": { "inputPer1k": 0.0, "outputPer1k": 0.0 }
        },
        "metrics": { "exporters": ["console"] },
        "[production]": {
          "metrics": { "exporters": ["console", "otel"] },
          "admin": { "enabled": true }
        }
      }
    }
  }
}
```

| Setting | What it does |
|---|---|
| `mode: "shadow"` | Runs the optimizer and records what it *would* save, but sends the original prompts. |
| `autoInstrument: true` | Hooks the SDK's `OrchestrationClient` and `AzureOpenAiChatClient`, so existing calls are measured without code changes. |
| `pricing` | Price per 1k tokens per model, from your SAP contract. Leave it out if you don't need cost estimates. |
| `metrics.exporters` | Where events go. `console` writes one JSON line per AI call to the app log (`cf logs`). `otel` sends OpenTelemetry metrics and spans (see [SAP Cloud ALM](#9-sap-cloud-alm)). `db` writes a usage table (see [step 7](#7-usage-log-in-sap-hana-optional)). |
| `admin.enabled` | Serves the read-only statistics service at `/odata/v4/token-optimizer` (see [step 8](#8-admin-service-and-roles-optional)). |

All options are described in the [configuration reference](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/README.md#configuration-reference).

## 4. Code changes (optional)

With `autoInstrument: true`, no code change is needed. All hooked calls are recorded under
the use case `default`. These optional changes give you better reporting and per-use-case
settings:

**Name the use cases** where your handlers call AI Core:

```js
const { optimizer } = require('@viveka10/cap-ai-token-optimizer')

this.on('summarizeTicket', req =>
  optimizer.withUseCase('ticket-summary', () => this.summarize(req.data.ID)))
```

**LangChain models** from `@sap-ai-sdk/langchain`: wrap them once where you create them:

```js
const model = optimizer.wrapLangChain(new OrchestrationClient(config), { useCase: 'support-agent' })
```

**Better error responses** (optional): the SDK's errors are passed through unchanged, and
`classifyError` tells you what happened:

```js
const { classifyError } = require('@viveka10/cap-ai-token-optimizer')
try { /* AI call */ } catch (err) {
  const { category } = classifyError(err)   // RATE_LIMIT, CONTENT_FILTER, CONTEXT_LENGTH, TIMEOUT, …
  return req.reject(category === 'RATE_LIMIT' ? 429 : 502, `AI service error: ${category}`)
}
```

Use cases can then get their own settings, for example
`"useCases": { "ticket-summary": { "steps": { "outputCap": { "default": 300 } } } }`.

## 5. Local testing with the AI Core binding

Nothing changes in how the app gets its AI Core credentials. The SDK reads the `aicore` binding
from `VCAP_SERVICES`. If you already test locally with `cds bind`, keep doing that:

```sh
cf login …
cds bind aicore --to <your-aicore-instance>:<service-key>    # once; writes .cdsrc-private.json (keep it out of git)
cds bind --exec -- cds watch --profile hybrid                # VCAP_SERVICES is set for the SDK
```

Call the feature that uses AI Core. The console shows one line per call:

```json
{"type":"ai-core-call","useCase":"default","mode":"shadow","model":"gpt-4.1",
 "tokens":{"promptEstimatedBefore":2015,"promptEstimatedAfter":805,"prompt":2010,"completion":41,…},
 "savings":{"estimatedTokens":1210,"byStep":{"history":774,"dedupe":340,…},…},"status":"success",…}
```

`savings` shows what `active` mode would have saved on that call.

## 6. Secrets and environment

**User-id hash salt.** User ids are recorded as a hash. Set a random salt per landscape, but
**not** in `package.json` or `mta.yaml` if they are in git. Use an MTA extension descriptor that
you keep out of git:

```yaml
# secrets.mtaext   (do not commit)
_schema-version: '3.1'
ID: my-cap-app.secrets
extends: my-cap-app
modules:
  - name: my-cap-app-srv
    properties:
      cds_requires_tokenOptimizer_metrics_userHashSalt: <long random string>
```

```sh
cf deploy mta_archives/my-cap-app_1.0.0.mtar -e secrets.mtaext
```

**Overriding settings without a rebuild.** Any setting can be overridden with an environment
variable in the same format, for example `cds_requires_tokenOptimizer_mode=off`, followed by
`cf restart`.

Never set `captureContent: true` in production. It adds prompt and answer text to events.

## 7. Usage log in SAP HANA (optional)

To keep one row per AI call in the app's database (for reporting or your own analytics), add
the `db` exporter:

```json
"[production]": { "metrics": { "exporters": ["console", "otel", "db"] }, "admin": { "enabled": true } }
```

- The plugin adds the entity `cap.ai.token_optimizer.TokenUsageLog` to your model, also in
  `cds build --production`. It is deployed with your normal HANA deployment (the `db-deployer`
  module in the MTA), so there's no extra step. With version 0.1.1 the entity was missing from
  `cds build`; there, list the models in `cds.requires.tokenOptimizer.model` as a workaround.
- **Multitenant apps (MTX):** each tenant's rows go to that tenant's container. Run your
  usual tenant upgrade after deploying, so existing tenants get the new table.
- Rows older than 30 days are deleted (`metrics.db.retentionDays`). No prompt or answer text
  is stored.
- With the admin service enabled, the rows are readable at `/odata/v4/token-optimizer/UsageLog`.
- To expose the table in your own service:
  ```cds
  using { cap.ai.token_optimizer.TokenUsageLog } from '@viveka10/cap-ai-token-optimizer/db/token-usage-log';
  service ReportingService { @readonly entity AiUsage as projection on TokenUsageLog; }
  ```

> The usage log has been tested with SQLite. It hasn't been tested on SAP HANA or with MTX
> yet, so check it in a development space first.

## 8. Admin service and roles (optional)

With `admin.enabled`, the app serves `/odata/v4/token-optimizer`:

| Path | Content |
|---|---|
| `summary()` | totals, mode, latency percentiles |
| `UseCases`, `Models`, `ErrorCategories`, `StepSavings`, `PromptPrefixChanges`, `Exporters` | statistics of the app instance that answers (in memory, since its start) |
| `UsageLog` | the usage table, when the `db` exporter is on |

It requires the role `TokenOptimizerAdmin` (configurable with `admin.role`). Add it to
`xs-security.json`:

```json
{
  "scopes": [
    { "name": "$XSAPPNAME.TokenOptimizerAdmin", "description": "Read AI token usage statistics" }
  ],
  "role-templates": [
    { "name": "TokenOptimizerAdmin", "scope-references": ["$XSAPPNAME.TokenOptimizerAdmin"] }
  ],
  "role-collections": [
    { "name": "AI_Token_Optimizer_Admin", "role-template-references": ["$XSAPPNAME.TokenOptimizerAdmin"] }
  ]
}
```

Merge this into your existing file; don't replace it. After deploying, assign the role
collection to the right users in the BTP cockpit (Security → Role Collections).

## 9. SAP Cloud ALM

The optimizer has no Cloud ALM-specific code. Its `otel` exporter writes OpenTelemetry metrics
and one span per AI call through whatever OpenTelemetry setup the app has. For Cloud ALM, that
setup is SAP's Cloud ALM agent plus `@cap-js/telemetry`. The agent setup below follows SAP's
documentation:
[Data Collection Infrastructure](https://support.sap.com/en/alm/sap-cloud-alm/operations/expert-portal/data-collection-infrastructure.html) and
[Auto-instrumentation for Node.js](https://support.sap.com/en/alm/sap-cloud-alm/operations/expert-portal/data-collection-infrastructure/autoinstrumentation-nodejs.html).
Check those pages for changes before you start.

### 9.1 Prerequisites

- An SAP Cloud ALM tenant, with the **SAP Cloud ALM API** enabled and a service key for it
  ([Enabling SAP Cloud ALM API](https://help.sap.com/docs/cloud-alm/setup-administration/enabling-sap-cloud-alm-api)).
- A technical user for SAP's **Repository Based Shipment Channel** (RBSC), which distributes
  the agent. Request it at https://ui.repositories.cloud.sap/www/webapp/users. The agent isn't
  on the public npm registry.

### 9.2 Get access to SAP's package repository

Set `SAP_NPM_AUTH` to the "NPM Base64 Credentials" of the technical user (`base64(user:password)`),
in your shell and in your CI/build pipeline (as a secret), and add to the app's `.npmrc`:

```
//73555000100200018064.npmsrv.cdn.repositories.cloud.sap/:_auth=${SAP_NPM_AUTH}
```

### 9.3 Add the agent and @cap-js/telemetry

In the app's `package.json`:

```json
{
  "dependencies": {
    "@sap/xotel-agent-ext-js": "https://73555000100200018064.npmsrv.cdn.repositories.cloud.sap/@sap/xotel-agent-ext-js/-/xotel-agent-ext-js-2.0.4.tgz",
    "@cap-js/telemetry": "^2.1.0"
  },
  "scripts": {
    "start": "node ${NODE_ARGS} ./node_modules/.bin/cds-serve"
  }
}
```

- **Agent version:** 2.0.4 or later. That is the version from which `@cap-js/telemetry`
  supports it, and it uses OpenTelemetry 2.x.
- **`@cap-js/telemetry` version:** 2.1.0 or later. It detects the agent and adds its span
  processor, metric reader and log processor to the agent's pipeline instead of starting a
  second OpenTelemetry SDK. Version 2.0.x doesn't have this integration.
- **Start script:** loads the agent before CAP via `NODE_ARGS` (set in `mta.yaml` below).
  After `cds build`, check that `gen/srv/package.json` contains this start script.
- **Dependency conflicts:** SAP notes that the agent's OpenTelemetry 2.x libraries can
  conflict with other OpenTelemetry packages in the app. `@viveka10/cap-ai-token-optimizer`
  itself only uses `@opentelemetry/api`.

### 9.4 Enable the otel exporter

```json
"tokenOptimizer": { "[production]": { "metrics": { "exporters": ["console", "otel"] } } }
```

### 9.5 mta.yaml

```yaml
modules:
  - name: my-cap-app-srv
    type: nodejs
    path: gen/srv
    properties:
      SAP_CALM_SERVICE_NAME: my-cap-app-srv     # name shown in Cloud ALM
      SAP_CALM_SERVICE_TYPE: SAP_CP_CF
      NODE_ARGS: -r @sap/xotel-agent-ext-js
    requires:
      - name: my-cap-app-aicore                 # existing AI Core binding, unchanged
      - name: my-cap-app-auth                   # existing XSUAA
      - name: my-cap-app-db                     # existing, only needed for the db exporter
      - name: my-cap-app-destination            # new: used by the Cloud ALM agent

resources:
  - name: my-cap-app-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
```

**Staging needs the agent's repository.** Cloud Foundry installs dependencies during staging,
so it has to reach SAP's repository too. SAP suggests, if staging fails, shipping
`node_modules` and `package-lock.json` inside the MTA archive: remove them from the module's
`build-parameters.ignore` list, and install them into `gen/srv` with a `before-all` custom
build step (`npm install --production` and `npm install --prefix ./gen/srv`).

### 9.6 Destination for Cloud ALM

In the **provider subaccount** (BTP cockpit → Connectivity → Destinations), create:

| Field | Value |
|---|---|
| Name | `CALM_datacollector` (exactly this name) |
| Type | HTTP |
| URL | the `Api` URL from the Cloud ALM API service key, e.g. `https://eu10.alm.cloud.sap/api` |
| Proxy Type | Internet |
| Authentication | OAuth2ClientCredentials |
| Client ID / Client Secret | from the Cloud ALM API service key |
| Token Service URL | the `url` from the service key |

SAP notes that "Check Connection" can return 404 even when the destination is correct.

### 9.7 Activate monitoring in Cloud ALM

In SAP Cloud ALM, activate the monitoring use cases you need for the service (for example
Health Monitoring and Exception Monitoring). Optional agent settings and how to turn the agent
off (`SAP_CALM_INSTRUMENTATION_ENABLED=false`) are on SAP's auto-instrumentation page.

### 9.8 What you'll see, and what isn't verified

- **App log after deploying:** a line from `@cap-js/telemetry` saying it found
  `@sap/xotel-agent-ext-js` and added its span processor as a delegate. The optimizer logs a
  warning if no OpenTelemetry metrics provider is registered.
- **Spans:** the optimizer's `chat <model>` spans are children of the CAP request spans and
  carry token usage, savings and error category, never prompt text. They go through the same
  pipeline as the CAP spans.
- **Not documented by SAP:** whether Cloud ALM shows **custom** OpenTelemetry metrics (like
  `gen_ai.client.token.usage` or `cap_ai_optimizer.tokens.saved`) in its UIs. Its documented
  use cases are Health, Exception, Job & Automation, Business Process and Real User Monitoring.
- **Not verified:** this setup hasn't been tested against a Cloud ALM tenant.

If you need token dashboards, use the `db` exporter with the admin service or your own
reporting service, or send the `otel` data to SAP Cloud Logging or Dynatrace via
`@cap-js/telemetry` (`cds.requires.telemetry.kind` = `to-cloud-logging` / `to-dynatrace`).
Note that with the agent present, `@cap-js/telemetry` also exports through its own
configured kind (console by default), so check the log volume after deploying.

## 10. Deploy and verify

```sh
npm install                 # updates package-lock.json
mbt build
cf deploy mta_archives/<your-app>_<version>.mtar -e secrets.mtaext
```

Then check:

1. **Logs:** `cf logs my-cap-app-srv --recent` shows
   `autoInstrument: OrchestrationClient … calls are optimized and measured` at startup, and one
   `"type":"ai-core-call"` line per AI call.
2. **Admin service:** with the `TokenOptimizerAdmin` role, open
   `https://<app-url>/odata/v4/token-optimizer/summary()`.
3. **Cloud ALM:** the service appears under `SAP_CALM_SERVICE_NAME` in the activated
   monitoring apps.
4. **Behavior:** your AI features answer exactly as before (shadow mode sends the original prompts).

## 11. Switch from shadow to active

After a few days in shadow mode, compare `savings.estimatedTokens` and the notes in the events
or the admin service per use case. Then switch one use case at a time:

```json
"tokenOptimizer": {
  "mode": "shadow",
  "useCases": {
    "ticket-summary": { "mode": "active" }
  }
}
```

In `active` mode the optimized prompts are sent, and identical calls with `temperature` ≤ 0.2
are answered from the cache, which is per app instance and per tenant. Check answer quality
for that use case before switching the next one. If an agent needs more context or tools,
raise `steps.history.maxTurns` or `steps.tools.maxTools`, or pin the tools it needs, for that
use case.

## 12. Turn it off or roll back

| Goal | How |
|---|---|
| Stop optimizing, keep measuring | `cds_requires_tokenOptimizer_mode=off`, then `cf restart` |
| Stop hooking the SDK | `cds_requires_tokenOptimizer_autoInstrument=false`, then `cf restart` |
| Turn off the Cloud ALM agent | `SAP_CALM_INSTRUMENTATION_ENABLED=false`, then `cf restart` |
| Remove the package | `npm rm @viveka10/cap-ai-token-optimizer`, delete the `tokenOptimizer` block, redeploy. If you used the `db` exporter, the `TokenUsageLog` table stays until you drop it. |

## Checklist

- [ ] Node ≥ 22.12 and `engines` set; `@sap-ai-sdk/*` ≥ 2.8, same version, no duplicates
- [ ] `npm add @viveka10/cap-ai-token-optimizer`
- [ ] `tokenOptimizer` block with `mode: "shadow"` and `autoInstrument: true`; `pricing` filled in
- [ ] Salt and other secrets in an `.mtaext` that is not committed
- [ ] Optional: `withUseCase` / `wrapLangChain` for named use cases
- [ ] Optional: `db` exporter (HANA table deployed with the app; MTX upgrade)
- [ ] Optional: admin service plus `TokenOptimizerAdmin` role collection
- [ ] Cloud ALM:
  - [ ] RBSC user and `SAP_NPM_AUTH`
  - [ ] agent ≥ 2.0.4 and `@cap-js/telemetry` ≥ 2.1.0
  - [ ] `NODE_ARGS`, `SAP_CALM_*` properties and destination service in `mta.yaml`
  - [ ] `CALM_datacollector` destination
  - [ ] monitoring use cases activated in Cloud ALM
  - [ ] `otel` exporter enabled
- [ ] Deploy, check logs and the admin service, then switch use cases to `active` one by one

# Add an AI usage dashboard to your CAP agent

This guide is for developers who already have a **SAP CAP (Node.js) app with an AI agent**
that calls SAP AI Core. For example, an agent built with `@cap-js/agents`, LangChain with
`@sap-ai-sdk/langchain`, or the SAP Cloud SDK for AI (`@sap-ai-sdk/orchestration`).

At the end, your app serves a dashboard at `/token-optimizer/dashboard/` with:

- total tokens, cost, calls and failures, tokens saved, cache hits and latency
- charts of tokens, calls and cost over the last 24 hours, 7, 30 or 90 days, per model,
  use case or CDS service
- tokens per model and per use case, failures per category
- the largest calls and the latest failures
- a table view for every chart

You don't write UI code, build a UI project or add other libraries. The dashboard comes with
the npm package.

**Time needed:** about 10 minutes locally, plus your usual BTP deployment.

---

## Before you start

| You need | Check |
|---|---|
| Node.js 22.12 or newer | `node -v` |
| `@sap/cds` 9 or 10 | `npm ls @sap/cds` |
| `@sap-ai-sdk/*` 2.8 or newer (your agent already uses it) | `npm ls @sap-ai-sdk/orchestration` |
| A database for the app (SQLite locally, SAP HANA on BTP) | `cds.requires.db` in `package.json` |

---

## Step 1: Install the package

```sh
npm add @viveka10/cap-ai-token-optimizer
```

CAP loads it as a plugin automatically. You don't need to `require()` it anywhere.

> If npm reports a peer dependency conflict with `@sap-ai-sdk/langchain`, move all
> `@sap-ai-sdk/*` packages to the same version (2.16 or newer).

## Step 2: Turn it on in `package.json`

Add a `tokenOptimizer` block under `cds.requires`:

```json
{
  "cds": {
    "requires": {
      "tokenOptimizer": {
        "mode": "shadow",
        "autoInstrument": { "enabled": true, "useCase": "my-agent" },
        "metrics": { "exporters": ["console", "db"] },
        "dashboard": true
      }
    }
  }
}
```

What each line does:

| Setting | Meaning |
|---|---|
| `"mode": "shadow"` | Measure only. Your prompts are sent unchanged. Safe to start with. |
| `"autoInstrument"` | Measures your agent's AI Core calls without code changes. `useCase` is the name the calls get on the dashboard. |
| `"exporters": ["console", "db"]` | `db` stores one row per AI call (no prompt text), which gives the dashboard its history. `console` writes one log line per call. |
| `"dashboard": true` | Serves the dashboard. It also turns on the read-only admin service at `/odata/v4/token-optimizer`, which the dashboard reads. |

Optional: add your contract prices to see cost:

```json
"pricing": { "gpt-4.1": { "inputPer1k": 0.002, "outputPer1k": 0.008 } }
```

## Step 3: Try it locally

1. Give your local test user the role `TokenOptimizerAdmin`:

   ```json
   "auth": {
     "[development]": {
       "kind": "mocked",
       "users": { "alice": { "password": "alice", "roles": ["TokenOptimizerAdmin"] } }
     }
   }
   ```

2. Start the app with a fresh database, so that the usage log table exists:

   ```sh
   cds watch --in-memory
   ```

   With a SQLite file instead, run `cds deploy` once first.

3. Call your agent a few times, then open
   <http://localhost:4004/token-optimizer/dashboard/> and log in as `alice`.

The charts fill as your agent makes calls.

## Step 4: Add the role on BTP

Add the role to `xs-security.json`, next to your existing scopes and role templates:

```json
{
  "scopes": [
    { "name": "$XSAPPNAME.TokenOptimizerAdmin", "description": "Read AI token usage" }
  ],
  "role-templates": [
    { "name": "TokenOptimizerAdmin", "scope-references": ["$XSAPPNAME.TokenOptimizerAdmin"] }
  ],
  "role-collections": [
    { "name": "AI_Token_Usage_Viewer", "role-template-references": ["$XSAPPNAME.TokenOptimizerAdmin"] }
  ]
}
```

Merge this into your existing file; don't replace it.

> To use a role you already have instead (for example the role of an existing Fiori app),
> set `"admin": { "role": "YourRole" }` in the `tokenOptimizer` block. The dashboard always
> uses the same role as the admin service.

## Step 5: Add a route for the dashboard

Users reach your CAP service through an approuter, so the dashboard path needs a route.
Add it next to your existing `/odata/` route.

**Standalone approuter** (`app/router/xs-app.json` or similar):

```json
{
  "source": "^/token-optimizer/(.*)$",
  "target": "/token-optimizer/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa"
}
```

Then the dashboard is at `https://<approuter-url>/token-optimizer/dashboard/`.

**Managed approuter / SAP Build Work Zone** (no approuter module in your MTA): add the same
route to the `xs-app.json` of one of your Fiori apps, before the catch-all `^(.*)$` route.
The dashboard is then at the app's URL with `token-optimizer/dashboard/` in place of
`index.html`:

```
https://<your-launchpad-host>/<app-path>/token-optimizer/dashboard/
```

Use `srv-api` or whatever your `/odata/` route uses as the destination. Keep the slash at the
end of the URL.

## Step 6: Build and deploy

Nothing special is needed. `cds build` adds the usage log table and the admin service to your
MTA automatically:

```sh
mbt build
cf deploy mta_archives/<your-app>.mtar
```

Then, in the BTP cockpit, assign the role collection from step 4 to the users who should see
the dashboard (**Security → Role Collections**).

## Step 7: Open the dashboard

Open the URL from step 5. You'll see:

- **The top section** comes from the usage log. Pick a range (24 hours to 90 days) and
  split by model, use case or CDS service. Times are UTC.
- **"This app instance"** shows live statistics of the app instance that answered, since
  its last restart: latency percentiles, tokens saved per optimization step, prompt-caching
  advisories and exporter health.

Rows older than 30 days are deleted automatically (`metrics.db.retentionDays`).

---

## Optional: an "Open Dashboard" button in your Fiori app

If you have a Fiori elements (OData V4) list report on the token optimizer service, for
example on `UsageLog`, you can give it a button in the page header that opens the dashboard.

1. Create `webapp/ext/OpenDashboard.js` in the Fiori app:

   ```js
   sap.ui.define([], function () {
     "use strict";
     return {
       // Fiori elements calls this with `this` = the extension API
       openDashboard: function () {
         // e.g. /<app-path>/odata/v4/token-optimizer/ -> /<app-path>/token-optimizer/dashboard/
         var serviceUrl = this.getModel().getServiceUrl();
         var url = serviceUrl.replace(/odata\/v4\/token-optimizer\/?$/, "token-optimizer/dashboard/");
         window.open(url, "_blank", "noopener");
       }
     };
   });
   ```

2. Register it as a header action in `webapp/manifest.json`. It goes in the list report's
   page settings (`sap.ui5` → `routing` → `targets` → your list report → `options` →
   `settings`). Replace `my.app` with your app ID (`sap.app.id`):

   ```json
   "content": {
     "header": {
       "actions": {
         "openDashboard": {
           "press": "my.app.ext.OpenDashboard.openDashboard",
           "text": "{i18n>openDashboard}",
           "visible": true,
           "enabled": true
         }
       }
     }
   }
   ```

3. Add the button text to `webapp/i18n/i18n.properties`:

   ```properties
   #XBUT: Opens the token optimizer dashboard in a new tab
   openDashboard=Open Dashboard
   ```

4. Make sure the app's `xs-app.json` has the route from step 5, then build and deploy the app
   as usual.

The button appears once in the page header, also when the list report has several tabs. It
opens the dashboard in a new tab, with the same login and the same users as the app. Because
the address is built from the app's own OData address, it works wherever the app loads its
data. You can also open <http://localhost:4004/token-optimizer/dashboard/> directly while
developing.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| 404 on BTP | The route from step 5 is missing, or `"dashboard": true` was set only in code. |
| 404 locally | `"dashboard": true` is missing, or the app wasn't restarted. |
| 401 / 403 | The user lacks the role from step 4 (locally: the `roles` of the mocked user). |
| "No usage history" | Add `"db"` to `metrics.exporters`. |
| Error `no such table` locally | Start with `cds watch --in-memory`, or run `cds deploy`. |
| Charts empty | No AI calls in the selected range yet, or the calls ran in another tenant. Times are UTC. |
| Cost empty | Add `pricing` for your models. |

## Turning it off

Without a redeploy, set an environment variable and restart the app:

```sh
cf set-env <srv-app> cds_requires_tokenOptimizer_dashboard false
cf restart <srv-app>
```

More details: [README → Dashboard](https://github.com/viveka10/npm_token_optimizer/blob/main/cap-ai-token-optimizer/README.md#dashboard).

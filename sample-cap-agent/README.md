# sample-cap-agent

A small CAP app that calls SAP AI Core through [cap-ai-token-optimizer](../cap-ai-token-optimizer).

- `ask(question)`: one AI Core call (use case `ask`, output capped at 256 tokens).
- `runAgent(question)`: an MCP-style order-to-cash agent with 32 tool definitions and a
  multi-turn history with tool calls (use case `agent`, at most 10 tools, `get_sales_order` pinned).

Every call prints one JSON metrics line (`"type":"ai-core-call"`) to the console.

The read-only admin service is enabled at `/odata/v4/token-optimizer`; in development the
mocked user `ops` has the `TokenOptimizerAdmin` role (see `http/requests.http`).

## Run with the mock AI Core (development)

```sh
npm install
npm run watch        # or: npm start
```

The `[development]` profile starts the mock AI Core server from `cap-ai-token-optimizer`
(available through the local `file:` dependency only). Then use `http/requests.http`.
The mocked user `alice` has no password.

Mock scenarios can be triggered with a marker in the question, e.g. `[[mock:rate_limit]]`,
`[[mock:content_filter]]`, `[[mock:context_length]]`, `[[mock:server_error]]`.

## Run against SAP AI Core (hybrid)

1. Log in to Cloud Foundry and bind an SAP AI Core service instance with a service key:
   ```sh
   cds bind aicore --to <your-aicore-instance>:<service-key> --kind aicore
   ```
   This writes the binding reference to `.cdsrc-private.json` (git-ignored). No secrets are stored.
2. Start the app with the binding exposed as `VCAP_SERVICES`, which the SAP Cloud SDK for AI reads:
   ```sh
   npm run hybrid
   ```
3. Make sure an orchestration deployment exists in your resource group, and set
   `cds.requires.aicore.model` to a model available in your tenant (default `gpt-4.1`).

## Configuration

See `cds.requires.tokenOptimizer` in `package.json`, and the
[package README](../cap-ai-token-optimizer/README.md#configuration) for all options.

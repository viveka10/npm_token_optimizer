# Security Policy

## Supported versions

Security fixes are made for the latest minor release. Before 1.0.0, that is the latest
0.x release.

| Version | Supported |
|---|---|
| latest 0.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub:
[Security → Report a vulnerability](https://github.com/viveka10/npm_token_optimizer/security/advisories/new).
Include the package version, a description, and steps to reproduce if possible.

You can expect an acknowledgement within 7 days. Fixes are released as patch versions and
noted in the [CHANGELOG](CHANGELOG.md).

## How this package handles data

- **Prompt and completion text** are never logged, exported or stored by default. Events
  contain a SHA-256 hash and the length. Raw text only appears in events with
  `captureContent: true`, and is never written to the database.
- **User ids** are recorded as a salted hash (`metrics.userHashSalt`; set it from the
  environment, not in committed files).
- **Credentials** are never read or stored by this package. AI Core credentials are handled
  by the SAP Cloud SDK for AI; destination credentials by the SAP Cloud SDK. Don't put
  secrets in `metrics.http.headers` in committed files.
- **The response cache** is in memory per app instance. By default it is scoped per tenant,
  so cached answers are never shared across tenants (`cache.scope`).
- **The admin service** is read-only and requires a role (`admin.role`).
- **Published package contents** are checked before every publish (`npm run check:pack`):
  no tests, `.env`, `.cdsrc-private.json`, service keys, certificates or benchmark results.
  Releases are published from GitHub Actions with npm provenance.

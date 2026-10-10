# Contributing

Thanks for helping. Issues and pull requests are welcome at
https://github.com/viveka10/npm_token_optimizer.

## Development setup

The repository contains the package (`cap-ai-token-optimizer/`) and a sample CAP app
(`sample-cap-agent/`) that installs it with `file:../cap-ai-token-optimizer`.

```sh
cd cap-ai-token-optimizer && npm ci
cd ../sample-cap-agent && npm ci
cd ../cap-ai-token-optimizer
npm test            # Jest: unit + integration (mock AI Core, sample app). Needs Node >= 24.9
npm run test:smoke  # node:test smoke test, also on Node 22
npm run lint
npm run bench       # token-savings benchmark
```

Rules for changes:

- Keep the AI call safe: optimizer, metrics and exporter failures must never reach the caller.
- Never log or export prompt or completion text unless `captureContent` is set.
- Check the installed `@sap-ai-sdk/*` and `@sap/cds` APIs (`node_modules/.../*.d.ts`)
  instead of relying on memory.
- Add tests. Line coverage on `lib/` must stay ≥ 80% (it is about 99%).
- Update `README.md` and the `[Unreleased]` section of `CHANGELOG.md`.

## Versioning

The package follows [Semantic Versioning](https://semver.org/):

- **patch** (0.1.x): fixes, no behavior change for correct usage.
- **minor** (0.x.0): new features or options. Before 1.0.0, minor versions may also change
  defaults or behavior; the CHANGELOG then says so under "Changed".
- **major** (x.0.0): breaking changes to the API, configuration or event schema
  (`schemaVersion` in events changes when the event shape breaks).

Pre-releases use `-beta.N` (e.g. `0.2.0-beta.1`) and are published with the npm tag `next`.

## Release checklist

1. `main` is green in CI (all matrix combinations).
2. Update the version: `npm version <patch|minor|major> --no-git-tag-version` in
   `cap-ai-token-optimizer/`.
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and add a new,
   empty `## [Unreleased]` section above it.
4. If supported versions changed, update the compatibility table in `README.md` and
   `peerDependencies`.
5. Check the package contents: `npm run check:pack` and `npm pack --dry-run`.
6. Commit: `git commit -am "Release x.y.z"`, and open a pull request or push to `main`.
7. Tag the release commit and push the tag:
   ```sh
   git tag vx.y.z && git push origin vx.y.z
   ```
8. The `Release` workflow tests again, checks that the tag matches `package.json` and that
   the CHANGELOG has the version, publishes to npm with provenance, and creates the GitHub
   release from the CHANGELOG section.
9. Check https://www.npmjs.com/package/@viveka/cap-ai-token-optimizer (version, provenance
   badge) and install it in a CAP app: `npm add @viveka/cap-ai-token-optimizer@x.y.z`.

If a release is broken, publish a fixed patch version. Use `npm deprecate` for the broken
version rather than `npm unpublish`.

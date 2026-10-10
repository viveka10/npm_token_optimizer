#!/usr/bin/env node
'use strict'
/**
 * Fails if the npm package would contain files that must not be published:
 * tests, .env files, .cdsrc-private.json, service keys, certificates, benchmark results,
 * coverage, or text that looks like a secret. Also checks that required files are present.
 *
 *   npm run check:pack        (also runs automatically before `npm publish`)
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const FORBIDDEN = [
  [/^test\//, 'test files'],
  [/(^|\/)\.env(\..*)?$/, '.env file'],
  [/(^|\/)\.cdsrc-private\.json$/, '.cdsrc-private.json (cds bind)'],
  [/(^|\/)default-env\.json$/, 'default-env.json (credentials)'],
  [/(^|\/)[^/]*(service[-_.]?key|credentials?)[^/]*\.json$/i, 'service key / credentials file'],
  [/\.(pem|key|p12|pfx|crt)$/i, 'certificate or private key'],
  [/^bench\//, 'benchmark script or results'],
  [/^coverage\//, 'coverage report'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/\.(sqlite|db|tgz|log)$/i, 'database, archive or log file']
]

const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'index.js', 'index.d.ts', 'cds-plugin.js']

const SECRETS = [
  [/"clientsecret"\s*:\s*"[^"$<{]{8,}"/i, 'client secret'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/"(access_token|refresh_token)"\s*:\s*"eyJ[A-Za-z0-9_-]{20,}/, 'OAuth token']
]

/**
 * @param {string[]} files paths as published (relative to the package root)
 * @param {(file: string) => string|null} read returns text content, or null for binary/unreadable
 * @returns {string[]} problems
 */
function check (files, read) {
  const problems = []
  for (const f of files) {
    for (const [re, what] of FORBIDDEN) if (re.test(f)) problems.push(`${f}: ${what} must not be published`)
  }
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`${r}: required file is missing`)
  for (const f of files) {
    const text = read(f)
    if (text == null) continue
    for (const [re, what] of SECRETS) if (re.test(text)) problems.push(`${f}: contains what looks like a ${what}`)
  }
  return problems
}

function packedFiles (cwd) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out)[0].files.map(f => f.path)
}

function readText (root) {
  return (file) => {
    try {
      const buf = fs.readFileSync(path.join(root, file))
      return buf.includes(0) ? null : buf.toString('utf8')
    } catch { return null }
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..')
  const files = packedFiles(root)
  const problems = check(files, readText(root))
  if (problems.length) {
    console.error(`check:pack failed, the package would contain:\n${problems.map(p => `  - ${p}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`check:pack ok: ${files.length} files, none forbidden, no secrets found`)
}

module.exports = { check, FORBIDDEN, REQUIRED, SECRETS }

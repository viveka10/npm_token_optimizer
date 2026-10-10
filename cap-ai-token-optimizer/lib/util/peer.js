'use strict'
const { getCds } = require('./cds')

/**
 * Load an optional peer dependency (e.g. @sap-ai-sdk/orchestration).
 * Resolves from the application root first so the app's copy is used even when this package
 * is installed via a symlink (`file:` / `npm link`), then falls back to normal resolution.
 * @param {string} name
 * @param {string} [purpose] shown in the error message
 */
function loadPeer (name, purpose) {
  const roots = [getCds()?.root, process.cwd()].filter(Boolean)
  for (const root of roots) {
    try {
      return require(require.resolve(name, { paths: [root] }))
    } catch (e) {
      if (e?.code !== 'MODULE_NOT_FOUND') throw e
    }
  }
  try {
    return require(name)
  } catch (e) {
    if (e?.code !== 'MODULE_NOT_FOUND') throw e
    const err = new Error(`${purpose ? `${purpose} requires` : 'Missing'} peer dependency "${name}". Install it with: npm i ${name}`)
    err.code = 'PEER_DEPENDENCY_MISSING'
    throw err
  }
}

/**
 * Version of an installed peer, read from its package.json next to the resolved entry
 * (works when package.json is not in the package's "exports"). Null if unknown.
 * @param {string} name
 */
function peerVersion (name) {
  const fs = require('node:fs')
  const path = require('node:path')
  const roots = [getCds()?.root, process.cwd()].filter(Boolean)
  let entry = null
  for (const root of roots) {
    try { entry = require.resolve(name, { paths: [root] }); break } catch { /* next */ }
  }
  try { entry ??= require.resolve(name) } catch { return null }
  for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json')
    if (!fs.existsSync(file)) continue
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (pkg.name === name) return pkg.version ?? null
    } catch { return null }
  }
  return null
}

module.exports = { loadPeer, peerVersion }

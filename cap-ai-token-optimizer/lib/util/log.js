'use strict'
/**
 * Logger: uses cds.log('token-optimizer') when CAP is loaded, else console.
 * Resolved lazily on first use. Never throws.
 */
const { getCds } = require('./cds')

let _log

function getLogger () {
  if (_log) return _log
  const cds = getCds()
  if (cds?.log) _log = cds.log('token-optimizer')
  // the console fallback is not cached, so cds.log is picked up once CAP has loaded
  return _log ?? fallback
}

const fallback = {
  debug: () => {},
  info: (...a) => console.info('[token-optimizer]', ...a),
  warn: (...a) => console.warn('[token-optimizer]', ...a),
  error: (...a) => console.error('[token-optimizer]', ...a)
}

/** @param {'debug'|'info'|'warn'|'error'} level */
const safe = (level) => (...args) => {
  try { getLogger()[level](...args) } catch { /* logging must never break the caller */ }
}

module.exports = {
  debug: safe('debug'),
  info: safe('info'),
  warn: safe('warn'),
  error: safe('error'),
  /** @internal test hook */
  _set (logger) { _log = logger }
}

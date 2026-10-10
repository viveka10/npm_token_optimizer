'use strict'
/**
 * Exact-match response cache.
 *
 * CacheStore interface (sync or async; plug in Redis etc. via `cache.store` in code):
 *   get(key) → value | undefined
 *   set(key, value, ttlMs)
 *   delete(key), clear()
 * Values are plain JSON ({ sdk, data, headers }), so any store that can hold JSON works.
 */
const { sha256, stableStringify } = require('../util/hash')

class MemoryCacheStore {
  /** @param {{ maxEntries?: number, now?: () => number }} [opts] */
  constructor ({ maxEntries = 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries
    this._now = now
    this._map = new Map()
  }

  get (key) {
    const entry = this._map.get(key)
    if (!entry) return undefined
    if (entry.expires <= this._now()) { this._map.delete(key); return undefined }
    // refresh LRU position
    this._map.delete(key)
    this._map.set(key, entry)
    return entry.value
  }

  set (key, value, ttlMs) {
    if (!(this.maxEntries > 0) || !(ttlMs > 0)) return
    this._map.delete(key)
    this._map.set(key, { value, expires: this._now() + ttlMs })
    while (this._map.size > this.maxEntries) this._map.delete(this._map.keys().next().value)
  }

  delete (key) { this._map.delete(key) }
  clear () { this._map.clear() }
  get size () { return this._map.size }
}

/**
 * Cache key: hash of everything that determines the response.
 * @param {object} material what the adapter will send (config + request, or deployment + request)
 * @param {{ scope?: 'tenant'|'user'|'global', tenant?: string|null, userId?: string|null }} [opts]
 */
function cacheKey (material, { scope = 'tenant', tenant = null, userId = null } = {}) {
  const scopeKey = scope === 'global' ? null : scope === 'user' ? { tenant, userId } : { tenant }
  return sha256(stableStringify({ v: 1, scope: scopeKey, material }))
}

/**
 * Whether a call may use the cache: enabled, non-streaming, and temperature at most
 * `maxTemperature`. An unset temperature means the provider default (usually 1), so it is
 * not cached unless `maxTemperature` is null.
 * @param {object} cacheCfg
 * @param {object} params effective model params
 */
function isCacheable (cacheCfg, params) {
  if (!cacheCfg?.enabled) return false
  if (cacheCfg.maxTemperature == null) return true
  const t = params?.temperature
  return typeof t === 'number' && t <= cacheCfg.maxTemperature
}

module.exports = { MemoryCacheStore, cacheKey, isCacheable }

'use strict'
/**
 * HTTP exporter: POSTs batches of events as JSON `{ "events": [...] }` to a URL or a BTP destination.
 *
 * - Events are queued; the queue is capped (`maxQueueSize`). When full, the oldest events are
 *   dropped and counted.
 * - Flushes on the collector's interval, when a batch is full, and on shutdown.
 * - Retries 429, 5xx and network errors with exponential backoff (honours Retry-After);
 *   other 4xx responses drop the batch. A batch that still fails goes back to the front of the
 *   queue, so a short outage loses nothing (up to the queue cap).
 * - Destinations are resolved with @sap-cloud-sdk/connectivity (present with @sap-ai-sdk) and
 *   cached for `destinationCacheMs`. Only Internet destinations are supported.
 *
 * Never throws into the caller.
 */
const log = require('../util/log')
const { loadPeer } = require('../util/peer')
const { parseRetryAfter } = require('../metrics/classifier')

const DEFAULTS = {
  url: '',
  destination: '',
  headers: {},
  batchSize: 100,
  maxQueueSize: 10000,
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  timeoutMs: 10000,
  destinationCacheMs: 5 * 60 * 1000
}

/**
 * @param {object} cfg metrics.http config
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, connectivity?: object, now?: () => number }} [deps]
 * @returns {import('../../index').Exporter}
 */
function createHttpExporter (cfg = {}, deps = {}) {
  const opts = { ...DEFAULTS, ...cfg, headers: { ...cfg.headers } }
  if (!opts.url && !opts.destination) throw new Error('metrics.http needs a "url" or a "destination"')
  const doFetch = deps.fetch ?? globalThis.fetch
  const sleep = deps.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? Date.now

  const queue = []
  const counters = { sent: 0, dropped: 0, failedAttempts: 0, rejectedBatches: 0 }
  let flushing = null
  let resolved = null // { url, headers, expires }
  let closed = false

  async function target () {
    if (opts.url) return { url: opts.url, headers: {} }
    if (resolved && resolved.expires > now()) return resolved
    const connectivity = deps.connectivity ?? loadPeer('@sap-cloud-sdk/connectivity', 'the http exporter with a destination')
    const destination = await connectivity.getDestination({ destinationName: opts.destination, useCache: true })
    if (!destination?.url) throw new Error(`destination "${opts.destination}" not found or has no URL`)
    const headers = await connectivity.buildHeadersForDestination(destination)
    resolved = { url: destination.url, headers, expires: now() + opts.destinationCacheMs }
    return resolved
  }

  /** POST one batch. Returns true when sent, false when it should be kept for later. */
  async function send (batch) {
    for (let attempt = 0; ; attempt++) {
      let retryAfter = null
      try {
        const t = await target()
        const res = await doFetch(t.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...t.headers, ...opts.headers },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(opts.timeoutMs)
        })
        if (res.ok) {
          counters.sent += batch.length
          return true
        }
        if (res.status === 401 || res.status === 403) resolved = null // token may have expired
        if (res.status !== 429 && res.status < 500 && res.status !== 401) {
          counters.rejectedBatches++
          log.warn(`http exporter: batch of ${batch.length} rejected with HTTP ${res.status}, dropped`)
          counters.dropped += batch.length
          return true
        }
        retryAfter = parseRetryAfter(res.headers?.get?.('retry-after'), now())
        counters.failedAttempts++
        log.debug(`http exporter: HTTP ${res.status} (attempt ${attempt + 1})`)
      } catch (e) {
        counters.failedAttempts++
        log.debug(`http exporter: ${e?.message} (attempt ${attempt + 1})`)
        if (attempt >= opts.maxRetries) log.warn('http exporter: could not send events:', e?.message)
      }
      if (attempt >= opts.maxRetries) return false
      const backoff = opts.baseDelayMs * 2 ** attempt
      await sleep(Math.min(opts.maxDelayMs, retryAfter ?? Math.round(backoff / 2 + Math.random() * backoff / 2)))
    }
  }

  function enqueue (events, front = false) {
    if (front) queue.unshift(...events)
    else queue.push(...events)
    const over = queue.length - opts.maxQueueSize
    if (over > 0) {
      // drop the oldest
      queue.splice(0, over)
      counters.dropped += over
    }
  }

  async function drain () {
    while (queue.length) {
      const batch = queue.splice(0, opts.batchSize)
      const ok = await send(batch)
      if (!ok) {
        enqueue(batch, true)
        return
      }
    }
  }

  function flush () {
    flushing ??= drain().catch(e => log.warn('http exporter flush failed:', e?.message)).finally(() => { flushing = null })
    return flushing
  }

  return {
    name: 'http',
    export (event) {
      if (closed) return
      enqueue([event])
      if (queue.length >= opts.batchSize) flush()
    },
    flush,
    async shutdown () {
      await flushing
      await flush()
      closed = true
    },
    stats: () => ({ queued: queue.length, ...counters })
  }
}

module.exports = { createHttpExporter, DEFAULTS }

'use strict'
const { MemoryCacheStore, cacheKey, isCacheable } = require('../../lib/cache')

describe('MemoryCacheStore', () => {
  test('get/set with TTL', () => {
    let now = 1000
    const s = new MemoryCacheStore({ now: () => now })
    s.set('a', { v: 1 }, 100)
    expect(s.get('a')).toEqual({ v: 1 })
    now = 1100
    expect(s.get('a')).toBeUndefined()
    expect(s.size).toBe(0)
  })

  test('evicts the least recently used entry', () => {
    const s = new MemoryCacheStore({ maxEntries: 2 })
    s.set('a', 1, 1000)
    s.set('b', 2, 1000)
    s.get('a')
    s.set('c', 3, 1000)
    expect(s.get('b')).toBeUndefined()
    expect(s.get('a')).toBe(1)
    expect(s.get('c')).toBe(3)
  })

  test('ignores zero ttl / capacity; delete and clear', () => {
    const s = new MemoryCacheStore({ maxEntries: 0 })
    s.set('a', 1, 1000)
    expect(s.size).toBe(0)
    const t = new MemoryCacheStore()
    t.set('a', 1, 0)
    expect(t.size).toBe(0)
    t.set('a', 1, 10)
    t.set('b', 1, 10)
    t.delete('a')
    expect(t.size).toBe(1)
    t.clear()
    expect(t.size).toBe(0)
  })
})

describe('cacheKey / isCacheable', () => {
  test('keys depend on material and scope', () => {
    const m = { request: { messages: [{ role: 'user', content: 'x' }] } }
    expect(cacheKey(m, { tenant: 't1' })).toBe(cacheKey({ request: { messages: [{ content: 'x', role: 'user' }] } }, { tenant: 't1' }))
    expect(cacheKey(m, { tenant: 't1' })).not.toBe(cacheKey(m, { tenant: 't2' }))
    expect(cacheKey(m, { scope: 'global', tenant: 't1' })).toBe(cacheKey(m, { scope: 'global', tenant: 't2' }))
    expect(cacheKey(m, { scope: 'user', tenant: 't1', userId: 'a' })).not.toBe(cacheKey(m, { scope: 'user', tenant: 't1', userId: 'b' }))
    expect(cacheKey(m)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('only low temperatures are cacheable by default', () => {
    const cfg = { enabled: true, maxTemperature: 0.2 }
    expect(isCacheable(cfg, { temperature: 0 })).toBe(true)
    expect(isCacheable(cfg, { temperature: 0.2 })).toBe(true)
    expect(isCacheable(cfg, { temperature: 0.7 })).toBe(false)
    expect(isCacheable(cfg, {})).toBe(false)
    expect(isCacheable({ enabled: true, maxTemperature: null }, {})).toBe(true)
    expect(isCacheable({ enabled: false }, { temperature: 0 })).toBe(false)
    expect(isCacheable(undefined, {})).toBe(false)
  })
})

'use strict'
const { sha256, stableStringify, hashUser, fingerprint } = require('../../lib/util/hash')

describe('hash utils', () => {
  test('sha256 hex', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('stableStringify sorts keys and drops undefined', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify('x')).toBe('"x"')
  })

  test('hashUser is salted, short and null for empty ids', () => {
    expect(hashUser(null)).toBeNull()
    expect(hashUser('')).toBeNull()
    expect(hashUser('alice')).toHaveLength(16)
    expect(hashUser('alice', 's1')).not.toBe(hashUser('alice', 's2'))
    expect(hashUser('alice')).not.toContain('alice')
  })

  test('fingerprint is independent of key order', () => {
    const a = fingerprint([{ role: 'user', content: 'hi' }])
    const b = fingerprint([{ content: 'hi', role: 'user' }])
    expect(a).toEqual(b)
    expect(a.promptLength).toBeGreaterThan(0)
    expect(fingerprint(undefined).promptLength).toBe(2)
  })
})

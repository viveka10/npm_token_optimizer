'use strict'
const { createHash } = require('node:crypto')

/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/**
 * Deterministic JSON serialisation (sorted object keys) so equal values hash equally.
 * @param {any} value
 * @returns {string}
 */
function stableStringify (value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * Pseudonymise a user id. Returns null for empty input.
 * @param {string|undefined|null} userId
 * @param {string} [salt]
 */
function hashUser (userId, salt = '') {
  if (!userId) return null
  return sha256(`${salt}:${userId}`).slice(0, 16)
}

/**
 * Hash + length fingerprint of a prompt — what gets logged instead of the raw text.
 * @param {Array<object>} messages
 * @returns {{ promptHash: string, promptLength: number }}
 */
function fingerprint (messages) {
  const text = stableStringify(messages ?? [])
  return { promptHash: sha256(text), promptLength: text.length }
}

module.exports = { sha256, stableStringify, hashUser, fingerprint }

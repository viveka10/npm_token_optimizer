'use strict'
/**
 * dedupe: remove exact duplicate instructions within one request.
 *  - messages: a system message identical to an earlier one is dropped; a user message
 *    identical to the user message right before it is dropped.
 *  - paragraphs: a paragraph (blank-line separated, at least `minParagraphLength` chars)
 *    that repeats a system paragraph is removed from later system and user messages;
 *    in user messages, an older copy of a paragraph that is repeated in a later user
 *    message is removed (the latest copy stays where it is).
 * Messages with code fences, tool and assistant messages are never edited, and a message
 * is never emptied.
 */
const { isLocked, isSystem } = require('../messages')
const { stableStringify } = require('../../util/hash')

const DEFAULTS = { messages: true, paragraphs: true, minParagraphLength: 30 }
const PARA_SPLIT = /\n[ \t]*\n/

/**
 * @param {import('../index').StepInput} input
 * @param {object} options
 */
function dedupe ({ messages }, options) {
  const opts = { ...DEFAULTS, ...options }
  const notes = []
  let out = messages
  if (opts.messages) {
    const before = out.length
    out = dedupeMessages(out)
    if (out.length < before) notes.push(`${before - out.length} duplicate message(s) removed`)
  }
  if (opts.paragraphs) {
    const { messages: next, removed } = dedupeParagraphs(out, opts.minParagraphLength)
    out = next
    if (removed) notes.push(`${removed} duplicate paragraph(s) removed`)
  }
  return { messages: out, notes }
}

function dedupeMessages (messages) {
  const seenSystem = new Set()
  const out = []
  for (const m of messages) {
    const key = stableStringify({ role: m?.role, content: m?.content })
    if (isSystem(m)) {
      if (seenSystem.has(key) && !isLocked(m)) continue
      seenSystem.add(key)
    } else if (m?.role === 'user' && !isLocked(m)) {
      const prev = out.at(-1)
      if (prev?.role === 'user' && stableStringify({ role: prev.role, content: prev.content }) === key) continue
    }
    out.push(m)
  }
  return out
}

const editable = (m) => typeof m?.content === 'string' && !isLocked(m) && !/^[ \t]*(```|~~~)/m.test(m.content)
const paragraphsOf = (text) => text.split(PARA_SPLIT)
const norm = (p) => p.trim()

function dedupeParagraphs (messages, minLength) {
  const long = (p) => norm(p).length >= minLength
  // paragraphs that appear in a system message, and in which user message a paragraph last appears
  const systemParas = new Set()
  const lastUserIndex = new Map()
  messages.forEach((m, i) => {
    if (typeof m?.content !== 'string') return
    for (const p of paragraphsOf(m.content)) {
      if (!long(p)) continue
      if (isSystem(m)) systemParas.add(norm(p))
      else if (m.role === 'user') lastUserIndex.set(norm(p), i)
    }
  })

  let removed = 0
  const seenSystem = new Set()
  const out = messages.map((m, i) => {
    if (!editable(m) || !(isSystem(m) || m.role === 'user')) {
      if (isSystem(m) && typeof m?.content === 'string') for (const p of paragraphsOf(m.content)) if (long(p)) seenSystem.add(norm(p))
      return m
    }
    const seenHere = new Set()
    const kept = []
    let dropped = 0
    for (const p of paragraphsOf(m.content)) {
      const key = norm(p)
      const drop = long(p) && (
        seenHere.has(key) ||
        (isSystem(m) ? seenSystem.has(key) : (systemParas.has(key) || lastUserIndex.get(key) > i))
      )
      if (long(p)) seenHere.add(key)
      if (drop) dropped++
      else kept.push(p)
    }
    if (isSystem(m)) for (const p of kept) if (long(p)) seenSystem.add(norm(p))
    if (!dropped || !kept.some(p => p.trim())) return m
    removed += dropped
    return { ...m, content: kept.join('\n\n') }
  })
  return { messages: out, removed }
}

module.exports = { dedupe, DEFAULTS }

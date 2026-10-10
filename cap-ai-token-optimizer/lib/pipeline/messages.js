'use strict'
/**
 * Message helpers shared by the pipeline steps.
 *
 * Messages carry their origin under a symbol key (not serialised, so it never reaches
 * AI Core). Orchestration template messages are "locked": they are part of the client's
 * fixed config, so steps must neither change nor drop them.
 */
const ORIGIN = Symbol('cap-ai-token-optimizer.origin')

const SYSTEM_ROLES = new Set(['system', 'developer'])

/** @param {object} m */
const isLocked = (m) => m?.[ORIGIN] === 'template'

/** @param {object} m */
const isSystem = (m) => SYSTEM_ROLES.has(m?.role)

/**
 * Shallow copy of a message tagged with its origin.
 * @param {object} m
 * @param {string} origin
 */
const tag = (m, origin) => ({ ...m, [ORIGIN]: origin })

/** Copy without the origin tag. */
function untag (m) {
  if (!m || typeof m !== 'object') return m
  const { [ORIGIN]: _origin, ...rest } = m
  return rest
}

/**
 * Apply `fn` to every text of a message (string content or text parts).
 * Returns the same object when nothing changed, so unchanged messages keep their identity.
 * @param {object} m
 * @param {(text: string) => string} fn
 */
function mapText (m, fn) {
  if (!m || isLocked(m)) return m
  if (typeof m.content === 'string') {
    const next = fn(m.content)
    return next === m.content ? m : { ...m, content: next }
  }
  if (Array.isArray(m.content)) {
    let changed = false
    const content = m.content.map(p => {
      if (p && p.type === 'text' && typeof p.text === 'string') {
        const text = fn(p.text)
        if (text !== p.text) { changed = true; return { ...p, text } }
      }
      return p
    })
    return changed ? { ...m, content } : m
  }
  return m
}

/** Name of a tool definition (OpenAI-style function tools). */
const toolName = (t) => t?.function?.name ?? t?.name ?? null

module.exports = { ORIGIN, isLocked, isSystem, tag, untag, mapText, toolName }

'use strict'
const { countText, estimateMessages, estimateTools, encodingFor, baseModelName } = require('../../lib/tokens/estimator')

describe('token estimator', () => {
  test('picks the encoding per model family, including AI Core prefixes', () => {
    expect(encodingFor('gpt-4o')).toBe('o200k_base')
    expect(encodingFor('gpt-4.1-mini')).toBe('o200k_base')
    expect(encodingFor('azure-openai--gpt-4.1')).toBe('o200k_base')
    expect(encodingFor('gpt-4')).toBe('cl100k_base')
    expect(encodingFor('gpt-35-turbo')).toBeNull()
    expect(encodingFor('anthropic--claude-4-sonnet')).toBeNull()
    expect(encodingFor(undefined)).toBeNull()
    expect(baseModelName('openai/GPT-4o')).toBe('gpt-4o')
  })

  test('counts with tiktoken for OpenAI models', () => {
    expect(countText('hello world', 'gpt-4o')).toEqual({ tokens: 2, method: 'tiktoken' })
    expect(countText('hello world', 'gpt-4')).toEqual({ tokens: 2, method: 'tiktoken' })
  })

  test('falls back to chars / 4 for unknown models', () => {
    expect(countText('a'.repeat(10), 'mistralai--mistral-large')).toEqual({ tokens: 3, method: 'heuristic' })
    expect(countText('', 'x').tokens).toBe(0)
    expect(countText(null).tokens).toBe(0)
    expect(countText(12345).tokens).toBe(2)
  })

  test('estimates chat messages with per-message overhead', () => {
    const msgs = [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Hi' }]
    const { tokens, method } = estimateMessages(msgs, { model: 'gpt-4o' })
    expect(method).toBe('tiktoken')
    // close to what OpenAI bills for this prompt (~18)
    expect(tokens).toBeGreaterThanOrEqual(14)
    expect(tokens).toBeLessThanOrEqual(22)
    expect(estimateMessages([], { model: 'gpt-4o' }).tokens).toBe(0)
  })

  test('handles content parts, tool calls, names and nulls', () => {
    const msgs = [
      null,
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'x' } }, 'plain'] },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'f', content: { ok: true } }
    ]
    const r = estimateMessages(msgs, { model: 'gpt-4o' })
    expect(r.tokens).toBeGreaterThan(85)
  })

  test('adds tool definitions to the estimate', () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }]
    const msgs = [{ role: 'user', content: 'Weather?' }]
    const without = estimateMessages(msgs, { model: 'gpt-4o' }).tokens
    const withTools = estimateMessages(msgs, { model: 'gpt-4o', tools }).tokens
    expect(withTools - without).toBe(estimateTools(tools, 'gpt-4o').tokens)
    expect(estimateTools([], 'gpt-4o').tokens).toBe(0)
    expect(estimateTools(undefined).method).toBe('heuristic')
  })
})

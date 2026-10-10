'use strict'
const { normalize, normalizeText } = require('../../../lib/pipeline/steps/normalize')
const { tag, ORIGIN } = require('../../../lib/pipeline/messages')

describe('normalize step', () => {
  test('trims, collapses spaces and blank lines', () => {
    expect(normalizeText('  Hello    world  \n\n\n\nNext   line\t\n')).toBe('Hello world\n\nNext line')
  })

  test('keeps leading indentation, tabs, inline code and indented code lines', () => {
    const text = '- item\n  - nested   item\nUse `a    b` here\n    code   line\na\t\tb'
    expect(normalizeText(text)).toBe('- item\n  - nested item\nUse `a    b` here\n    code   line\na\t\tb')
  })

  test('leaves fenced code untouched', () => {
    const text = 'Fix this:\n```python\ndef f(x):\n    return  x   * 2\n\n\n\n```\nThanks    a lot'
    expect(normalizeText(text)).toBe('Fix this:\n```python\ndef f(x):\n    return  x   * 2\n\n\n\n```\nThanks a lot')
  })

  test('at most one blank line next to a fence', () => {
    expect(normalizeText('Look:\n\n\n\n```\ncode\n```\n\n\n\nDone')).toBe('Look:\n\n```\ncode\n```\n\nDone')
    expect(normalizeText('Look:\n```\ncode\n```\nDone')).toBe('Look:\n```\ncode\n```\nDone')
  })

  test('minifies JSON blocks and ```json fences, keeping string contents', () => {
    const text = 'Invoice:\n{\n  "id": "INV  1",\n  "lines": [\n    { "qty": 2 }\n  ]\n}\n```json\n{\n  "a": 1\n}\n```'
    expect(normalizeText(text)).toBe('Invoice:\n{"id":"INV  1","lines":[{"qty":2}]}\n```json\n{"a":1}\n```')
  })

  test('options switch parts off', () => {
    const text = '{\n "a": 1\n}\n```json\n{\n "b": 2\n}\n```\nx   y'
    expect(normalizeText(text, { minifyJson: false, minifyJsonFences: false, collapseSpaces: false })).toBe(text)
  })

  test('an invalid ```json fence is left as is', () => {
    const text = '```json\n{ oops }\n```'
    expect(normalizeText(text)).toBe(text)
    expect(normalizeText('```json\n```')).toBe('```json\n```')
  })

  test('normalizes text parts and tool call arguments, keeps identity of unchanged messages', () => {
    const unchanged = { role: 'user', content: 'ok' }
    const messages = [
      unchanged,
      { role: 'user', content: [{ type: 'text', text: 'a   b' }, { type: 'image_url', image_url: { url: 'u' } }, { type: 'text', text: 'same' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{\n  "x": 1\n}' } }, { id: '2', function: { arguments: 'not json' } }, { id: '3' }] },
      { role: 'tool', tool_call_id: '1', content: '{\n  "result": [1, 2]\n}' },
      tag({ role: 'system', content: 'locked    template' }, 'template'),
      tag({ role: 'assistant', content: null, tool_calls: [{ function: { arguments: '{ "a": 1 }' } }] }, 'template')
    ]
    const { messages: out, notes } = normalize({ messages }, {})
    expect(out[0]).toBe(unchanged)
    expect(out[1].content[0].text).toBe('a b')
    expect(out[1].content[1]).toBe(messages[1].content[1])
    expect(out[2].tool_calls[0].function.arguments).toBe('{"x":1}')
    expect(out[2].tool_calls[1]).toBe(messages[2].tool_calls[1])
    expect(out[3].content).toBe('{"result":[1,2]}')
    expect(out[4]).toBe(messages[4])
    expect(out[5]).toBe(messages[5])
    expect(out[4][ORIGIN]).toBe('template')
    expect(notes).toEqual(['3 message(s) normalized'])
  })

  test('no notes when nothing changed', () => {
    expect(normalize({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null }] }, {}).notes).toEqual([])
  })
})

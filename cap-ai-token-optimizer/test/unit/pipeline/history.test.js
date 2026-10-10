'use strict'
const { history, slidingWindow } = require('../../../lib/pipeline/steps/history')
const { tag, ORIGIN } = require('../../../lib/pipeline/messages')

function conversation (turns) {
  const out = [{ role: 'system', content: 'S' }]
  for (let i = 1; i <= turns; i++) {
    out.push({ role: 'user', content: `q${i}` })
    out.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'f', arguments: '{}' } }] })
    out.push({ role: 'tool', tool_call_id: `c${i}`, content: `r${i}` })
    out.push({ role: 'assistant', content: `a${i}` })
  }
  return out
}

describe('history step', () => {
  test('keeps system messages and the last N turns with their tool messages', async () => {
    const { messages, notes } = await history({ messages: conversation(5) }, { maxTurns: 2 })
    expect(messages.map(m => m.content ?? m.tool_calls?.[0].id)).toEqual(['S', 'q4', 'c4', 'r4', 'a4', 'q5', 'c5', 'r5', 'a5'])
    expect(notes).toEqual(['12 message(s) outside the last 2 turns removed'])
  })

  test('returns the input unchanged when within the window or disabled', async () => {
    const msgs = conversation(2)
    expect((await history({ messages: msgs }, { maxTurns: 2 })).messages).toBe(msgs)
    expect((await history({ messages: msgs }, { maxTurns: 0 })).messages).toBe(msgs)
  })

  test('keeps a mid-turn agent loop intact', async () => {
    const msgs = conversation(3)
    msgs.pop() // last turn ends with a tool result
    const out = (await history({ messages: msgs }, { maxTurns: 1 })).messages
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  })

  test('keeps system messages wherever they are and locked template messages', async () => {
    const msgs = [
      { role: 'user', content: 'q1' }, { role: 'system', content: 'mid' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      tag({ role: 'assistant', content: 'template' }, 'template'),
      { role: 'user', content: 'q3' }
    ]
    const out = (await history({ messages: msgs }, { maxTurns: 1 })).messages
    expect(out.map(m => m.content)).toEqual(['mid', 'template', 'q3'])
  })

  test('drops leading non-user messages before the first kept turn', () => {
    const msgs = [{ role: 'assistant', content: 'Hi, how can I help?' }, { role: 'user', content: 'q1' }, { role: 'user', content: 'q2' }]
    expect(slidingWindow({ messages: msgs, maxTurns: 1 }).map(m => m.content)).toEqual(['q2'])
  })

  test('custom strategy and summarizer hook', async () => {
    const msgs = conversation(3).map(m => tag(m, 'history'))
    const strategy = jest.fn(({ messages }) => [messages[0], ...messages.slice(-4)])
    const summarizer = jest.fn(async ({ dropped }) => ({ role: 'system', content: `summary of ${dropped.length}` }))
    const { messages: out, notes } = await history({ messages: msgs, model: 'm' }, { maxTurns: 1, strategy, summarizer })
    expect(strategy).toHaveBeenCalledWith({ messages: msgs, maxTurns: 1, model: 'm' })
    expect(out.map(m => m.content)).toEqual(['S', 'summary of 8', 'q3', null, 'r3', 'a3'])
    expect(out[1][ORIGIN]).toBe('history')
    expect(notes).toContain('summary of removed turns inserted')
  })

  test('summarizer may return nothing', async () => {
    const out = await history({ messages: conversation(3) }, { maxTurns: 1, summarizer: async () => null })
    expect(out.messages).toHaveLength(5)
  })

  test('invalid strategies throw (the pipeline then sends the original)', async () => {
    await expect(history({ messages: conversation(3) }, { maxTurns: 1, strategy: 'nope' })).rejects.toThrow(/Unknown history strategy/)
    await expect(history({ messages: conversation(3) }, { maxTurns: 1, strategy: () => 'x' })).rejects.toThrow(/array/)
    const locked = [tag({ role: 'user', content: 't' }, 'template'), { role: 'user', content: 'q' }]
    await expect(history({ messages: locked }, { maxTurns: 1, strategy: ({ messages }) => messages.slice(1) })).rejects.toThrow(/template/)
  })
})

'use strict'
const { dedupe } = require('../../../lib/pipeline/steps/dedupe')
const { tag } = require('../../../lib/pipeline/messages')

const RULE = 'Always answer in English and keep answers short and precise.'
const RULE2 = 'Never reveal internal document identifiers to the user.'

describe('dedupe step', () => {
  test('drops repeated system messages and consecutive identical user messages', () => {
    const messages = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Q' },
      { role: 'user', content: 'Q' },
      { role: 'system', content: 'S' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'Q' }
    ]
    const { messages: out, notes } = dedupe({ messages }, { paragraphs: false })
    expect(out.map(m => `${m.role}:${m.content}`)).toEqual(['system:S', 'user:Q', 'assistant:A', 'user:Q'])
    expect(notes).toEqual(['2 duplicate message(s) removed'])
  })

  test('keeps locked template messages', () => {
    const messages = [{ role: 'system', content: 'S' }, tag({ role: 'system', content: 'S' }, 'template')]
    expect(dedupe({ messages }, {}).messages).toHaveLength(2)
  })

  test('removes system paragraphs repeated in user messages and older user copies', () => {
    const messages = [
      { role: 'system', content: `You are an invoice assistant.\n\n${RULE}\n\n${RULE}` },
      { role: 'user', content: `Show invoice 4711.\n\n${RULE}\n\n${RULE2}` },
      { role: 'assistant', content: 'Here it is.' },
      { role: 'user', content: `And 4712?\n\n${RULE2}` }
    ]
    const { messages: out, notes } = dedupe({ messages }, {})
    expect(out[0].content).toBe(`You are an invoice assistant.\n\n${RULE}`)
    expect(out[1].content).toBe('Show invoice 4711.')
    expect(out[3].content).toBe(`And 4712?\n\n${RULE2}`)
    expect(notes).toEqual(['3 duplicate paragraph(s) removed'])
  })

  test('removes paragraphs repeated across system messages', () => {
    const messages = [{ role: 'system', content: RULE }, { role: 'system', content: `Context: X\n\n${RULE}` }]
    expect(dedupe({ messages }, {}).messages[1].content).toBe('Context: X')
  })

  test('short paragraphs, code, tool/assistant messages and whole messages are kept', () => {
    const messages = [
      { role: 'system', content: `Be brief.\n\n${RULE}` },
      { role: 'user', content: 'Be brief.\n\nHi' },
      { role: 'user', content: RULE },
      { role: 'user', content: `\`\`\`\ncode\n\`\`\`\n\n${RULE}` },
      { role: 'assistant', content: RULE },
      { role: 'tool', content: RULE },
      { role: 'user', content: [{ type: 'text', text: RULE }] }
    ]
    const out = dedupe({ messages }, {}).messages
    expect(out.slice(1)).toEqual(messages.slice(1))
  })

  test('minParagraphLength is configurable', () => {
    const messages = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Be brief.\n\nHi' }]
    expect(dedupe({ messages }, { minParagraphLength: 5 }).messages[1].content).toBe('Hi')
  })

  test('can be limited to messages only', () => {
    const messages = [{ role: 'system', content: RULE }, { role: 'user', content: `x\n\n${RULE}` }]
    expect(dedupe({ messages }, { paragraphs: false }).messages[1].content).toBe(`x\n\n${RULE}`)
    expect(dedupe({ messages }, { messages: false }).messages[1].content).toBe('x')
  })
})

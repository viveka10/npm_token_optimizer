'use strict'
const { runPipeline, stepOptions } = require('../../../lib/pipeline')
const { DEFAULTS } = require('../../../lib/config')

const RULE = 'Always answer in English and keep answers short and precise.'
const manyTools = Array.from({ length: 20 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: `Tool number ${i} for invoices` } }))

function longConversation () {
  const msgs = [{ role: 'system', content: `You are helpful.\n\n${RULE}` }]
  for (let i = 0; i < 15; i++) {
    msgs.push({ role: 'user', content: `Question ${i}:   please   check\n\n\n\n${RULE}` })
    msgs.push({ role: 'assistant', content: `Answer ${i}` })
  }
  return msgs
}

describe('runPipeline', () => {
  test('runs all steps and reports savings per step', async () => {
    const r = await runPipeline({ messages: longConversation(), tools: manyTools, params: {}, model: 'gpt-4.1', steps: DEFAULTS.steps })
    expect(Object.keys(r.byStep)).toEqual(['normalize', 'dedupe', 'history', 'tools', 'outputCap'])
    expect(r.byStep.normalize).toBeGreaterThan(0)
    expect(r.byStep.dedupe).toBeGreaterThan(0)
    expect(r.byStep.history).toBeGreaterThan(0)
    expect(r.byStep.tools).toBeGreaterThan(0)
    expect(r.byStep.outputCap).toBe(0)
    expect(r.tools).toHaveLength(15)
    expect(r.params).toEqual({ max_tokens: 1024 })
    expect(r.savedTokensEstimate).toBe(Object.values(r.byStep).reduce((a, b) => a + b, 0))
    expect(r.estimateAfter).toBe(r.estimateBefore - r.savedTokensEstimate)
    expect(r.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^normalize: /), expect.stringMatching(/^history: /), 'outputCap: max_tokens set to 1024']))
  })

  test('steps can be switched off individually', async () => {
    const steps = { ...DEFAULTS.steps, history: false, tools: { enabled: false }, outputCap: null }
    const r = await runPipeline({ messages: longConversation(), tools: manyTools, model: 'gpt-4.1', steps })
    expect(Object.keys(r.byStep)).toEqual(['normalize', 'dedupe'])
    expect(r.tools).toBe(manyTools)
    expect(r.params).toEqual({})
  })

  test('steps that need fixed tools / params are skipped with a note', async () => {
    const r = await runPipeline({ messages: [{ role: 'user', content: 'x' }], tools: manyTools, model: 'gpt-4.1', steps: DEFAULTS.steps, editable: { tools: false, params: false } })
    expect(r.notes).toEqual(["tools: skipped, the client's tools are fixed", "outputCap: skipped, the client's params are fixed"])
  })

  test('empty input', async () => {
    const r = await runPipeline({ messages: undefined, steps: { normalize: true } })
    expect(r).toMatchObject({ messages: [], estimateBefore: 0, estimateAfter: 0 })
  })

  test('a failing step rejects (the optimizer then sends the original)', async () => {
    await expect(runPipeline({ messages: [{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }], steps: { history: { maxTurns: 1, strategy: 'nope' } } })).rejects.toThrow()
  })

  test('stepOptions', () => {
    expect(stepOptions(true)).toEqual({})
    expect(stepOptions(false)).toBeNull()
    expect(stepOptions(undefined)).toBeNull()
    expect(stepOptions({ enabled: false })).toBeNull()
    expect(stepOptions({ maxTurns: 2 })).toEqual({ maxTurns: 2 })
  })
})

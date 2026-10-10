'use strict'
const { outputCap } = require('../../../lib/pipeline/steps/outputCap')

describe('outputCap step', () => {
  test('sets max_tokens when the caller set none', () => {
    expect(outputCap({ params: { temperature: 0 }, model: 'gpt-4.1' }, { default: 256 })).toEqual({ params: { temperature: 0, max_tokens: 256 }, notes: ['max_tokens set to 256'] })
    expect(outputCap({ params: undefined, model: 'gpt-4.1' }, {}).params).toEqual({ max_tokens: 1024 })
  })

  test('keeps a caller limit', () => {
    const params = { max_tokens: 50 }
    expect(outputCap({ params, model: 'gpt-4.1' }, { default: 256 }).params).toBe(params)
    expect(outputCap({ params: { max_completion_tokens: 5 }, model: 'gpt-4.1' }, {}).params).toEqual({ max_completion_tokens: 5 })
  })

  test('skips reasoning models unless enabled', () => {
    expect(outputCap({ params: {}, model: 'azure-openai--o3-mini' }, {})).toEqual({ params: {}, notes: ['skipped: reasoning model'] })
    expect(outputCap({ params: {}, model: 'gpt-5' }, { reasoningModels: true }).params).toEqual({ max_tokens: 1024 })
  })

  test('a non-positive default disables it', () => {
    expect(outputCap({ params: {}, model: 'gpt-4.1' }, { default: 0 }).notes).toEqual([])
  })
})

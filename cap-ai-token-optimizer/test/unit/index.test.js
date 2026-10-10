'use strict'
describe('package entry', () => {
  test('exports a process-wide singleton', () => {
    const a = require('../../index')
    jest.resetModules()
    const b = require('../../index')
    expect(a.optimizer).toBe(b.optimizer)
    expect(a.createOptimizer()).not.toBe(a.optimizer)
    expect(typeof a.classifyError).toBe('function')
    expect(a.CATEGORIES).toContain('RATE_LIMIT')
  })
})

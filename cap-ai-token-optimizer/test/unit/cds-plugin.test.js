'use strict'
describe('cds-plugin', () => {
  afterEach(() => { delete globalThis.cds; jest.resetModules() })

  test('configures the singleton from cds.env and flushes on shutdown', async () => {
    const handlers = {}
    globalThis.cds = {
      env: { requires: { tokenOptimizer: { mode: 'shadow', metrics: { exporters: [] } } } },
      on: (evt, fn) => { handlers[evt] = fn },
      once: (evt, fn) => { handlers[evt] = fn }
    }
    require('../../cds-plugin')
    const { optimizer } = require('../../index')
    expect(optimizer.config.mode).toBe('shadow')
    expect(typeof handlers.shutdown).toBe('function')
    handlers.served()
    await new Promise(setImmediate)
    await expect(handlers.shutdown()).resolves.toBeUndefined()
  })

  test('a broken config does not crash the app', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    globalThis.cds = { env: { get requires () { throw new Error('bad env') } }, on () {}, once () {} }
    try {
      expect(() => require('../../cds-plugin')).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith('[token-optimizer]', 'could not configure token optimizer:', 'bad env')
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('adds the admin service model and applies the configured role', () => {
    const handlers = {}
    globalThis.cds = {
      env: { requires: { tokenOptimizer: { admin: { enabled: true, role: 'Ops' }, metrics: { exporters: [] } } } },
      on: (evt, fn) => { handlers[evt] = fn },
      once () {}
    }
    require('../../cds-plugin')
    expect(globalThis.cds.env.requires.tokenOptimizer.model).toEqual([require('node:path').resolve(__dirname, '../../srv/admin-service')])
    const csn = { definitions: { TokenOptimizerService: { '@requires': 'TokenOptimizerAdmin' } } }
    handlers.loaded(csn)
    handlers.loaded({})
    expect(csn.definitions.TokenOptimizerService['@requires']).toBe('Ops')
  })

  test('no admin service unless enabled', () => {
    globalThis.cds = { env: { requires: { tokenOptimizer: { metrics: { exporters: [] } } } }, on () {}, once () {} }
    require('../../cds-plugin')
    expect(globalThis.cds.env.requires.tokenOptimizer.model).toBeUndefined()
  })
})

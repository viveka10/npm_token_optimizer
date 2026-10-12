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

  test('applies the configured role to the admin service', () => {
    const handlers = {}
    globalThis.cds = {
      env: { requires: { tokenOptimizer: { admin: { enabled: true, role: 'Ops' }, metrics: { exporters: [] } } } },
      on: (evt, fn) => { handlers[evt] = fn },
      once () {}
    }
    require('../../cds-plugin')
    // the models come from .cdsrc.js (see test/integration/cds-models.test.js), not from the plugin
    expect(globalThis.cds.env.requires.tokenOptimizer.model).toBeUndefined()
    const csn = { definitions: { TokenOptimizerService: { '@requires': 'TokenOptimizerAdmin' } } }
    handlers.loaded(csn)
    handlers.loaded({})
    expect(csn.definitions.TokenOptimizerService['@requires']).toBe('Ops')
  })

  test('no role handler unless the admin service is enabled', () => {
    const handlers = {}
    globalThis.cds = { env: { requires: { tokenOptimizer: { metrics: { exporters: [] } } } }, on: (evt, fn) => { handlers[evt] = fn }, once () {} }
    require('../../cds-plugin')
    expect(handlers.loaded).toBeUndefined()
  })

  test('mounts the dashboard at bootstrap, behind the auth middlewares', () => {
    const handlers = {}
    const auth = (req, res, next) => next()
    globalThis.cds = {
      env: { requires: { tokenOptimizer: { dashboard: { enabled: true, path: 'ai/usage/' }, metrics: { exporters: [] } } } },
      middlewares: { before: [auth] },
      on: (evt, fn) => { handlers[evt] = fn },
      once () {}
    }
    require('../../cds-plugin')
    expect(typeof handlers.loaded).toBe('function') // the dashboard turned the admin service on
    const app = { use: jest.fn() }
    handlers.bootstrap(app)
    expect(app.use).toHaveBeenCalledWith('/ai/usage', auth, expect.any(Function))
  })

  test('a dashboard that cannot be mounted does not crash the app', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const handlers = {}
    globalThis.cds = {
      env: { requires: { tokenOptimizer: { dashboard: { enabled: true, path: '/' }, metrics: { exporters: [] } } } },
      on: (evt, fn) => { handlers[evt] = fn },
      once () {}
    }
    try {
      require('../../cds-plugin')
      expect(() => handlers.bootstrap({ use: jest.fn() })).not.toThrow()
      expect(errorSpy).toHaveBeenCalledWith('[token-optimizer]', 'could not serve the dashboard:', 'dashboard.path must not be "/"')
    } finally {
      errorSpy.mockRestore()
    }
  })

  test('no dashboard unless enabled', () => {
    const handlers = {}
    globalThis.cds = { env: { requires: { tokenOptimizer: { admin: { enabled: true }, metrics: { exporters: [] } } } }, on: (evt, fn) => { handlers[evt] = fn }, once () {} }
    require('../../cds-plugin')
    expect(handlers.bootstrap).toBeUndefined()
  })
})

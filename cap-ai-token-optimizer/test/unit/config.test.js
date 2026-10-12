'use strict'
const { resolveConfig, deepMerge, forUseCase, DEFAULTS } = require('../../lib/config')

describe('config', () => {
  test('defaults when nothing or true is given', () => {
    expect(resolveConfig(undefined)).toEqual(deepMerge(DEFAULTS, {}))
    expect(resolveConfig(true).mode).toBe('active')
    expect(resolveConfig(true).metrics.exporters).toEqual(['console'])
  })

  test('deep merges user values over defaults', () => {
    const cfg = resolveConfig({ mode: 'shadow', steps: { history: { maxTurns: 4 } }, cache: { enabled: false } })
    expect(cfg.mode).toBe('shadow')
    expect(cfg.steps.history.maxTurns).toBe(4)
    expect(cfg.steps.normalize).toBe(true)
    expect(cfg.cache).toEqual({ enabled: false, ttlSeconds: 3600, maxEntries: 1000, maxTemperature: 0.2, scope: 'tenant' })
  })

  test('arrays replace instead of merging', () => {
    expect(resolveConfig({ metrics: { exporters: [] } }).metrics.exporters).toEqual([])
    expect(resolveConfig({ retry: { on: ['SERVER'] } }).retry.on).toEqual(['SERVER'])
  })

  test('a single exporter string becomes an array', () => {
    expect(resolveConfig({ metrics: { exporters: 'console' } }).metrics.exporters).toEqual(['console'])
  })

  test('invalid exporters fall back to defaults', () => {
    expect(resolveConfig({ metrics: { exporters: 42 } }).metrics.exporters).toEqual(['console'])
  })

  test('invalid mode falls back to active with a warning', () => {
    const warn = jest.fn()
    expect(resolveConfig({ mode: 'turbo' }, { warn }).mode).toBe('active')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turbo'))
  })

  test('invalid use-case modes are dropped with a warning; autoInstrument accepts booleans', () => {
    const warn = jest.fn()
    const cfg = resolveConfig({ mode: 'shadow', useCases: { a: { mode: 'fast' }, b: { mode: 'active' } }, autoInstrument: true }, { warn })
    expect(cfg.useCases.a).toEqual({})
    expect(cfg.useCases.b.mode).toBe('active')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('useCases.a.mode'))
    expect(cfg.autoInstrument).toEqual({ enabled: true, useCase: 'default' })
    expect(resolveConfig({ autoInstrument: { enabled: true, useCase: 'x' } }).autoInstrument).toEqual({ enabled: true, useCase: 'x' })
  })

  test('dashboard accepts a boolean and turns on the admin service', () => {
    expect(resolveConfig({}).dashboard).toEqual({ enabled: false, path: '/token-optimizer/dashboard' })
    expect(resolveConfig({}).admin.enabled).toBe(false)
    const on = resolveConfig({ dashboard: true, admin: { role: 'Ops' } })
    expect(on.dashboard).toEqual({ enabled: true, path: '/token-optimizer/dashboard' })
    expect(on.admin).toEqual({ enabled: true, role: 'Ops' })
    expect(resolveConfig({ dashboard: { enabled: true, path: '/ai/usage' } }).dashboard.path).toBe('/ai/usage')
    expect(resolveConfig({ dashboard: false }).admin.enabled).toBe(false)
  })

  test('strips CAP-internal keys', () => {
    const cfg = resolveConfig({ kind: 'token-optimizer', impl: 'x', model: 'y', mode: 'off' })
    expect(cfg).not.toHaveProperty('kind')
    expect(cfg).not.toHaveProperty('impl')
    expect(cfg).not.toHaveProperty('model')
    expect(cfg.mode).toBe('off')
  })

  test('does not mutate inputs or DEFAULTS', () => {
    const input = { steps: { history: { maxTurns: 2 } } }
    const cfg = resolveConfig(input)
    cfg.steps.history.maxTurns = 99
    cfg.metrics.exporters.push('x')
    expect(input.steps.history.maxTurns).toBe(2)
    expect(DEFAULTS.steps.history.maxTurns).toBe(10)
    expect(DEFAULTS.metrics.exporters).toEqual(['console'])
  })

  test('deepMerge ignores undefined and replaces scalars', () => {
    expect(deepMerge({ a: 1, b: { c: 2 } }, { a: undefined, b: { c: 3 } })).toEqual({ a: 1, b: { c: 3 } })
    expect(deepMerge({ a: 1 }, 5)).toBe(5)
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 })
  })

  test('keeps class instances (e.g. a cache store) intact', () => {
    class Store { get () {} }
    const store = new Store()
    expect(resolveConfig({ cache: { store } }).cache.store).toBe(store)
  })

  test('forUseCase merges per-use-case overrides', () => {
    const cfg = resolveConfig({ useCases: { invoice: { steps: { outputCap: { default: 256 } } } } })
    expect(forUseCase(cfg, 'invoice').steps.outputCap.default).toBe(256)
    expect(forUseCase(cfg, 'other')).toBe(cfg)
    expect(forUseCase(cfg, undefined)).toBe(cfg)
  })
})

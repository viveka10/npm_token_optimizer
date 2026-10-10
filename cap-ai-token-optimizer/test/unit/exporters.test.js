'use strict'
const { createConsoleExporter } = require('../../lib/exporters/console')
const { createExporters } = require('../../lib/exporters')
const log = require('../../lib/util/log')

describe('console exporter', () => {
  test('writes one JSON line per event', () => {
    const lines = []
    const x = createConsoleExporter({ stream: { write: s => lines.push(s) } })
    x.export({ id: '1', tokens: { prompt: 3 } })
    x.export({ id: '2' })
    expect(x.name).toBe('console')
    expect(lines).toHaveLength(2)
    expect(lines.every(l => l.endsWith('\n') && !l.slice(0, -1).includes('\n'))).toBe(true)
    expect(JSON.parse(lines[0])).toEqual({ type: 'ai-core-call', id: '1', tokens: { prompt: 3 } })
    expect(x.flush()).toBeUndefined()
    expect(x.shutdown()).toBeUndefined()
  })

  test('defaults to stdout', () => {
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      createConsoleExporter().export({ id: 'x' })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"id":"x"'))
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createExporters', () => {
  const warn = jest.fn()
  beforeAll(() => log._set({ debug () {}, info () {}, warn, error () {} }))
  afterAll(() => log._set(undefined))

  test('creates built-ins, accepts custom objects, skips unknown names', () => {
    const custom = { name: 'mine', export () {} }
    const out = createExporters({ metrics: { exporters: ['console', custom, 'nope'] } }, { console: { stream: { write () {} } } })
    expect(out.map(x => x.name)).toEqual(['console', 'mine'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'nope'"))
  })

  test('a failing factory is skipped with a warning', () => {
    const { FACTORIES } = require('../../lib/exporters')
    FACTORIES.broken = () => { throw new Error('no') }
    try {
      expect(createExporters({ metrics: { exporters: ['broken'] } })).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("'broken'"), 'no')
    } finally {
      delete FACTORIES.broken
    }
  })

  test('handles missing metrics config', () => {
    expect(createExporters({})).toEqual([])
  })
})

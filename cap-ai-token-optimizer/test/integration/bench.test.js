'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { main, parseArgs, loadFixtures } = require('../../bench/run')
const log = require('../../lib/util/log')

beforeAll(() => log._set({ debug () {}, info () {}, warn () {}, error () {} }))
afterAll(() => log._set(undefined))

describe('benchmark', () => {
  test('the corpus has at least 10 realistic conversations', () => {
    const fixtures = loadFixtures()
    expect(fixtures.length).toBeGreaterThanOrEqual(10)
    expect(fixtures.some(f => (f.tools?.length ?? 0) >= 30)).toBe(true)
    expect(fixtures.some(f => f.messages.filter(m => m.role === 'user').length >= 20)).toBe(true)
    for (const f of fixtures) expect(f).toEqual(expect.objectContaining({ name: expect.any(String), model: expect.any(String), messages: expect.any(Array) }))
  })

  test('prints a table with per-step savings and a total', async () => {
    const lines = []
    const { rows } = await main([], { log: s => lines.push(s) })
    const out = lines.join('\n')
    expect(out).toMatch(/Fixture\s+Before\s+normalize\s+dedupe\s+history\s+tools\s+After\s+Saved/)
    expect(out).toMatch(/TOTAL/)
    expect(rows.find(r => r.name === '11-control-compact-prompt').after).toBe(rows.find(r => r.name === '11-control-compact-prompt').before)
    expect(rows.reduce((n, r) => n + r.before - r.after, 0)).toBeGreaterThan(0)
  })

  test('--live --mock calls the model in off and active mode and saves both answers', async () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'))
    try {
      const lines = []
      const { results, runDir } = await main(['--live', '--mock', '--filter', '04-'], { log: s => lines.push(s), resultsDir })
      expect(results).toHaveLength(1)
      const saved = JSON.parse(fs.readFileSync(path.join(runDir, '04-helpdesk-repeated-instructions.json'), 'utf8'))
      expect(saved.off.content).toMatch(/Mock answer/)
      expect(saved.active.content).toMatch(/Mock answer/)
      expect(saved.active.usage.prompt_tokens).toBeLessThan(saved.off.usage.prompt_tokens)
      expect(lines.join('\n')).toMatch(/Prompt \(off\)\s+Prompt \(active\)/)
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true })
      delete process.env.AICORE_SERVICE_KEY
    }
  })

  test('--live without credentials explains what to do', async () => {
    const saved = { key: process.env.AICORE_SERVICE_KEY, vcap: process.env.VCAP_SERVICES }
    delete process.env.AICORE_SERVICE_KEY
    delete process.env.VCAP_SERVICES
    try {
      await expect(main(['--live', '--filter', '11-'], { log () {} })).rejects.toThrow(/AICORE_SERVICE_KEY/)
    } finally {
      if (saved.key) process.env.AICORE_SERVICE_KEY = saved.key
      if (saved.vcap) process.env.VCAP_SERVICES = saved.vcap
    }
  })

  test('options', () => {
    expect(parseArgs(['--filter', 'x', '--model', 'm', '--config', 'c.json'])).toEqual({ live: false, mock: false, filter: 'x', model: 'm', config: 'c.json' })
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
  })
})

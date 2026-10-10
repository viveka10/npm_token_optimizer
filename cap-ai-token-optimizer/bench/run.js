#!/usr/bin/env node
'use strict'
/**
 * Token-savings benchmark.
 *
 *   npm run bench                         estimate savings per step for every fixture (no network)
 *   npm run bench -- --live               also call AI Core in "off" and "active" mode and save both
 *                                         answers to bench/results/<timestamp>/ to compare quality
 *   npm run bench -- --live --mock        the same against the local mock AI Core server
 *
 * Options: --filter <text>  only fixtures whose name contains <text>
 *          --model <name>   override the fixture model for --live (e.g. a model deployed in your tenant)
 *          --config <file>  JSON file with optimizer configuration (same shape as cds.requires.tokenOptimizer)
 *
 * --live needs AI Core credentials: AICORE_SERVICE_KEY, or a binding via
 * `cds bind --exec -- npm run bench -- --live` in a CAP project.
 */
const fs = require('node:fs')
const path = require('node:path')
const { runPipeline } = require('../lib/pipeline')
const { resolveConfig, forUseCase } = require('../lib/config')
const { TokenOptimizer } = require('../lib/optimizer')

const FIXTURES = path.join(__dirname, '../test/fixtures/prompts')
const RESULTS = path.join(__dirname, 'results')
const STEPS = ['normalize', 'dedupe', 'history', 'tools']

function parseArgs (argv) {
  const opts = { live: false, mock: false, filter: null, model: null, config: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') opts.live = true
    else if (a === '--mock') opts.mock = true
    else if (a === '--filter') opts.filter = argv[++i]
    else if (a === '--model') opts.model = argv[++i]
    else if (a === '--config') opts.config = argv[++i]
    else throw new Error(`Unknown option: ${a}`)
  }
  return opts
}

function loadFixtures (dir = FIXTURES, filter = null) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && (!filter || f.includes(filter)))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

/** Estimate savings per step for one fixture (active-mode pipeline, no network). */
async function estimateFixture (fixture, config) {
  const cfg = forUseCase(config, fixture.useCase)
  const started = performance.now()
  const r = await runPipeline({ messages: fixture.messages, tools: fixture.tools, params: fixture.params ?? {}, model: fixture.model, steps: cfg.steps })
  return {
    name: fixture.name,
    before: r.estimateBefore,
    after: r.estimateAfter,
    byStep: r.byStep,
    notes: r.notes,
    ms: Math.round((performance.now() - started) * 10) / 10
  }
}

const pct = (saved, before) => (before ? `${((saved / before) * 100).toFixed(1)}%` : '-')

function formatTable (rows) {
  const header = ['Fixture', 'Before', ...STEPS, 'After', 'Saved', 'ms']
  const body = rows.map(r => [r.name, r.before, ...STEPS.map(s => r.byStep[s] ?? 0), r.after, pct(r.before - r.after, r.before), r.ms])
  const total = rows.reduce((t, r) => {
    t.before += r.before
    t.after += r.after
    for (const s of STEPS) t.byStep[s] = (t.byStep[s] ?? 0) + (r.byStep[s] ?? 0)
    return t
  }, { before: 0, after: 0, byStep: {} })
  body.push(['TOTAL', total.before, ...STEPS.map(s => total.byStep[s]), total.after, pct(total.before - total.after, total.before), ''])
  const all = [header, ...body].map(r => r.map(String))
  const widths = header.map((_, i) => Math.max(...all.map(r => r[i].length)))
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  const sep = widths.map(w => '-'.repeat(w)).join('  ')
  return [line(all[0]), sep, ...all.slice(1, -1).map(line), sep, line(all.at(-1))].join('\n')
}

/** Call AI Core with the fixture in "off" and "active" mode and return both results. */
async function liveFixture (fixture, config, model) {
  const out = { name: fixture.name, model }
  for (const mode of ['off', 'active']) {
    // no cache: every run must reach the model so the two answers can be compared
    const opt = new TokenOptimizer({ ...config, mode, cache: { enabled: false }, metrics: { exporters: [] } })
    let event = null
    opt.on('call', e => { event = e })
    try {
      const r = await opt.chat({
        useCase: fixture.useCase,
        model,
        messages: fixture.messages,
        tools: fixture.tools,
        temperature: fixture.params?.temperature,
        maxTokens: fixture.params?.max_tokens
      })
      out[mode] = { content: r.content, toolCalls: r.toolCalls, finishReason: r.finishReason, usage: r.usage, tokens: event?.tokens, savings: event?.savings }
    } catch (e) {
      out[mode] = { error: event?.error ?? { message: e.message } }
    } finally {
      await opt.shutdown()
    }
  }
  return out
}

function formatLiveTable (results) {
  const rows = results.map(r => {
    const off = r.off?.usage?.prompt_tokens
    const act = r.active?.usage?.prompt_tokens
    return [r.name, off ?? (r.off?.error ? 'error' : '-'), act ?? (r.active?.error ? 'error' : '-'), off && act ? pct(off - act, off) : '-']
  })
  const all = [['Fixture', 'Prompt (off)', 'Prompt (active)', 'Saved'], ...rows].map(r => r.map(String))
  const widths = all[0].map((_, i) => Math.max(...all.map(r => r[i].length)))
  return all.map(r => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')).join('\n')
}

async function main (argv = process.argv.slice(2), { log = console.log, resultsDir = RESULTS } = {}) {
  const opts = parseArgs(argv)
  const config = resolveConfig(opts.config ? JSON.parse(fs.readFileSync(opts.config, 'utf8')) : {})
  const fixtures = loadFixtures(FIXTURES, opts.filter)
  if (!fixtures.length) throw new Error('No fixtures found')

  const rows = []
  for (const f of fixtures) rows.push(await estimateFixture(f, config))
  log(`Estimated prompt tokens per step (${fixtures.length} fixtures, active mode)\n`)
  log(formatTable(rows))

  if (!opts.live) return { rows }

  let mock = null
  if (opts.mock) {
    const { createMockAiCore } = require('../test/mock-aicore/server')
    mock = createMockAiCore()
    await mock.start()
    process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
  } else if (!process.env.AICORE_SERVICE_KEY && !/"aicore"/.test(process.env.VCAP_SERVICES ?? '')) {
    throw new Error('--live needs AI Core credentials: set AICORE_SERVICE_KEY or run via `cds bind --exec -- npm run bench -- --live`')
  }
  try {
    const runDir = path.join(resultsDir, new Date().toISOString().replace(/[:.]/g, '-') + (mock ? '-mock' : ''))
    fs.mkdirSync(runDir, { recursive: true })
    const results = []
    for (const f of fixtures) {
      const r = await liveFixture(f, config, opts.model ?? f.model)
      fs.writeFileSync(path.join(runDir, `${f.name}.json`), JSON.stringify(r, null, 2) + '\n')
      results.push(r)
    }
    log('\nLive prompt tokens reported by AI Core\n')
    log(formatLiveTable(results))
    log(`\nAnswers saved to ${path.relative(process.cwd(), runDir) || runDir}`)
    return { rows, results, runDir }
  } finally {
    await mock?.stop()
  }
}

module.exports = { main, parseArgs, loadFixtures, estimateFixture, formatTable, formatLiveTable, liveFixture }

if (require.main === module) {
  main().catch(e => {
    console.error(e.message)
    process.exitCode = 1
  })
}

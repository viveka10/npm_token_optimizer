'use strict'
/**
 * The plugin's CDS models must be part of the model wherever CAP resolves it: at runtime, but
 * also in `cds build` and `cds deploy`, which rebuild cds.env from the config files after the
 * plugins are loaded. `model` is computed in .cdsrc.js from the app's final configuration.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const cds = require('@sap/cds')
const { name } = require('../../package.json')

const PKG_ROOT = path.resolve(__dirname, '../..')
const ENV_VARS = ['CDS_PLUGINS', 'CDS_ENV', 'cds_requires_tokenOptimizer_admin_enabled']
const saved = {}
let dir

beforeAll(() => { for (const v of ENV_VARS) saved[v] = process.env[v] })
afterEach(() => {
  for (const v of ENV_VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v] }
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A CAP app with this package installed and `tokenOptimizer` as given; returns its cds.env. */
function appEnv (tokenOptimizer, extraRequires = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-models-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'app', dependencies: { [name]: '*' }, cds: { requires: { tokenOptimizer, ...extraRequires } }
  }))
  const scope = path.join(dir, 'node_modules', path.dirname(name))
  fs.mkdirSync(scope, { recursive: true })
  fs.symlinkSync(PKG_ROOT, path.join(scope, path.basename(name)), 'dir')
  process.env.CDS_PLUGINS = JSON.stringify({ [name]: { impl: path.join(PKG_ROOT, 'cds-plugin.js') } })
  return cds.env.for('cds', dir)
}

/** The plugin's model files that `cds.resolve('*')` finds for the app, relative to this package. */
const resolved = (env) => (cds.resolve('*', { env, root: dir, cache: {} }) ?? [])
  .map(f => path.relative(PKG_ROOT, fs.realpathSync(path.resolve(dir, f))).replace(/\.cds$/, ''))
  .filter(f => !f.startsWith('..') && !f.startsWith('node_modules'))

describe('plugin models in cds.env (cds build, cds deploy, runtime)', () => {
  test('db exporter and admin service: entity, service and usage log projection', () => {
    const env = appEnv({ metrics: { exporters: ['console', 'db'] }, admin: { enabled: true } })
    expect(env.requires.tokenOptimizer.model).toEqual([
      `${name}/db/token-usage-log`, `${name}/srv/admin-service`, `${name}/srv/admin-usage-log`
    ])
    expect(resolved(env)).toEqual(['db/token-usage-log', 'srv/admin-service', 'srv/admin-usage-log'])
  })

  test('only what is enabled: hana alias without admin service', () => {
    const env = appEnv({ metrics: { exporters: ['hana'] } })
    expect(resolved(env)).toEqual(['db/token-usage-log'])
  })

  test('nothing enabled: no models', () => {
    const env = appEnv({ mode: 'shadow' })
    expect(env.requires.tokenOptimizer.model).toBeUndefined()
    expect(resolved(env)).toEqual([])
  })

  test('profiles and environment variables are applied before the models are computed', () => {
    process.env.CDS_ENV = 'cloud'
    process.env.cds_requires_tokenOptimizer_admin_enabled = 'true'
    const env = appEnv({ '[cloud]': { metrics: { exporters: ['console', 'db'] } } })
    expect(resolved(env)).toEqual(['db/token-usage-log', 'srv/admin-service', 'srv/admin-usage-log'])
  })

  test('models the app lists itself are kept, without duplicates', () => {
    const env = appEnv({ model: ['srv/extra', `${name}/db/token-usage-log`], metrics: { exporters: ['db'] } })
    expect(env.requires.tokenOptimizer.model).toEqual(['srv/extra', `${name}/db/token-usage-log`])
  })

  test('kind is set by the plugin', () => {
    expect(appEnv({}).requires.tokenOptimizer.kind).toBe('token-optimizer')
  })
})

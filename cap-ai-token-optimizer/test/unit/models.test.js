'use strict'
const { modelsFor } = require('../../lib/models')
const { name } = require('../../package.json')

describe('modelsFor', () => {
  test('nothing enabled', () => {
    expect(modelsFor(undefined)).toEqual([])
    expect(modelsFor({ dashboard: { enabled: false } })).toEqual([])
  })

  test('the dashboard needs the admin service', () => {
    expect(modelsFor({ dashboard: true })).toEqual([`${name}/srv/admin-service`])
    expect(modelsFor({ dashboard: { enabled: true }, metrics: { exporters: ['db'] } })).toEqual([
      `${name}/db/token-usage-log`, `${name}/srv/admin-service`, `${name}/srv/admin-usage-log`
    ])
  })
})

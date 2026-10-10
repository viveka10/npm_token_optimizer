'use strict'
const { check, REQUIRED } = require('../../scripts/check-pack')

const ok = [...REQUIRED, 'lib/optimizer.js', 'srv/admin-service.cds', 'db/token-usage-log.cds', 'docs/integration-guide.md']
const noText = () => null

describe('check:pack', () => {
  test('accepts the expected package contents', () => {
    expect(check(ok, () => 'module.exports = {}')).toEqual([])
  })

  test.each([
    'test/unit/x.test.js', '.env', 'lib/.env.local', '.cdsrc-private.json', 'default-env.json',
    'aicore-service-key.json', 'my_credentials.json', 'certs/server.pem', 'bench/results/a.json',
    'coverage/lcov.info', 'lib/node_modules/x/index.js', 'db.sqlite', 'cap-ai-token-optimizer-0.1.0.tgz'
  ])('rejects %s', (file) => {
    expect(check([...ok, file], noText)).toEqual([expect.stringContaining(file)])
  })

  test('reports missing required files', () => {
    expect(check(ok.filter(f => f !== 'LICENSE'), noText)).toEqual(['LICENSE: required file is missing'])
  })

  // fake values, assembled at runtime so no secret-like literal is committed
  const j = (...parts) => parts.join('')
  test.each([
    [j('{ "client', 'secret": "abcd1234efgh" }'), 'client secret'],
    [j('-----BEGIN RSA ', 'PRIVATE KEY-----'), 'private key'],
    [j('token npm', '_', 'a'.repeat(36)), 'npm token'],
    [j('ghp', '_', 'A'.repeat(36)), 'GitHub token'],
    [j('AKIA', 'ABCDEFGHIJKLMNOP'), 'AWS access key'],
    [j('{"access_token":"ey', 'JhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9"}'), 'OAuth token']
  ])('finds secrets: %s', (text, what) => {
    expect(check(ok, f => (f === 'lib/optimizer.js' ? text : ''))).toEqual([`lib/optimizer.js: contains what looks like a ${what}`])
  })

  test('placeholders are not secrets', () => {
    expect(check(ok, () => '{ "clientsecret": "${SECRET}" } { "clientsecret": "<your secret>" }')).toEqual([])
  })
})

'use strict'
/**
 * In the [development] profile, start the mock AI Core server from @viveka10/cap-ai-token-optimizer
 * unless real credentials are present. The mock is only available through the local
 * `file:` install; it is not part of the published package.
 */
const path = require('node:path')
const cds = require('@sap/cds')

module.exports = async function server (options) {
  const hasBinding = process.env.AICORE_SERVICE_KEY || /"aicore"/.test(process.env.VCAP_SERVICES ?? '')
  if (cds.env.requires.aicore?.mock && !hasBinding) {
    const pkg = path.dirname(require.resolve('@viveka10/cap-ai-token-optimizer/package.json'))
    const { createMockAiCore } = require(path.join(pkg, 'test/mock-aicore/server'))
    const mock = createMockAiCore()
    const url = await mock.start(Number(process.env.MOCK_AICORE_PORT ?? 0))
    process.env.AICORE_SERVICE_KEY = JSON.stringify(mock.serviceKey)
    cds.log('sample').info(`using mock AI Core at ${url}`)
    cds.on('shutdown', () => mock.stop())
  }
  return cds.server(options)
}

'use strict'
const { orchestration, foundationModels, detectAdapter, withTimeout, firstModuleConfig, serializeResponse, rememberResponseClass, rehydrateResponse } = require('../../lib/client/adapters')
const { ORIGIN, untag } = require('../../lib/pipeline/messages')

class FakeOrchestrationClient {
  constructor (config, deploymentConfig, destination) { Object.assign(this, { config, deploymentConfig, destination }) }
  chatCompletion () {}
}

describe('SDK adapters', () => {
  test('detects client types', () => {
    expect(detectAdapter({ chatCompletion () {} })).toBe(orchestration)
    expect(detectAdapter({ run () {}, modelDeployment: 'gpt-4.1' })).toBe(foundationModels)
    expect(detectAdapter({ run () {} })).toBeNull()
    expect(detectAdapter(null)).toBeNull()
  })

  test('orchestration: reads model, deployment and messages in the order they are sent', () => {
    const client = new FakeOrchestrationClient(
      { promptTemplating: { model: { name: 'gpt-4.1', params: { max_tokens: 50 } }, prompt: { template: [{ role: 'system', content: 's' }], tools: [{ type: 'function' }] } } },
      { resourceGroup: 'rg1' })
    const info = orchestration.extract(client, [{ messages: [{ role: 'user', content: 'u' }], messagesHistory: [{ role: 'user', content: 'h' }] }])
    expect(info).toMatchObject({ model: 'gpt-4.1', deploymentId: null, resourceGroup: 'rg1', tools: [{ type: 'function' }], params: { max_tokens: 50 }, editable: { tools: true, params: true } })
    expect(info.messages.map(untag)).toEqual([{ role: 'user', content: 'h' }, { role: 'system', content: 's' }, { role: 'user', content: 'u' }])
    expect(info.messages.map(m => m[ORIGIN])).toEqual(['history', 'template', 'request'])
  })

  test('orchestration: tools and params are fixed for list configs and plain objects', () => {
    expect(orchestration.extract(new FakeOrchestrationClient([{ promptTemplating: { model: { name: 'a' } } }]), []).editable).toEqual({ tools: false, params: false })
    expect(orchestration.extract({ config: { promptTemplating: { model: { name: 'a' } } }, chatCompletion () {} }, []).editable.tools).toBe(false)
  })

  test('orchestration: tolerates missing config and requests', () => {
    expect(orchestration.extract({}, [])).toMatchObject({ model: null, messages: [], params: {} })
  })

  test('orchestration: apply splits messages back and builds a sibling client for new tools/params', () => {
    const config = { promptTemplating: { model: { name: 'gpt-4.1', params: { temperature: 0 } }, prompt: { template: [{ role: 'system', content: 's' }], tools: [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }] } } }
    const client = new FakeOrchestrationClient(config, { resourceGroup: 'rg' }, { url: 'http://x' })
    const args = [{ messages: [{ role: 'user', content: 'u  x' }], messagesHistory: [{ role: 'user', content: 'h' }], placeholderValues: { p: '1' } }, { timeout: 5 }]
    const info = orchestration.extract(client, args)

    const same = orchestration.apply(client, args, info, info)
    expect(same.client).toBe(client)
    expect(same.args).toEqual(args)
    expect(same.args[0]).not.toBe(args[0])

    const result = {
      messages: [info.messages[1], { ...info.messages[2], content: 'u x' }],
      tools: [config.promptTemplating.prompt.tools[0]],
      params: { temperature: 0, max_tokens: 100 }
    }
    const applied = orchestration.apply(client, args, info, result)
    expect(applied.args).toEqual([{ messages: [{ role: 'user', content: 'u x' }], placeholderValues: { p: '1' } }, { timeout: 5 }])
    expect(applied.client).toBeInstanceOf(FakeOrchestrationClient)
    expect(applied.client).not.toBe(client)
    expect(applied.client.config.promptTemplating.prompt.tools).toHaveLength(1)
    expect(applied.client.config.promptTemplating.model.params).toEqual({ temperature: 0, max_tokens: 100 })
    expect(applied.client.config.promptTemplating.prompt.template).toBe(config.promptTemplating.prompt.template)
    expect(applied.client.deploymentConfig).toEqual({ resourceGroup: 'rg' })
    expect(config.promptTemplating.prompt.tools).toHaveLength(2)
    expect(applied.keyMaterial).toMatchObject({ sdk: 'orchestration', destination: 'http://x', request: applied.args[0] })
    // same optimized config → same sibling client
    expect(orchestration.apply(client, args, info, result).client).toBe(applied.client)
    // all tools removed → no tools key
    expect(orchestration.apply(client, args, info, { ...result, tools: [] }).client.config.promptTemplating.prompt).not.toHaveProperty('tools')
  })

  test('orchestration: reads the first module of a fallback list and JSON configs', () => {
    expect(firstModuleConfig([{ promptTemplating: { model: { name: 'a' } } }, {}]).promptTemplating.model.name).toBe('a')
    const json = JSON.stringify({ config: { modules: { prompt_templating: { model: { name: 'b' }, prompt: { template: [] } } } } })
    expect(firstModuleConfig(json).promptTemplating.model.name).toBe('b')
    const list = JSON.stringify({ modules: [{ prompt_templating: { model: { name: 'c' } } }] })
    expect(firstModuleConfig(list).promptTemplating.model.name).toBe('c')
    expect(firstModuleConfig(JSON.stringify({}))).toBeNull()
    expect(firstModuleConfig('not json')).toBeNull()
    expect(firstModuleConfig({ id: 'stored-config-ref' })).toBeNull()
  })

  test('foundation models: string and object deployments', () => {
    const tools = [{ type: 'function' }]
    const info = foundationModels.extract({ modelDeployment: 'gpt-4o' }, [{ messages: [{ role: 'user', content: 'x' }], tools, max_tokens: 10 }])
    expect(info).toMatchObject({ model: 'gpt-4o', deploymentId: null, resourceGroup: null, tools, params: { max_tokens: 10 }, editable: { tools: true, params: true } })
    expect(info.messages.map(untag)).toEqual([{ role: 'user', content: 'x' }])
    expect(foundationModels.extract({ modelDeployment: { deploymentId: 'd1', resourceGroup: 'rg' } }, [{}]))
      .toMatchObject({ model: null, deploymentId: 'd1', resourceGroup: 'rg', messages: [] })
    expect(foundationModels.extract({ modelDeployment: { modelName: 'gpt-4.1' } }, []).model).toBe('gpt-4.1')
  })

  test('foundation models: apply builds the request', () => {
    const client = { modelDeployment: 'gpt-4o', run () {}, destination: { destinationName: 'AICORE' } }
    const args = [{ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }, { type: 'function' }], temperature: 0 }]
    const info = foundationModels.extract(client, args)
    const applied = foundationModels.apply(client, args, info, { messages: info.messages, tools: [args[0].tools[0]], params: { temperature: 0, max_tokens: 9 } })
    expect(applied.client).toBe(client)
    expect(applied.args[0]).toEqual({ messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function' }], temperature: 0, max_tokens: 9 })
    expect(applied.keyMaterial.destination).toBe('AICORE')
    const noTools = foundationModels.apply(client, [{ messages: [] }], info, { messages: [], tools: undefined, params: {} })
    expect(noTools.args[0]).toEqual({ messages: [] })
  })

  test('responses are serialized to JSON and rebuilt', () => {
    class Resp { constructor (raw) { this.rawResponse = raw; this._data = raw.data } getContent () { return this._data.c } }
    const live = new Resp({ data: { c: 'hi' }, headers: { 'x-aicore-request-id': 'r1', 'set-cookie': 'no' } })
    expect(serializeResponse('orchestration', live)).toEqual({ sdk: 'orchestration', data: { c: 'hi' }, headers: { 'x-aicore-request-id': 'r1' } })
    expect(serializeResponse('orchestration', {})).toBeNull()
    rememberResponseClass('orchestration', live)
    rememberResponseClass('orchestration', { plain: true })
    const entry = serializeResponse('orchestration', live)
    const a = rehydrateResponse(entry)
    const b = rehydrateResponse(entry)
    expect(a).toBeInstanceOf(Resp)
    expect(a.getContent()).toBe('hi')
    a._data.c = 'changed'
    expect(b.getContent()).toBe('hi')
  })

  test('rebuilds responses with the SDK class when none was seen in this process', () => {
    const r = rehydrateResponse({ sdk: 'foundation-models', data: { choices: [{ index: 0, message: { content: 'x' } }] }, headers: {} })
    expect(r.getContent()).toBe('x')
  })

  test('withTimeout adds a timeout only when the caller set none', () => {
    expect(withTimeout([{}], 1, null)).toEqual([{}])
    expect(withTimeout([{}], 1, 500)).toEqual([{}, { timeout: 500 }])
    expect(withTimeout([{}], 3, 500)).toEqual([{}, undefined, undefined, { timeout: 500 }])
    expect(withTimeout([{}, { headers: { a: 1 } }], 1, 500)).toEqual([{}, { headers: { a: 1 }, timeout: 500 }])
    const args = [{}, { timeout: 100 }]
    expect(withTimeout(args, 1, 500)).toBe(args)
  })
})

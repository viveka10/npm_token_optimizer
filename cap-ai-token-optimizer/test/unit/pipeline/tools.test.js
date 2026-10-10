'use strict'
const { tools, keywords, shorten, usedToolNames } = require('../../../lib/pipeline/steps/tools')

const fn = (name, description, props = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: props } } })
const TOOLS = [
  fn('get_weather', 'Current weather for a city'),
  fn('create_sales_order', 'Create a sales order for a customer', { customerId: { type: 'string' } }),
  fn('get_sales_order_status', 'Status of a sales order', { salesOrder: { type: 'string' } }),
  fn('list_invoices', 'List supplier invoices'),
  fn('send_email', 'Send an email'),
  fn('book_flight', 'Book a flight')
]
const ask = (text, extra = []) => [{ role: 'system', content: 'S' }, ...extra, { role: 'user', content: text }]

describe('tools step', () => {
  test('keeps the most relevant tools in their original order', () => {
    const { tools: out, notes } = tools({ messages: ask('What is the status of sales order 4711?'), tools: TOOLS, params: {} }, { maxTools: 2 })
    expect(out.map(t => t.function.name)).toEqual(['create_sales_order', 'get_sales_order_status'])
    expect(notes).toEqual(['4 of 6 tools removed'])
  })

  test('pinned, used and forced tools are always kept', () => {
    const used = [
      { role: 'user', content: 'mail it' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'send_email', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', name: 'list_invoices', content: 'ok' }
    ]
    const { tools: out } = tools(
      { messages: ask('sales order status', used), tools: TOOLS, params: { tool_choice: { type: 'function', function: { name: 'book_flight' } } } },
      { maxTools: 2, pinned: ['get_weather'] })
    expect(out.map(t => t.function.name)).toEqual(['get_weather', 'list_invoices', 'send_email', 'book_flight'])
  })

  test('without keyword matches the first tools are kept', () => {
    const { tools: out } = tools({ messages: ask('hello'), tools: TOOLS, params: {} }, { maxTools: 3 })
    expect(out.map(t => t.function.name)).toEqual(['get_weather', 'create_sales_order', 'get_sales_order_status'])
  })

  test('non-function tools are kept', () => {
    const defs = [...TOOLS, { type: 'retrieval' }]
    const { tools: out } = tools({ messages: ask('hello'), tools: defs, params: {} }, { maxTools: 2 })
    expect(out).toHaveLength(2)
    expect(out[0].function.name).toBe('get_weather')
    expect(out.at(-1)).toEqual({ type: 'retrieval' })
  })

  test('shortens long tool and parameter descriptions at sentence ends', () => {
    const long = 'Returns the open items. ' + 'Very long explanation. '.repeat(10)
    const defs = [fn('t', long, { a: { type: 'string', description: long }, b: { type: 'array', items: { type: 'object', properties: { c: { type: 'string', description: long } } } } })]
    const { tools: out, notes } = tools({ messages: ask('x'), tools: defs, params: {} }, { maxDescriptionLength: 60 })
    expect(out[0].function.description).toBe('Returns the open items. Very long explanation.')
    expect(out[0].function.parameters.properties.a.description.length).toBeLessThanOrEqual(60)
    expect(out[0].function.parameters.properties.b.items.properties.c.description.length).toBeLessThanOrEqual(60)
    expect(notes).toEqual(['1 tool description(s) shortened'])
    expect(defs[0].function.description).toBe(long)
  })

  test('within limits nothing changes', () => {
    const r = tools({ messages: ask('x'), tools: TOOLS, params: {} }, {})
    expect(r.tools).toEqual(TOOLS)
    expect(r.tools[0]).toBe(TOOLS[0])
    expect(r.notes).toEqual([])
    expect(tools({ messages: [], tools: undefined }, {}).tools).toBeUndefined()
    expect(tools({ messages: [], tools: [] }, {}).tools).toEqual([])
  })

  test('custom selector, and validation of its result', () => {
    const selector = jest.fn(({ tools: t }) => t.slice(-2))
    expect(tools({ messages: ask('x'), tools: TOOLS, params: {} }, { maxTools: 2, selector }).tools.map(t => t.function.name)).toEqual(['send_email', 'book_flight'])
    expect(() => tools({ messages: ask('x'), tools: TOOLS, params: {} }, { maxTools: 2, selector: () => null })).toThrow(/array/)
    expect(() => tools({ messages: ask('x'), tools: TOOLS, params: {} }, { maxTools: 2, pinned: ['get_weather'], selector: () => [] })).toThrow(/get_weather/)
  })

  test('helpers', () => {
    // 'get' is a stopword: most tool names start with it
    expect([...keywords('getSalesOrder sales_order the Straße')]).toEqual(['sales', 'order', 'straße'])
    expect(shorten('short', 10)).toBe('short')
    expect(shorten('nobreakshere'.repeat(5), 10)).toBe('nobreaksh…')
    expect(shorten(undefined, 10)).toBeUndefined()
    expect([...usedToolNames([{ tool_calls: [{ function: {} }] }, null])]).toEqual([])
  })
})

'use strict'
/**
 * Simulated MCP-style agent context: 32 S/4HANA tool definitions and a multi-turn
 * conversation with tool calls. Data is invented for the demo.
 */

const RULES = 'Use only data returned by the tools. If a tool returns no data, say so instead of guessing. ' +
  'Amounts are in the document currency unless stated otherwise.'

const SYSTEM = `You are an order-to-cash assistant for SAP S/4HANA Cloud.
You help sales and finance users look up and change business documents through the available tools.

${RULES}

Before changing a document, summarize the change and ask the user to confirm.`

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } }
})

const TOOLS = [
  tool('get_sales_order', 'Read a sales order header with sold-to party, net value, currency, overall status and requested delivery date.', { salesOrder: str('Sales order number, e.g. 4711') }),
  tool('list_sales_order_items', 'List the items of a sales order with material, quantity, unit and net value.', { salesOrder: str('Sales order number') }),
  tool('get_sales_order_status', 'Read delivery, billing and credit status of a sales order.', { salesOrder: str('Sales order number') }),
  tool('create_sales_order', 'Create a standard sales order. Only call after the user confirmed all values.', { soldToParty: str('Customer number'), material: str('Material number'), quantity: num('Order quantity') }),
  tool('change_sales_order_delivery_date', 'Change the requested delivery date of a sales order. Requires user confirmation.', { salesOrder: str('Sales order number'), date: str('New date, ISO 8601') }),
  tool('cancel_sales_order', 'Reject all open items of a sales order with a rejection reason. Requires user confirmation.', { salesOrder: str('Sales order number'), reason: str('Rejection reason code') }),
  tool('get_customer', 'Read a business partner in the customer role: name, address, payment terms, sales area data.', { customer: str('Customer number') }),
  tool('search_customers', 'Search customers by name, city or country. Returns at most 20 matches.', { query: str('Search text') }),
  tool('get_customer_credit_exposure', 'Read credit limit, exposure and credit segment of a customer.', { customer: str('Customer number') }),
  tool('list_open_items', 'List open accounts receivable items of a customer with due dates and dunning level.', { customer: str('Customer number') }),
  tool('get_billing_document', 'Read a billing document (invoice) with net amount, tax and accounting status.', { billingDocument: str('Billing document number') }),
  tool('list_billing_documents_for_order', 'List billing documents created for a sales order.', { salesOrder: str('Sales order number') }),
  tool('get_outbound_delivery', 'Read an outbound delivery with shipping point, picking and goods issue status.', { delivery: str('Delivery number') }),
  tool('list_deliveries_for_order', 'List outbound deliveries for a sales order.', { salesOrder: str('Sales order number') }),
  tool('post_goods_issue', 'Post goods issue for an outbound delivery. Requires user confirmation.', { delivery: str('Delivery number') }),
  tool('get_material', 'Read a product master: description, base unit, material group, gross weight.', { material: str('Material number') }),
  tool('get_material_stock', 'Read unrestricted, blocked and quality-inspection stock per plant and storage location.', { material: str('Material number'), plant: str('Plant') }),
  tool('check_availability', 'Run an ATP check for a material, quantity and date.', { material: str('Material number'), plant: str('Plant'), quantity: num('Quantity'), date: str('Requested date') }),
  tool('get_price', 'Simulate pricing for a customer and material, returning net price and conditions.', { customer: str('Customer number'), material: str('Material number'), quantity: num('Quantity') }),
  tool('get_purchase_order', 'Read a purchase order with supplier, items and delivery schedule.', { purchaseOrder: str('Purchase order number') }),
  tool('list_purchase_orders_for_material', 'List open purchase orders for a material.', { material: str('Material number') }),
  tool('get_supplier', 'Read a business partner in the supplier role.', { supplier: str('Supplier number') }),
  tool('get_supplier_invoice', 'Read a supplier invoice with amounts, tax and payment block.', { invoice: str('Supplier invoice number'), fiscalYear: str('Fiscal year') }),
  tool('get_journal_entry', 'Read a journal entry with line items, G/L accounts and amounts.', { accountingDocument: str('Document number'), companyCode: str('Company code'), fiscalYear: str('Fiscal year') }),
  tool('get_cost_center', 'Read a cost center with responsible person and validity.', { costCenter: str('Cost center') }),
  tool('get_exchange_rate', 'Read the exchange rate between two currencies for a date.', { from: str('Source currency'), to: str('Target currency'), date: str('Date') }),
  tool('create_customer_note', 'Attach a text note to a customer. Requires user confirmation.', { customer: str('Customer number'), text: str('Note text') }),
  tool('send_order_confirmation', 'Send the order confirmation output for a sales order by email. Requires user confirmation.', { salesOrder: str('Sales order number') }),
  tool('get_shipping_tracking', 'Read the carrier tracking status for a delivery.', { delivery: str('Delivery number') }),
  tool('list_returns_for_customer', 'List customer returns with reason and refund status.', { customer: str('Customer number') }),
  tool('get_contract', 'Read a sales contract with validity, target quantity and released quantity.', { contract: str('Contract number') }),
  tool('get_company_code', 'Read company code settings: currency, country, fiscal year variant.', { companyCode: str('Company code') })
]

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args, null, 2) } })
const result = (id, data) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(data, null, 2) })

/** Earlier turns of the conversation, with tool calls and results. */
const HISTORY = [
  { role: 'user', content: `Can you look up customer 10100001?\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c1', 'get_customer', { customer: '10100001' })] },
  result('c1', { customer: '10100001', name: 'Inlandskunde DE 1', city: 'Walldorf', country: 'DE', paymentTerms: 'NT30', salesOrg: '1010' }),
  { role: 'assistant', content: 'Customer 10100001 is Inlandskunde DE 1 in Walldorf, Germany, with payment terms NT30 (net 30 days).' },
  { role: 'user', content: `What is their credit exposure?\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c2', 'get_customer_credit_exposure', { customer: '10100001' })] },
  result('c2', { customer: '10100001', creditLimit: 250000, exposure: 182340.5, currency: 'EUR', segment: '1000' }),
  { role: 'assistant', content: 'The credit limit is 250,000.00 EUR and the current exposure is 182,340.50 EUR, so 67,659.50 EUR is still available.' },
  { role: 'user', content: `Show me their open items.\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c3', 'list_open_items', { customer: '10100001' })] },
  result('c3', { items: [
    { document: '1800000101', dueDate: '2026-09-15', amount: 12400, currency: 'EUR', dunningLevel: 1 },
    { document: '1800000117', dueDate: '2026-10-01', amount: 8600.75, currency: 'EUR', dunningLevel: 0 }
  ] }),
  { role: 'assistant', content: 'There are two open items: 1800000101 (12,400.00 EUR, due 15 Sep 2026, dunning level 1) and 1800000117 (8,600.75 EUR, due 1 Oct 2026).' },
  { role: 'user', content: `Which sales orders are still open for them?\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c4', 'search_customers', { query: '10100001' })] },
  result('c4', { matches: [{ customer: '10100001', openSalesOrders: ['4711', '4723'] }] }),
  { role: 'assistant', content: 'Sales orders 4711 and 4723 are still open.' },
  { role: 'user', content: `Is material TG11 in stock in plant 1010?\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c5', 'get_material_stock', { material: 'TG11', plant: '1010' })] },
  result('c5', { material: 'TG11', plant: '1010', unrestricted: 340, blocked: 0, qualityInspection: 12, unit: 'PC' }),
  { role: 'assistant', content: 'Plant 1010 has 340 PC of TG11 unrestricted and 12 PC in quality inspection.' },
  { role: 'user', content: `What price would they get for 50 pieces?\n\n${RULES}` },
  { role: 'assistant', content: null, tool_calls: [call('c6', 'get_price', { customer: '10100001', material: 'TG11', quantity: 50 })] },
  result('c6', { netPrice: 1875, currency: 'EUR', conditions: [{ type: 'PPR0', amount: 2000 }, { type: 'K007', amount: -125 }] }),
  { role: 'assistant', content: '50 PC of TG11 would cost 1,875.00 EUR net: list price 2,000.00 EUR minus a 125.00 EUR customer discount.' }
]

module.exports = { SYSTEM, RULES, TOOLS, HISTORY }

'use strict'
const cds = require('@sap/cds')
const { optimizer, classifyError } = require('@viveka/cap-ai-token-optimizer')
const { SYSTEM, TOOLS, HISTORY } = require('./agent-tools')

const LOG = cds.log('agent')

// HTTP status we answer with, per AI Core failure category
const STATUS = { RATE_LIMIT: 429, CONTENT_FILTER: 422, CONTEXT_LENGTH: 413, TIMEOUT: 504 }

module.exports = class AgentService extends cds.ApplicationService {
  init () {
    // @sap-ai-sdk is ESM-only; Node >= 22.12 can require() it
    const { OrchestrationClient } = require('@sap-ai-sdk/orchestration')
    const model = { name: cds.env.requires.aicore?.model ?? 'gpt-4.1', params: { temperature: 0 } }

    const assistant = optimizer.wrap(new OrchestrationClient({
      promptTemplating: { model, prompt: { template: [{ role: 'system', content: 'You are a concise assistant for SAP business users.' }] } }
    }), { useCase: 'ask', cdsService: 'AgentService' })

    const agent = optimizer.wrap(new OrchestrationClient({
      promptTemplating: { model, prompt: { template: [{ role: 'system', content: SYSTEM }], tools: TOOLS } }
    }), { useCase: 'agent', cdsService: 'AgentService' })

    this.on('ask', async (req) => {
      const question = requireQuestion(req)
      const res = await callAi(req, () => assistant.chatCompletion({ messages: [{ role: 'user', content: question }] }))
      return res.getContent() ?? ''
    })

    this.on('runAgent', async (req) => {
      const question = requireQuestion(req)
      const res = await callAi(req, () => agent.chatCompletion({ messagesHistory: HISTORY, messages: [{ role: 'user', content: question }] }))
      const toolCalls = res.getToolCalls()
      if (toolCalls?.length) return `Tool calls requested: ${toolCalls.map(t => t.function.name).join(', ')}`
      return res.getContent() ?? ''
    })

    return super.init()
  }
}

function requireQuestion (req) {
  const question = req.data.question?.trim()
  if (!question) req.reject(400, 'question is required')
  return question
}

async function callAi (req, fn) {
  try {
    return await fn()
  } catch (err) {
    const { category } = classifyError(err)
    LOG.error('AI Core call failed:', category)
    return req.reject(STATUS[category] ?? 502, `AI service error: ${category}`)
  }
}

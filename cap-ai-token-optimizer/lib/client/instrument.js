'use strict'
/**
 * Hooks on the @sap-ai-sdk client classes, for automatic instrumentation and for clients
 * the app does not create itself (e.g. inside @sap-ai-sdk/langchain).
 *
 * The prototype methods of OrchestrationClient (chatCompletion, stream) and
 * AzureOpenAiChatClient (run, stream) are replaced by a hook that:
 *  - routes the call through an optimizer when one is active for it: the optimizer of the
 *    current scope (wrapLangChain(), withUseCase()), else the one with autoInstrument enabled;
 *  - otherwise calls the original method unchanged.
 * The original is kept on the hook (ORIGINAL), so the optimizer and explicitly wrapped
 * clients call it directly and nothing is measured twice.
 *
 * Safety: hooks are only installed when needed, once per class, only for SDK major version 2,
 * and failures to install are logged, never thrown. uninstall() restores the originals.
 * Only the SDK copy resolved from the app root is hooked.
 */
const { AsyncLocalStorage } = require('node:async_hooks')
const { orchestration, foundationModels } = require('./adapters')
const { loadPeer, peerVersion } = require('../util/peer')
const log = require('../util/log')

const ORIGINAL = Symbol.for('cap-ai-token-optimizer.original')
const scopes = new AsyncLocalStorage()
const installed = [] // { proto, methodName, original }
let autoTarget = null // { optimizer, opts }

const TARGETS = [
  { pkg: '@sap-ai-sdk/orchestration', className: 'OrchestrationClient', adapter: orchestration },
  { pkg: '@sap-ai-sdk/foundation-models', className: 'AzureOpenAiChatClient', adapter: foundationModels }
]

function hook (adapter, methodName, method, original) {
  const hooked = function (...args) {
    const scope = scopes.getStore()
    const target = scope ?? autoTarget
    if (!target) return original.apply(this, args)
    return target.optimizer._call({ adapter, method, methodName, client: this, args, opts: target.opts ?? {} })
  }
  hooked[ORIGINAL] = original
  return hooked
}

/**
 * Install the hooks (idempotent). Returns the names of the hooked classes.
 * @param {{ load?: (pkg: string) => object, version?: (pkg: string) => string|null }} [deps]
 */
function install (deps = {}) {
  const load = deps.load ?? ((pkg) => loadPeer(pkg))
  const version = deps.version ?? peerVersion
  const hooked = []
  for (const t of TARGETS) {
    let Cls
    try {
      Cls = load(t.pkg)?.[t.className]
    } catch (e) {
      if (e?.code !== 'PEER_DEPENDENCY_MISSING') log.warn(`could not load ${t.pkg} for instrumentation:`, e?.message)
      continue
    }
    if (typeof Cls !== 'function') continue
    const v = version(t.pkg)
    if (v && !/^2\./.test(v)) {
      log.warn(`${t.pkg}@${v} is not supported for instrumentation (supported: 2.x); its calls are not instrumented`)
      continue
    }
    for (const [methodName, method] of Object.entries(t.adapter.methods)) {
      const proto = Cls.prototype
      const current = proto[methodName]
      if (typeof current !== 'function' || current[ORIGINAL]) continue
      try {
        proto[methodName] = hook(t.adapter, methodName, method, current)
        installed.push({ proto, methodName, original: current })
      } catch (e) {
        log.warn(`could not instrument ${t.className}.${methodName}:`, e?.message)
      }
    }
    if (Cls.prototype[Object.keys(t.adapter.methods)[0]]?.[ORIGINAL]) hooked.push(t.className)
  }
  return hooked
}

/** Restore the original methods (mainly for tests). */
function uninstall () {
  for (const { proto, methodName, original } of installed.splice(0)) proto[methodName] = original
  autoTarget = null
}

/**
 * Route all SDK calls without a scope through `optimizer`.
 * @param {object} optimizer
 * @param {{ useCase?: string }} [opts]
 * @param {object} [deps] see install()
 */
function enableAuto (optimizer, opts = {}, deps) {
  if (autoTarget && autoTarget.optimizer !== optimizer) log.warn('autoInstrument moved to another optimizer instance')
  autoTarget = { optimizer, opts }
  const hooked = install(deps)
  if (hooked.length) log.info(`autoInstrument: ${hooked.join(', ')} calls are optimized and measured`)
  else log.warn('autoInstrument: no supported @sap-ai-sdk client found to instrument')
  return hooked
}

/** Stop automatic routing for `optimizer` (hooks stay installed as pass-through). */
function disableAuto (optimizer) {
  if (autoTarget?.optimizer === optimizer) autoTarget = null
}

/**
 * Run `fn` with SDK calls routed through `optimizer` with `opts`.
 * @template T
 * @param {object} optimizer
 * @param {object} opts
 * @param {() => T} fn
 * @returns {T}
 */
function runInScope (optimizer, opts, fn) {
  install()
  return scopes.run({ optimizer, opts }, fn)
}

/** The original (unhooked) implementation of a possibly hooked method. */
const originalOf = (fn) => fn?.[ORIGINAL] ?? fn

module.exports = { install, uninstall, enableAuto, disableAuto, runInScope, originalOf, scopes, ORIGINAL }

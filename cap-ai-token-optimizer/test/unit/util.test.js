'use strict'
const log = require('../../lib/util/log')
const { loadPeer } = require('../../lib/util/peer')
const { getCds } = require('../../lib/util/cds')

describe('log', () => {
  afterEach(() => { log._set(undefined); delete globalThis.cds })

  test('falls back to console when CAP is not loaded', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      log.warn('hello')
      log.debug('hidden')
      expect(spy).toHaveBeenCalledWith('[token-optimizer]', 'hello')
    } finally {
      spy.mockRestore()
    }
  })

  test('uses cds.log once CAP is loaded', () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    globalThis.cds = { log: jest.fn(() => logger) }
    log.info('a')
    log.error('b')
    expect(globalThis.cds.log).toHaveBeenCalledWith('token-optimizer')
    expect(logger.info).toHaveBeenCalledWith('a')
    expect(logger.error).toHaveBeenCalledWith('b')
  })

  test('never throws', () => {
    log._set({ warn () { throw new Error('x') } })
    expect(() => log.warn('x')).not.toThrow()
  })
})

describe('peer loading', () => {
  afterEach(() => { delete globalThis.cds })

  test('loads an installed package', () => {
    expect(typeof loadPeer('express')).toBe('function')
  })

  test('resolves from cds.root first', () => {
    globalThis.cds = { root: process.cwd() }
    expect(getCds()).toBe(globalThis.cds)
    expect(typeof loadPeer('express')).toBe('function')
  })

  test('explains how to install a missing peer', () => {
    expect(() => loadPeer('@sap-ai-sdk/does-not-exist', 'chat()')).toThrow(expect.objectContaining({
      code: 'PEER_DEPENDENCY_MISSING',
      message: expect.stringContaining('npm i @sap-ai-sdk/does-not-exist')
    }))
    expect(() => loadPeer('@sap-ai-sdk/does-not-exist')).toThrow(/^Missing peer dependency/)
  })
})

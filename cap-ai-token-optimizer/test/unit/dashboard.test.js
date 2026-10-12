'use strict'
const { createDashboardHandler, mountDashboard, normalizePath, servicePath } = require('../../lib/dashboard')

/** Minimal stand-ins for express req/res and the app's cds. */
function call ({ url = '/token-optimizer/dashboard/', method = 'GET', user, services, login } = {}) {
  const base = '/token-optimizer/dashboard'
  const cds = {
    context: { user },
    services: services ?? { TokenOptimizerService: { endpoints: [{ kind: 'odata', path: '/odata/v4/token-optimizer' }], entities: { UsageLog: {} } } }
  }
  const handler = createDashboardHandler({ path: base, role: 'TokenOptimizerAdmin' }, cds)
  const res = { headers: {} }
  Object.assign(res, {
    set: (h) => { Object.assign(res.headers, h); return res },
    type: (t) => { res.headers['Content-Type'] = t; return res },
    status: (c) => { res.statusCode = c; return res },
    sendStatus: (c) => { res.statusCode = c; return res },
    send: (b) => { res.statusCode ??= 200; res.body = b; return res },
    redirect: (c, l) => { res.statusCode = c; res.location = l; return res }
  })
  const req = { method, originalUrl: url, path: url.slice(base.length).split('?')[0] || '/', _login: login }
  const next = jest.fn()
  handler(req, res, next)
  return { res, next }
}
const user = (...roles) => ({ is: (r) => r === 'authenticated-user' || roles.includes(r) })
const anonymous = { is: () => false }

describe('dashboard handler', () => {
  test('serves the page with the relative service path and security headers', () => {
    const { res } = call({ user: user('TokenOptimizerAdmin') })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('data-service="../../odata/v4/token-optimizer"')
    expect(res.body).toContain('data-usage-log="true"')
    expect(res.headers['Content-Security-Policy']).toMatch(/script-src 'self'/)
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff')
  })

  test('says when there is no usage log', () => {
    const { res } = call({ user: user('TokenOptimizerAdmin'), services: { TokenOptimizerService: { path: '/admin', entities: {} } } })
    expect(res.body).toContain('data-service="../../admin"')
    expect(res.body).toContain('data-usage-log="false"')
  })

  test('serves the script and the stylesheet, nothing else', () => {
    const admin = user('TokenOptimizerAdmin')
    expect(call({ url: '/token-optimizer/dashboard/dashboard.js', user: admin }).res.headers['Content-Type']).toMatch(/javascript/)
    expect(call({ url: '/token-optimizer/dashboard/dashboard.css', user: admin }).res.body).toContain(':root')
    expect(call({ url: '/token-optimizer/dashboard/models.js', user: admin }).res.statusCode).toBe(404)
  })

  test('asks for a login, then requires the role', () => {
    const login = jest.fn(() => 'login')
    call({ user: anonymous, login })
    expect(login).toHaveBeenCalled()
    expect(call({ user: anonymous }).res.statusCode).toBe(401)
    expect(call({ user: user('Other') }).res.statusCode).toBe(403)
  })

  test('redirects to the trailing slash, so relative URLs work behind a router prefix', () => {
    const { res } = call({ url: '/token-optimizer/dashboard?x=1' })
    expect(res).toMatchObject({ statusCode: 301, location: 'dashboard/' })
  })

  test('passes other methods on, and answers 503 without the admin service', () => {
    expect(call({ method: 'POST', user: user('TokenOptimizerAdmin') }).next).toHaveBeenCalled()
    expect(call({ user: user('TokenOptimizerAdmin'), services: {} }).res.statusCode).toBe(503)
  })
})

describe('dashboard helpers', () => {
  test('normalizePath', () => {
    expect(normalizePath('ai//usage/')).toBe('/ai/usage')
    expect(() => normalizePath('/')).toThrow()
  })

  test('servicePath prefers the OData endpoint', () => {
    expect(servicePath({ path: '/x', endpoints: [{ kind: 'rest', path: '/rest/x' }, { kind: 'odata-v4', path: '/odata/v4/x' }] })).toBe('/odata/v4/x')
    expect(servicePath({ path: '/x' })).toBe('/x')
  })

  test('mountDashboard uses the admin role', () => {
    const app = { use: jest.fn() }
    expect(mountDashboard(app, { dashboard: { path: '/d' }, admin: {} }, { middlewares: { before: [] } })).toBe('/d')
    expect(app.use).toHaveBeenCalledWith('/d', expect.any(Function))
  })
})

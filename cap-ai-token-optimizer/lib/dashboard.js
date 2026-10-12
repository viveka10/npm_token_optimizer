'use strict'
/**
 * Serves the web dashboard (files in ../dashboard) at cds.requires.tokenOptimizer.dashboard.path.
 * The page holds no data itself: it reads the admin service from the browser. Both are protected
 * by CAP's authentication and admin.role, so the page asks for a login the same way the service
 * does. No express dependency: the app's express instance is passed in by cds-plugin.js.
 */
const fs = require('node:fs')
const path = require('node:path')

const DIR = path.join(__dirname, '..', 'dashboard')
const ASSETS = { '/dashboard.js': 'text/javascript; charset=utf-8', '/dashboard.css': 'text/css; charset=utf-8' }
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache'
}

const escapeAttr = (s) => String(s).replace(/[&"'<>]/g, c => `&#${c.charCodeAt(0)};`)

/** Normalized mount path: leading slash, no trailing slash. */
function normalizePath (p) {
  const out = '/' + String(p || '').split('/').filter(Boolean).join('/')
  if (out === '/') throw new Error('dashboard.path must not be "/"')
  return out
}

/** OData path of the served admin service, e.g. /odata/v4/token-optimizer. */
function servicePath (srv) {
  const ep = srv.endpoints?.find(e => String(e.kind).startsWith('odata'))
  return ep?.path ?? srv.path
}

/**
 * @param {{ path: string, role: string }} opts
 * @param {any} cds the app's @sap/cds
 * @returns {(req: any, res: any, next: Function) => void} handler mounted at opts.path
 */
function createDashboardHandler ({ path: base, role }, cds) {
  const files = Object.fromEntries(['/index.html', ...Object.keys(ASSETS)].map(f => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]))

  return function tokenOptimizerDashboard (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const url = req.originalUrl.split('?')[0]
    // the page uses relative URLs, so it must be served from <path>/
    if (req.path === '/' && !url.endsWith('/')) return res.redirect(301, path.posix.basename(url) + '/')

    const user = cds.context?.user
    if (!user?.is?.('authenticated-user')) return req._login?.() ?? res.sendStatus(401)
    if (!user.is(role)) return res.sendStatus(403)

    res.set(HEADERS)
    if (ASSETS[req.path]) return res.type(ASSETS[req.path]).send(files[req.path])
    if (req.path !== '/' && req.path !== '/index.html') return res.sendStatus(404)

    const srv = cds.services?.TokenOptimizerService
    if (!srv) return res.status(503).type('text/plain').send('The token optimizer admin service is not served by this app.')
    const html = files['/index.html']
      .replace('{{service}}', escapeAttr(path.posix.relative(base, servicePath(srv))))
      .replace('{{usageLog}}', srv.entities?.UsageLog ? 'true' : 'false')
    res.type('text/html; charset=utf-8').send(html)
  }
}

/**
 * Mounts the dashboard behind CAP's auth middlewares.
 * @param {any} app express application (from cds.on('bootstrap'))
 * @param {object} cfg resolved optimizer config
 * @param {any} cds the app's @sap/cds
 * @returns {string} the mount path
 */
function mountDashboard (app, cfg, cds) {
  const base = normalizePath(cfg.dashboard.path)
  const role = cfg.admin?.role || 'TokenOptimizerAdmin'
  app.use(base, ...(cds.middlewares?.before ?? []), createDashboardHandler({ path: base, role }, cds))
  return base
}

module.exports = { mountDashboard, createDashboardHandler, normalizePath, servicePath }

'use strict'
/**
 * Access the application's @sap/cds instance.
 * @sap/cds sets `global.cds`; preferring it avoids picking up a second copy from this
 * package's own node_modules (common with `file:` or `npm link` installs).
 * Returns null when CAP is not loaded — the optimizer also works outside CAP.
 * @returns {any|null}
 */
function getCds () {
  return globalThis.cds ?? null
}

module.exports = { getCds }

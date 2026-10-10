'use strict'
/**
 * Console exporter: writes one JSON line per event to stdout (or a given stream).
 * @param {{ stream?: { write: (s: string) => any } }} [opts]
 * @returns {import('../../index').Exporter}
 */
function createConsoleExporter ({ stream = process.stdout } = {}) {
  return {
    name: 'console',
    export (event) {
      stream.write(`${JSON.stringify({ type: 'ai-core-call', ...event })}\n`)
    },
    flush () {},
    shutdown () {}
  }
}

module.exports = { createConsoleExporter }

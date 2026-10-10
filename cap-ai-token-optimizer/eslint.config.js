'use strict'
const js = require('@eslint/js')
const globals = require('globals')

module.exports = [
  { ignores: ['coverage/', 'node_modules/', 'bench/results/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true, caughtErrors: 'none' }]
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.jest } }
  }
]

'use strict'
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // live tests only run on request (RUN_LIVE_TESTS=1), see test/live/
  testPathIgnorePatterns: process.env.RUN_LIVE_TESTS === '1' ? ['/node_modules/'] : ['/node_modules/', '<rootDir>/test/live/'],
  collectCoverageFrom: ['lib/**/*.js'],
  coverageReporters: ['text-summary', 'text', 'lcov'],
  coverageThreshold: { global: { lines: 80 } }
}

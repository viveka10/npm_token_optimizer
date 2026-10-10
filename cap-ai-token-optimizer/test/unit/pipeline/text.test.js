'use strict'
const { splitFences, joinSegments, minifyJson, tryMinifyJson, splitJsonBlocks, matchBracket } = require('../../../lib/pipeline/text')

describe('splitFences', () => {
  test('separates fenced code from prose and joins back losslessly', () => {
    const text = 'Intro\n```js\nconst  a = 1\n```\nmiddle\n~~~\nx   y\n~~~\nend'
    const segs = splitFences(text)
    expect(segs.map(s => s.type)).toEqual(['prose', 'code', 'prose', 'code', 'prose'])
    expect(segs[1]).toMatchObject({ info: 'js', text: '```js\nconst  a = 1\n```' })
    expect(joinSegments(segs)).toBe(text)
  })

  test('longer fences need a matching close; unclosed fences run to the end', () => {
    const segs = splitFences('a\n````\n```\nstill code\n````\nb')
    expect(segs.map(s => s.type)).toEqual(['prose', 'code', 'prose'])
    expect(splitFences('a\n```\nopen  code').map(s => s.type)).toEqual(['prose', 'code'])
  })

  test('inline triple backticks are not fences', () => {
    expect(splitFences('use ```x``` here').map(s => s.type)).toEqual(['prose'])
  })
})

describe('JSON helpers', () => {
  test('minifyJson keeps strings, numbers and duplicate keys exactly', () => {
    const src = '{\n  "a": "x  y\\" z",\n  "n": 12345678901234567890,\n  "f": 1.0,\n  "a": [ 1, 2 ]\n}'
    expect(minifyJson(src)).toBe('{"a":"x  y\\" z","n":12345678901234567890,"f":1.0,"a":[1,2]}')
  })

  test('tryMinifyJson only accepts objects and arrays', () => {
    expect(tryMinifyJson('  [ 1 ,2 ] ')).toBe('[1,2]')
    expect(tryMinifyJson('"str"')).toBeNull()
    expect(tryMinifyJson('42')).toBeNull()
    expect(tryMinifyJson('{ not json }')).toBeNull()
    expect(tryMinifyJson('{"a":1} trailing')).toBeNull()
  })

  test('matchBracket respects strings and rejects mismatches', () => {
    expect(matchBracket('{"a":"}"}x', 0)).toBe(9)
    expect(matchBracket('{]', 0)).toBe(-1)
    expect(matchBracket('{"a":1', 0)).toBe(-1)
  })

  test('splitJsonBlocks finds JSON at line starts only', () => {
    const text = 'Data:\n  {\n    "a": 1\n  }\nInline {"b": 2} stays\n[1, 2]\n{{?placeholder}}\n[link](x)'
    const parts = splitJsonBlocks(text)
    expect(parts.filter(p => p.type === 'json').map(p => p.text)).toEqual(['{\n    "a": 1\n  }', '[1, 2]'])
    expect(parts.map(p => p.text).join('')).toBe(text)
  })

  test('JSON followed by text on the same line is not a block', () => {
    expect(splitJsonBlocks('{"a": 1} and more').every(p => p.type === 'text')).toBe(true)
  })
})

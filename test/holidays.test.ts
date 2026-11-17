import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CN_HOLIDAY_RANGES, CN_HOLIDAY_SOURCES } from '../src/panel/holidays.ts'

const source = readFileSync(new URL('../src/panel/holidays.ts', import.meta.url), 'utf8')

test('the table is a well-formed year → spans map', () => {
  const years = Object.keys(CN_HOLIDAY_RANGES).map(Number)
  assert.ok(years.length > 0, 'at least one year must be present')
  for (const year of years) {
    const spans = CN_HOLIDAY_RANGES[year]
    assert.ok(Array.isArray(spans) && spans.length > 0, `${year} must list spans`)
    for (const span of spans) {
      assert.equal(span.length, 2, `${year}: each span is [from, to]`)
      const [from, to] = span
      assert.match(from, /^\d{4}-\d{2}-\d{2}$/, `${year}: from must be ISO`)
      assert.match(to, /^\d{4}-\d{2}-\d{2}$/, `${year}: to must be ISO`)
      assert.ok(from <= to, `${year}: span ${from}..${to} must not be inverted`)
      assert.equal(from.slice(0, 4), String(year), `${year}: span ${from} must belong to that year`)
      assert.equal(to.slice(0, 4), String(year), `${year}: span ${to} must belong to that year`)
    }
  }
})

test('2026 matches the announcement it was transcribed from', () => {
  assert.deepEqual(CN_HOLIDAY_RANGES[2026], [
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-23'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ])
})

test('spans within a year are sorted and non-overlapping', () => {
  for (const [year, spans] of Object.entries(CN_HOLIDAY_RANGES)) {
    for (let i = 1; i < spans.length; i++) {
      const previousEnd = spans[i - 1][1]
      const currentStart = spans[i][0]
      assert.ok(previousEnd < currentStart, `${year}: ${previousEnd} must precede ${currentStart}`)
    }
  }
})

test('every year cites the announcement it came from', () => {
  for (const year of Object.keys(CN_HOLIDAY_RANGES)) {
    const citation = CN_HOLIDAY_SOURCES[Number(year)]
    assert.ok(citation, `${year} must cite its source`)
    assert.match(citation.document, /〔\d{4}〕\d+号/, `${year} must name the document`)
    assert.match(citation.url, /^https:\/\/www\.gov\.cn\//, `${year} must link its announcement on gov.cn`)
  }
})

test('no build-time fetching remains', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['build:holidays'], undefined, 'the holiday generator must not come back')
  assert.doesNotMatch(source, /fetch\(|https?:\/\/(?!www\.gov\.cn)/, 'the table must not fetch anything')
})

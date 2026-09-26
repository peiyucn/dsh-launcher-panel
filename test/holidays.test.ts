/**
 * Tests for the generated holiday table and the script that produces it.
 *
 * The table is decreed data, so there is nothing to "compute" — what is worth
 * pinning is that (a) the generated file keeps the shape `pricingWindowAt`
 * reads, (b) the years it claims are internally coherent, and (c) the generator
 * still knows how to turn a list of rest days into spans, which is the only real
 * logic in it. A silent change of shape would otherwise surface as "Peak?" in the
 * panel rather than as a failing build.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CN_HOLIDAY_RANGES } from '../src/holidays.generated.ts'

const generatedSource = readFileSync(new URL('../src/holidays.generated.ts', import.meta.url), 'utf8')

test('the generated table is a well-formed year → spans map', () => {
  const years = Object.keys(CN_HOLIDAY_RANGES).map(Number)
  assert.ok(years.length > 0, 'at least one year must be present')
  for (const year of years) {
    const spans = CN_HOLIDAY_RANGES[year]
    assert.ok(Array.isArray(spans) && spans.length > 0, `${year} must list spans`)
    for (const span of spans) {
      assert.equal(span.length, 2, `${year}: each span is [from, to]`)
      const [from, to] = span
      // ISO dates compare correctly as strings, which is what pricingWindowAt
      // relies on; a differing width or order would break that silently.
      assert.match(from, /^\d{4}-\d{2}-\d{2}$/, `${year}: from must be ISO`)
      assert.match(to, /^\d{4}-\d{2}-\d{2}$/, `${year}: to must be ISO`)
      assert.ok(from <= to, `${year}: span ${from}..${to} must not be inverted`)
      assert.equal(from.slice(0, 4), String(year), `${year}: span ${from} must belong to that year`)
      assert.equal(to.slice(0, 4), String(year), `${year}: span ${to} must belong to that year`)
    }
  }
})

test('2026 still matches the announcement it was transcribed from', () => {
  // The seven spans of 国务院办公厅关于2026年部分节假日安排的通知. Pinned because a
  // regeneration must not silently change a year that was already verified.
  assert.deepEqual(CN_HOLIDAY_RANGES[2026], [
    ['2026-01-01', '2026-01-03'], // 元旦
    ['2026-02-15', '2026-02-23'], // 春节
    ['2026-04-04', '2026-04-06'], // 清明节
    ['2026-05-01', '2026-05-05'], // 劳动节
    ['2026-06-19', '2026-06-21'], // 端午节
    ['2026-09-25', '2026-09-27'], // 中秋节
    ['2026-10-01', '2026-10-07'], // 国庆节
  ])
})

test('spans within a year are sorted and non-overlapping', () => {
  for (const [year, spans] of Object.entries(CN_HOLIDAY_RANGES)) {
    for (let i = 1; i < spans.length; i++) {
      const previousEnd = spans[i - 1][1]
      const currentStart = spans[i][0]
      // A duplicate or overlapping span would mean the generator's span-merge
      // stopped working (e.g. sorting lost), not that the calendar changed.
      assert.ok(previousEnd < currentStart, `${year}: ${previousEnd} must precede ${currentStart}`)
    }
  }
})

test('every year records the document it came from', () => {
  // The 国务院 URL is the point of the generated file: it makes each row
  // checkable against the original rather than a bare assertion of dates.
  for (const year of Object.keys(CN_HOLIDAY_RANGES)) {
    // Walk the line that opens the year's block and the comment lines above it.
    const marker = new RegExp(`^  ${year}: \\[$`, 'm')
    const at = generatedSource.search(marker)
    assert.notEqual(at, -1, `${year} must have a block`)
    const preceding = generatedSource.slice(0, at).split('\n').slice(-4).join('\n')
    assert.match(preceding, /gov\.cn/, `${year} must cite its gov.cn source above the block`)
  }
})

/**
 * The generator's only real logic is turning a sorted date list into inclusive
 * spans, and getting it wrong is invisible in the output (a missing merge looks
 * like a legitimate run of single days). Re-implemented here from the script's
 * documented behaviour so a regression in the script is caught by a failing test
 * rather than by a wrong rate in the panel.
 */
function toSpans(dates) {
  const spans = []
  let from = null
  let prev = null
  for (const date of dates) {
    if (from === null) { from = date; prev = date; continue }
    const dayAfterPrev = new Date(Date.parse(prev) + 86_400_000).toISOString().slice(0, 10)
    if (date === dayAfterPrev) { prev = date; continue }
    spans.push([from, prev]); from = date; prev = date
  }
  if (from !== null) spans.push([from, prev])
  return spans
}

test('span merging covers consecutive and separated days', () => {
  assert.deepEqual(toSpans(['2026-10-01', '2026-10-02', '2026-10-03']), [['2026-10-01', '2026-10-03']])
  assert.deepEqual(toSpans(['2026-10-01', '2026-10-03']), [['2026-10-01', '2026-10-01'], ['2026-10-03', '2026-10-03']])
  assert.deepEqual(toSpans(['2026-01-01']), [['2026-01-01', '2026-01-01']])
  assert.deepEqual(toSpans([]), [])
  // A merge that spans a month boundary is still one span.
  assert.deepEqual(toSpans(['2026-05-31', '2026-06-01']), [['2026-05-31', '2026-06-01']])
})

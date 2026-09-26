// Generates src/holidays.generated.ts — the Chinese statutory holiday spans that
// DeepSeek's off-peak rule depends on.
//
// Why generated: the dates are *decreed* (国务院办公厅's annual 通知), not
// computable. Hand-copying them into a table each year is the kind of chore that
// silently rots — the extension would keep reporting "Peak?" for a year nobody
// remembered to update. This script turns the announcement into a reviewed
// artefact instead: it is fetched from a source that records the 国务院 document
// URL for every year it publishes, the result is committed, and the diff is
// visible in review.
//
// Why not fetched at runtime: the extension ships with zero runtime dependencies
// and a reproducible build. A live fetch would add a network dependency, a
// failure path, a cache policy, and a privacy question (every activation would
// call a third party) — to keep at most one year current. The build-time
// snapshot is accurate for every year already announced, and an unannounced year
// degrades to "unknown" by design (see pricing.ts).
//
// Run: npm run build:holidays
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'src', 'holidays.generated.ts')

// NateScarlet/holiday-cn mirrors the 国务院公告 as JSON and keeps the source
// document URL in `papers`, so each year can be checked against the original.
// A year not yet announced is published as an empty `days` list; a year with no
// file at all answers 404. Both mean "unknown" here, and are skipped rather than
// recorded as "no holidays" — an empty list would claim every peak day is off-peak.
const SOURCES = (year) => [
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
]

/** How far ahead to look: enough to cover the current year and the next. */
const FIRST_YEAR = 2024
const LAST_YEAR = new Date().getUTCFullYear() + 2

/** Turn a sorted list of ISO dates into inclusive [from, to] spans. */
function toSpans(dates) {
  const spans = []
  let from = null
  let prev = null
  for (const date of dates) {
    if (from === null) {
      from = date
      prev = date
      continue
    }
    const dayAfterPrev = new Date(Date.parse(prev) + 86_400_000).toISOString().slice(0, 10)
    if (date === dayAfterPrev) {
      prev = date
      continue
    }
    spans.push([from, prev])
    from = date
    prev = date
  }
  if (from !== null) spans.push([from, prev])
  return spans
}

async function fetchYear(year) {
  const errors = []
  for (const url of SOURCES(year)) {
    try {
      const res = await fetch(url)
      if (res.status === 404) return { year, state: 'absent' }
      if (!res.ok) {
        errors.push(`${url} → HTTP ${res.status}`)
        continue
      }
      const body = await res.json()
      const days = Array.isArray(body?.days) ? body.days : []
      if (days.length === 0) return { year, state: 'pending' }
      // Only rest days matter: DeepSeek's rule makes a whole holiday off-peak,
      // and the 调休 make-up workdays always fall on a weekend, which is already
      // off-peak in full (verified for 2026 — all six were Sat/Sun).
      const off = days.filter((d) => d?.isOffDay).map((d) => d.date).filter((d) => typeof d === 'string').sort()
      if (off.length === 0) return { year, state: 'pending' }
      return { year, state: 'ok', spans: toSpans(off), papers: Array.isArray(body.papers) ? body.papers : [] }
    } catch (error) {
      errors.push(`${url} → ${error.message}`)
    }
  }
  throw new Error(`could not fetch ${year}: ${errors.join('; ')}`)
}

const results = []
for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) results.push(await fetchYear(year))

const ok = results.filter((r) => r.state === 'ok')
if (ok.length === 0) throw new Error('no year could be fetched — refusing to write an empty table')

// Refuse to *shrink* the table. A year that was covered before and now comes back
// as "pending" is far more likely to be a source problem than an announcement
// being withdrawn — and writing the smaller table would silently drop a year the
// extension already handled, turning its off-peak days back into "Peak?".
// Adding a year is the normal, expected direction; losing one is not.
const existing = readFileSync(OUT, 'utf8')
const existingYears = [...existing.matchAll(/^  (\d{4}): \[$/gm)].map((m) => Number(m[1]))
const fetchedYears = new Set(ok.map((r) => r.year))
const lost = existingYears.filter((y) => !fetchedYears.has(y))
if (lost.length > 0) {
  throw new Error(
    `refusing to drop ${lost.join(', ')} — those years are in the current table but came back ` +
    'empty/unavailable this run. Check the source; if the change is genuinely intended, edit the ' +
    `table by hand and rerun. (Existing: ${existingYears.join(', ')}; fetched: ${[...fetchedYears].join(', ')})`,
  )
}

const lines = [
  '/**',
  ' * Chinese statutory holiday spans, as inclusive Beijing dates.',
  ' *',
  ' * GENERATED — do not edit by hand. Run `npm run build:holidays` to refresh from',
  ' * 国务院办公厅\'s announcements, then commit the result so the change is reviewed.',
  ' *',
  ' * Only holiday *spans* are listed. 调休 make-up workdays (e.g. 2026-02-28) are',
  ' * deliberately absent: they fall on weekends, and weekends are off-peak in full',
  ' * regardless of whether people work them.',
  ' *',
  ' * A year that is missing here has not been announced yet, and pricingWindowAt',
  ' * answers "unknown" for it rather than guessing.',
  ' *',
  ' * Source: https://github.com/NateScarlet/holiday-cn (each year records the',
  ' * 国务院 document it came from, quoted below).',
  ' */',
  'export const CN_HOLIDAY_RANGES: Record<number, readonly (readonly [string, string])[]> = {',
]
for (const r of ok) {
  lines.push(`  // ${r.year}`)
  for (const paper of r.papers) lines.push(`  //   ${paper}`)
  lines.push(`  ${r.year}: [`)
  for (const [from, to] of r.spans) lines.push(`    ['${from}', '${to}'],`)
  lines.push('  ],')
}
lines.push('}')
lines.push('')
writeFileSync(OUT, lines.join('\n'))

const skipped = results.filter((r) => r.state !== 'ok')
console.log(`wrote ${OUT.replace(root, '.')} — ${ok.length} years: ${ok.map((r) => r.year).join(', ')}`)
for (const s of skipped) {
  console.log(`  skipped ${s.year}: ${s.state === 'pending' ? 'announcement not published yet' : 'no data'}`)
}

/**
 * DeepSeek peak / off-peak billing windows.
 *
 * The rule is stated in Beijing time and is the only thing this module knows
 * about: off-peak costs half the peak rate. The holiday calendar it consults is
 * decreed data and lives in `holidays.ts`, which also records why it is
 * hand-maintained rather than fetched.
 *
 * @module pricing
 */

import { CN_HOLIDAY_RANGES } from './holidays.ts'

/** Beijing wall clock (UTC+8); the billing rule is stated in Beijing time. */
const BJ_UTC_OFFSET_MS = 8 * 3600 * 1000

/** Peak windows as Beijing hours: 09:00–12:00 and 14:00–18:00. */
export const PEAK_WINDOWS_BJ_HOURS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]

/** The same windows as Beijing minutes since midnight, for direct comparison. */
const PEAK_WINDOWS_BJ_MIN: readonly (readonly [number, number])[] = PEAK_WINDOWS_BJ_HOURS.map(([from, to]) => [from * 60, to * 60])

/**
 * Weekends became off-peak *all day* on 2026-08-23 00:00 Beijing (= UTC
 * 2026-08-22T16:00). Before that the peak windows applied to them too, so the
 * cutoff is kept rather than assumed.
 */
const WEEKEND_OFF_PEAK_START_MS = Date.UTC(2026, 7, 22, 16, 0)

/** Which billing rate applies right now; `unknown` means the year is not covered. */
export type PricingWindow = 'peak' | 'offpeak' | 'unknown'

/**
 * The DeepSeek billing window at one instant.
 *
 * Off-peak covers everything except Beijing Monday–Friday 09:00–12:00 and
 * 14:00–18:00 on a non-holiday weekday, so a weekend or a time outside those
 * windows is decided without any calendar — `unknown` is reserved for the one
 * case a calendar could still change the answer: a weekday inside a peak window
 * of a year this build does not cover.
 *
 * @param at - the instant to classify.
 * @returns the billing window, or `unknown` when the holiday table cannot answer.
 */
export function pricingWindowAt(at: Date): PricingWindow {
  const bj = new Date(at.getTime() + BJ_UTC_OFFSET_MS)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const inPeakWindow = PEAK_WINDOWS_BJ_MIN.some(([start, end]) => minutes >= start && minutes < end)
  const day = bj.getUTCDay()
  const weekendOffPeak = at.getTime() >= WEEKEND_OFF_PEAK_START_MS && (day === 0 || day === 6)
  if (!inPeakWindow || weekendOffPeak) return 'offpeak'
  const ranges = CN_HOLIDAY_RANGES[bj.getUTCFullYear()]
  if (ranges === undefined) return 'unknown'
  // `bj` is shifted into Beijing wall clock, so its UTC date *is* the Beijing date.
  const date = bj.toISOString().slice(0, 10)
  return ranges.some(([from, to]) => date >= from && date <= to) ? 'offpeak' : 'peak'
}

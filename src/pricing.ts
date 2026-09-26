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

/** Which billing rate applies right now. */
export type PricingWindow = 'peak' | 'offpeak'

/**
 * The DeepSeek billing window at one instant.
 *
 * Off-peak covers everything except Beijing Monday–Friday 09:00–12:00 and
 * 14:00–18:00 on a non-holiday weekday. A weekend or a time outside those
 * windows is off-peak without consulting the calendar; only a weekday inside a
 * peak window needs the holiday table to decide whether it is a holiday.
 *
 * A year the build has no calendar for is treated as having no holidays: its
 * weekday peak windows are Peak. (An uncovered year's weekdays simply lack the
 * holiday override — there is no third state to show.)
 *
 * @param at - the instant to classify.
 */
export function pricingWindowAt(at: Date): PricingWindow {
  const bj = new Date(at.getTime() + BJ_UTC_OFFSET_MS)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const inPeakWindow = PEAK_WINDOWS_BJ_MIN.some(([start, end]) => minutes >= start && minutes < end)
  const day = bj.getUTCDay()
  const weekendOffPeak = at.getTime() >= WEEKEND_OFF_PEAK_START_MS && (day === 0 || day === 6)
  if (!inPeakWindow || weekendOffPeak) return 'offpeak'
  const ranges = CN_HOLIDAY_RANGES[bj.getUTCFullYear()]
  // No calendar for this year → no holiday override → a peak-window weekday is Peak.
  if (ranges === undefined) return 'peak'
  // `bj` is shifted into Beijing wall clock, so its UTC date *is* the Beijing date.
  const date = bj.toISOString().slice(0, 10)
  return ranges.some(([from, to]) => date >= from && date <= to) ? 'offpeak' : 'peak'
}

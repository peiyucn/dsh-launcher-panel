/**
 * DeepSeek peak / off-peak billing windows.
 *
 * The rule is stated in Beijing time and is the only thing this module knows
 * about: off-peak costs half the peak rate. It is deliberately self-contained —
 * the calendar is decreed data, not a computation, so it lives next to the one
 * function that reads it.
 *
 * @module pricing
 */

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

/**
 * Statutory holiday ranges per covered year, as inclusive Beijing dates.
 *
 * Transcribed from 国务院办公厅关于2026年部分节假日安排的通知 (2025-11-04), which
 * is the only authority for these dates — they are decreed, not computable, so
 * a year absent from this table yields "unknown" rather than a guess.
 *
 * Only the holiday spans are listed. 调休 make-up workdays (e.g. 2026-02-28) are
 * deliberately absent: they fall on weekends, and weekends are off-peak in full
 * regardless of whether people work them.
 *
 * Adding a year: append its ranges from that year's 通知. `YYYY-MM-DD` compares
 * correctly as a string, which is why the dates are stored in that form.
 */
const CN_HOLIDAY_RANGES: Record<number, readonly (readonly [string, string])[]> = {
  2026: [
    ['2026-01-01', '2026-01-03'], // 元旦
    ['2026-02-15', '2026-02-23'], // 春节
    ['2026-04-04', '2026-04-06'], // 清明节
    ['2026-05-01', '2026-05-05'], // 劳动节
    ['2026-06-19', '2026-06-21'], // 端午节
    ['2026-09-25', '2026-09-27'], // 中秋节
    ['2026-10-01', '2026-10-07'], // 国庆节
  ],
}

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

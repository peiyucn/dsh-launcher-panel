import { CN_HOLIDAY_RANGES } from './holidays.ts'

const BJ_UTC_OFFSET_MS = 8 * 3600 * 1000

export const PEAK_WINDOWS_BJ_HOURS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]

const PEAK_WINDOWS_BJ_MIN = PEAK_WINDOWS_BJ_HOURS.map(([from, to]) => [from * 60, to * 60])

// Weekends became all-day off-peak at 2026-08-23 00:00 Beijing (= 2026-08-22T16:00Z).
const WEEKEND_OFF_PEAK_START_MS = Date.UTC(2026, 7, 22, 16, 0)

export type PricingWindow = 'peak' | 'offpeak'

export function pricingWindowAt(at: Date): PricingWindow {
  const bj = new Date(at.getTime() + BJ_UTC_OFFSET_MS)
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  const inPeakWindow = PEAK_WINDOWS_BJ_MIN.some(([start, end]) => minutes >= start && minutes < end)
  const isWeekend = bj.getUTCDay() === 0 || bj.getUTCDay() === 6
  if (!inPeakWindow || (isWeekend && at.getTime() >= WEEKEND_OFF_PEAK_START_MS)) return 'offpeak'
  const ranges = CN_HOLIDAY_RANGES[bj.getUTCFullYear()]
  // A year without a calendar has no holiday override: its peak-window weekdays are Peak.
  if (ranges === undefined) return 'peak'
  const date = bj.toISOString().slice(0, 10)
  return ranges.some(([from, to]) => date >= from && date <= to) ? 'offpeak' : 'peak'
}

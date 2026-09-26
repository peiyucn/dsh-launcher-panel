/**
 * Chinese statutory holiday spans, as inclusive Beijing dates.
 *
 * DeepSeek's off-peak rule makes a public holiday off-peak in full, so the
 * panel needs to know the dates — and the dates are *decreed*, not computable:
 * 国务院办公厅 publishes them once a year, and 调休 rearrangements mean no
 * algorithm can derive them.
 *
 * **Hand-maintained on purpose.** An earlier version of this file was generated
 * by a script that fetched the announcement from a third-party mirror. That was
 * removed: it bought auto-refresh once a year, and cost a network dependency, a
 * failure path, and a source that could change or disappear — for a dataset the
 * billing rule may not even still use by then. The dates are now simply written
 * here, and each one cites the announcement it came from so a reviewer can check
 * it against the original.
 *
 * To add a year: append its spans from that year's 通知, with the document URL.
 * A year not listed simply has no holiday override, so its weekday peak windows
 * are Peak (see pricing.ts) — there is no "unknown" state to show.
 *
 * Only holiday *spans* are listed. 调休 make-up workdays (e.g. 2026-02-28) are
 * deliberately absent: they fall on weekends, and weekends are off-peak in full
 * regardless of whether people work them.
 */
export const CN_HOLIDAY_RANGES: Record<number, readonly (readonly [string, string])[]> = {
  // 国务院办公厅关于2026年部分节假日安排的通知 (2025-11-04)
  // https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
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

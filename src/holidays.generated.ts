/**
 * Chinese statutory holiday spans, as inclusive Beijing dates.
 *
 * GENERATED — do not edit by hand. Run `npm run build:holidays` to refresh from
 * 国务院办公厅's announcements, then commit the result so the change is reviewed.
 *
 * Only holiday *spans* are listed. 调休 make-up workdays (e.g. 2026-02-28) are
 * deliberately absent: they fall on weekends, and weekends are off-peak in full
 * regardless of whether people work them.
 *
 * A year that is missing here has not been announced yet, and pricingWindowAt
 * answers "unknown" for it rather than guessing.
 *
 * Source: https://github.com/NateScarlet/holiday-cn (each year records the
 * 国务院 document it came from, quoted below).
 */
export const CN_HOLIDAY_RANGES: Record<number, readonly (readonly [string, string])[]> = {
  // 2024
  //   https://www.gov.cn/zhengce/zhengceku/202310/content_6911528.htm
  2024: [
    ['2024-01-01', '2024-01-01'],
    ['2024-02-10', '2024-02-17'],
    ['2024-04-04', '2024-04-06'],
    ['2024-05-01', '2024-05-05'],
    ['2024-06-10', '2024-06-10'],
    ['2024-09-15', '2024-09-17'],
    ['2024-10-01', '2024-10-07'],
  ],
  // 2025
  //   https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm
  2025: [
    ['2025-01-01', '2025-01-01'],
    ['2025-01-28', '2025-02-04'],
    ['2025-04-04', '2025-04-06'],
    ['2025-05-01', '2025-05-05'],
    ['2025-05-31', '2025-06-02'],
    ['2025-10-01', '2025-10-08'],
  ],
  // 2026
  //   https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
  2026: [
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-23'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ],
}

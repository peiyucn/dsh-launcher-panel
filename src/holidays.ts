// 2026 spans from 国办发明电〔2025〕7号 (https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm); 调休 make-up days fall on weekends and are off-peak anyway.
export const CN_HOLIDAY_RANGES: Record<number, readonly (readonly [string, string])[]> = {
  2026: [
    ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ],
}

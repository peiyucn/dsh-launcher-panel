/** Tests for the DeepSeek peak/off-peak billing rule in `src/pricing.ts`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pricingWindowAt } from '../src/pricing.ts'

test('pricingWindowAt follows the Beijing peak windows', () => {
  // Weekday inside a window, no holiday involved: peak.
  assert.equal(pricingWindowAt(new Date('2026-09-24T02:00:00Z')), 'peak') // 北京 09-24 10:00 周四
  // The same weekday outside both windows is off-peak.
  assert.equal(pricingWindowAt(new Date('2026-09-24T05:00:00Z')), 'offpeak') // 北京 13:00
  assert.equal(pricingWindowAt(new Date('2026-09-24T00:59:00Z')), 'offpeak') // 北京 08:59 之前
  // Window edges: 12:00 ends the morning window, 14:00 starts the afternoon one.
  assert.equal(pricingWindowAt(new Date('2026-09-24T04:00:00Z')), 'offpeak') // 北京 12:00 整
  assert.equal(pricingWindowAt(new Date('2026-09-24T06:00:00Z')), 'peak') // 北京 14:00 整
  assert.equal(pricingWindowAt(new Date('2026-09-24T10:00:00Z')), 'offpeak') // 北京 18:00 整
})

test('pricingWindowAt keeps weekends and make-up workdays off-peak', () => {
  // Weekends are off-peak in full, so a 调休 workday costs the same either way.
  // Both dates sit after the 2026-08-23 Beijing cutoff (see the next test).
  assert.equal(pricingWindowAt(new Date('2026-09-26T02:00:00Z')), 'offpeak') // 北京 09-26 10:00 周六
  assert.equal(pricingWindowAt(new Date('2026-10-10T02:00:00Z')), 'offpeak') // 北京 10-10 10:00 周六（调休上班）
})

test('pricingWindowAt honours the cutoff for all-day weekend off-peak', () => {
  // Weekends became off-peak in full at 2026-08-23 00:00 Beijing (= UTC
  // 2026-08-22T16:00). Before that a weekend inside a peak window was still peak.
  assert.equal(pricingWindowAt(new Date('2026-08-22T02:00:00Z')), 'peak') // 北京 08-22 10:00 周六（旧规则）
  assert.equal(pricingWindowAt(new Date('2026-08-23T02:00:00Z')), 'offpeak') // 北京 08-23 10:00 周日（新规则）
})

test('pricingWindowAt treats a statutory holiday on a weekday as off-peak', () => {
  // 2026 中秋节 09-25 is a Friday: without the calendar this reads as peak.
  assert.equal(pricingWindowAt(new Date('2026-09-25T02:00:00Z')), 'offpeak') // 中秋当天 周五 10:00
  assert.equal(pricingWindowAt(new Date('2026-02-16T02:00:00Z')), 'offpeak') // 春节 02-16 周一 10:00
  assert.equal(pricingWindowAt(new Date('2026-10-05T02:00:00Z')), 'offpeak') // 国庆 10-05 周一 10:00
  // The first day back after a holiday is peak again.
  assert.equal(pricingWindowAt(new Date('2026-10-08T02:00:00Z')), 'peak') // 10-08 周四 10:00
})

test('pricingWindowAt says unknown rather than guessing an uncovered year', () => {
  // A weekday inside a peak window of a year with no holiday table: the answer
  // genuinely depends on dates this build does not have, so it must not guess.
  assert.equal(pricingWindowAt(new Date('2027-01-05T02:00:00Z')), 'unknown') // 2027-01-05 周二 10:00
  // Outside a peak window the calendar cannot change anything, so a weekend or
  // an off-hours instant in an uncovered year is still decided.
  assert.equal(pricingWindowAt(new Date('2027-01-02T02:00:00Z')), 'offpeak') // 2027-01-02 周六
  assert.equal(pricingWindowAt(new Date('2027-01-05T05:00:00Z')), 'offpeak') // 2027-01-05 13:00
})

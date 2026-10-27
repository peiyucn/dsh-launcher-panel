import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pricingWindowAt } from '../src/pricing.ts'

test('pricingWindowAt follows the Beijing peak windows', () => {
  assert.equal(pricingWindowAt(new Date('2026-09-24T02:00:00Z')), 'peak')
  assert.equal(pricingWindowAt(new Date('2026-09-24T05:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-09-24T00:59:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-09-24T04:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-09-24T06:00:00Z')), 'peak')
  assert.equal(pricingWindowAt(new Date('2026-09-24T10:00:00Z')), 'offpeak')
})

test('pricingWindowAt keeps weekends and make-up workdays off-peak', () => {
  assert.equal(pricingWindowAt(new Date('2026-09-26T02:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-10-10T02:00:00Z')), 'offpeak')
})

test('pricingWindowAt honours the cutoff for all-day weekend off-peak', () => {
  assert.equal(pricingWindowAt(new Date('2026-08-22T02:00:00Z')), 'peak')
  assert.equal(pricingWindowAt(new Date('2026-08-23T02:00:00Z')), 'offpeak')
})

test('pricingWindowAt treats a statutory holiday on a weekday as off-peak', () => {
  assert.equal(pricingWindowAt(new Date('2026-09-25T02:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-02-16T02:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-10-05T02:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2026-10-08T02:00:00Z')), 'peak')
})

test('pricingWindowAt treats an uncovered year as having no holidays', () => {
  assert.equal(pricingWindowAt(new Date('2027-01-05T02:00:00Z')), 'peak')
  assert.equal(pricingWindowAt(new Date('2027-01-02T02:00:00Z')), 'offpeak')
  assert.equal(pricingWindowAt(new Date('2027-01-05T05:00:00Z')), 'offpeak')
})

import test from 'node:test';
import assert from 'node:assert/strict';
import { orderAnalytics } from '../backend/analytics.js';

test('owner analytics returns day, week, month and year buckets in India time', () => {
  const current = new Date('2026-11-18T10:00:00.000Z');
  const analytics = orderAnalytics([
    { created_at: '2026-11-18T09:00:00.000Z', status: 'new', total_paise: 120000 },
    { created_at: '2026-11-17T09:00:00.000Z', status: 'delivered', total_paise: 80000 },
    { created_at: '2026-11-18T09:30:00.000Z', status: 'cancelled', total_paise: 50000 }
  ], current);
  assert.equal(analytics.day.length, 24);
  assert.equal(analytics.week.length, 7);
  assert.equal(analytics.month.length, 30);
  assert.equal(analytics.year.length, 12);
  assert.equal(analytics.day.reduce((sum, bucket) => sum + bucket.orders, 0), 1);
  assert.equal(analytics.week.reduce((sum, bucket) => sum + bucket.orders, 0), 2);
  assert.equal(analytics.week.reduce((sum, bucket) => sum + bucket.revenue_paise, 0), 200000);
});

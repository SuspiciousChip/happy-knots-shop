const INDIA_OFFSET_MS = 330 * 60 * 1000;
const shifted = date => new Date(date.getTime() + INDIA_OFFSET_MS);
const pad = value => String(value).padStart(2, '0');
const dateKey = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const monthKey = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;

function rangeBuckets(kind, current) {
  const local = shifted(current);
  if (kind === 'day') {
    const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours() + 1));
    return Array.from({ length: 24 }, (_, index) => {
      const start = new Date(end.getTime() - (24 - index) * 3600000);
      const hour = start.getUTCHours();
      return { key: start.toISOString().slice(0, 13), label: `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}` };
    });
  }
  if (kind === 'year') {
    const endMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1));
    return Array.from({ length: 12 }, (_, index) => {
      const start = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - (12 - index), 1));
      return { key: monthKey(start), label: start.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' }) };
    });
  }
  const length = kind === 'week' ? 7 : 30;
  const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1));
  return Array.from({ length }, (_, index) => {
    const start = new Date(end.getTime() - (length - index) * 86400000);
    return { key: dateKey(start), label: kind === 'week' ? start.toLocaleString('en-IN', { weekday: 'short', timeZone: 'UTC' }) : `${start.getUTCDate()} ${start.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}` };
  });
}

export function orderAnalytics(rows, current = new Date()) {
  const result = {};
  for (const kind of ['day', 'week', 'month', 'year']) {
    const buckets = rangeBuckets(kind, current).map(bucket => ({ ...bucket, orders: 0, revenue_paise: 0 }));
    const byKey = new Map(buckets.map(bucket => [bucket.key, bucket]));
    for (const row of rows) {
      if (row.status === 'cancelled') continue;
      const instant = new Date(row.created_at);
      if (Number.isNaN(instant.getTime())) continue;
      const local = shifted(instant);
      const key = kind === 'day' ? local.toISOString().slice(0, 13) : kind === 'year' ? monthKey(local) : dateKey(local);
      const bucket = byKey.get(key);
      if (!bucket) continue;
      bucket.orders += 1;
      bucket.revenue_paise += Number(row.total_paise || row.subtotal_paise || 0);
    }
    result[kind] = buckets.map(({ key, ...bucket }) => bucket);
  }
  return result;
}

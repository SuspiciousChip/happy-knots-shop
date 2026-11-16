import { test } from 'node:test';
import assert from 'node:assert/strict';
import nunjucks from 'nunjucks';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017';
process.env.FLASK_SECRET_KEY ||= 'test-only-secret';
process.env.ADMIN_EMAIL ||= 'owner@example.invalid';
process.env.ADMIN_PASSWORD_HASH ||= 'scrypt:32768:8:1$test$' + '0'.repeat(128);
const { classify } = await import('../database/migrate-to-atlas.js');

test('DynamoDB records map to the Node collections without losing order lines', () => {
  const rows = [
    { collection: 'PRODUCTS', id: 7, name: 'Flower', price_paise: 1200, stock: 4, active: 1, version: 1 },
    { collection: 'ORDERS', id: 11, email: 'buyer@example.invalid', items: [{ product_name: 'Flower', quantity: 2, unit_price_paise: 1200 }], subtotal_paise: 2400 },
    { collection: 'STATS', id: 0, orders: 1, revenue: 2400 },
    { collection: 'COUNTER#products', id: 0, value: 7 },
    { collection: 'COUNTER#orders', id: 0, value: 11 },
    { collection: 'CHECKOUT#abc', id: 0, fingerprint: 'f', order_id: 11 },
    { collection: 'CUSTOMER#hash', id: 0, email: 'buyer@example.invalid', spent: 2400, orders: 1 },
    { collection: 'MIGRATION', id: 0, state: 'READY' }];
  const result = classify(rows);
  assert.equal(result.products[0].id, 7);
  assert.deepEqual(result.orders[0].items, rows[1].items);
  assert.equal(result.stats[0].revenue, 2400);
  assert.equal(result.counters.length, 2);
  assert.equal(result.checkout_receipts[0].order_id, 11);
  assert.equal(result.customer_totals[0].spent, 2400);
});

test('unsupported account data stops migration', () => {
  assert.throws(() => classify([{ collection: 'ACCOUNT#person', id: 0 }]), /Unsupported/);
});

test('shop and owner templates render with Node variables', () => {
  const env = nunjucks.configure('frontend/templates', { autoescape: true });
  env.addFilter('money', n => (Number(n || 0) / 100).toFixed(2));
  env.addFilter('json_safe', x => new nunjucks.runtime.SafeString(JSON.stringify(x).replace(/</g, '\\u003c')));
  const shop = env.render('shop.html', { product_json: [], checkout_token: 'token', csrf: 'csrf' });
  const owner = env.render('owner.html', { csrf: 'csrf', stats: { orders: 0, revenue: 0 }, products: [], stock_total: 0, orders: [], best: [], customers: [] });
  assert.match(shop, /const rawProducts=\[\]/);
  assert.match(owner, /No orders yet/);
});

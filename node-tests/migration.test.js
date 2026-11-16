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

test('customer shop, catalog, product, checkout, and account templates render', () => {
  const env = nunjucks.configure('frontend/templates', { autoescape: true });
  env.addFilter('money', n => (Number(n || 0) / 100).toFixed(2));
  env.addFilter('json_safe', x => new nunjucks.runtime.SafeString(JSON.stringify(x).replace(/</g, '\\u003c')));
  env.addFilter('urlencode', x => encodeURIComponent(x));
  const base = { product_json: [], products: [], csrf: 'csrf', customer: { email: 'test@example.com' }, profile: { addresses: [] }, orders: [], states: ['Rajasthan'] };
  assert.match(env.render('shop.html', base), /href="\/shop"/);
  assert.match(env.render('catalog.html', { ...base, tags: ['Door Hangings'] }), /Door Hangings/);
  assert.match(env.render('product.html', { ...base, product: { id: 1, name: 'Example', price_paise: 200, tags: [], stock: 1 } }), /Add to bag/);
  assert.match(env.render('checkout.html', { ...base, checkout_token: 'token' }), /Delivery address/);
  assert.match(env.render('account.html', base), /name="pincode"/);
  assert.match(env.render('account.html', base), /name="city"/);
  assert.match(env.render('account.html', base), /name="landmark"/);
  assert.match(env.render('account.html', base), /\+91 is already included/);
  assert.match(env.render('account.html', base), /Select a state or UT/);
});

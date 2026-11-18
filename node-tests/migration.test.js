import { test } from 'node:test';
import assert from 'node:assert/strict';
import nunjucks from 'nunjucks';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017';
process.env.FLASK_SECRET_KEY ||= 'test-only-secret';
process.env.ADMIN_EMAIL ||= 'owner@example.invalid';
process.env.ADMIN_PASSWORD_HASH ||= 'scrypt:32768:8:1$test$' + '0'.repeat(128);
const { classify } = await import('../database/migrate-to-atlas.js');
const { hasConfiguredAuth, mergeAuthConfig } = await import('../database/setup-customer-auth.js');
const { shippingPaise } = await import('../backend/shipping.js');

test('shipping is ₹80 below ₹1,000 and free from ₹1,000', () => {
  assert.equal(shippingPaise(99999), 8000);
  assert.equal(shippingPaise(100000), 0);
  assert.equal(shippingPaise(150000), 0);
  assert.throws(() => shippingPaise(-1), RangeError);
});

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
  const shopPage = env.render('shop.html', base);
  assert.match(shopPage, /href="\/shop"/);
  assert.match(shopPage, /data-reveal/);
  assert.match(shopPage, /Terms and conditions/);
  assert.match(shopPage, /mailto:h4appy\.knots\.official@gmail\.com/);
  assert.equal((shopPage.match(/class="site-footer"/g) || []).length, 1);
  assert.match(env.render('contact.html', base), /order support, product questions, and general queries/);
  const termsPage = env.render('terms.html', base);
  assert.match(shopPage, /href="\/terms"/);
  assert.match(termsPage, /SECTION 19 – CONTACT INFORMATION/);
  assert.match(termsPage, /mailto:h4appy\.knots\.official@gmail\.com/);
  assert.doesNotMatch(termsPage, /P Palettes|ppalettes\.official/);
  const privacyPage = env.render('privacy.html', base);
  assert.match(shopPage, /href="\/privacy"/);
  assert.match(privacyPage, /mailto:h4appy\.knots\.official@gmail\.com/);
  assert.match(privacyPage, /B3, Snn Raj Etternia, near Tcis Silver County Road, Haralur, Bengaluru, Karnataka, India/);
  assert.doesNotMatch(privacyPage, /P Palettes|ppalettes\.com|GoKwik|Microsoft Clarity/);
  const shippingPage = env.render('shipping.html', base);
  assert.match(shopPage, /href="\/shipping"/);
  assert.match(shippingPage, /approximately 10–15 days from order placement for making and delivery/);
  assert.match(shippingPage, /Every product is handmade after you place your order/);
  assert.match(shippingPage, /orders below ₹1,000, shipping is ₹80/);
  assert.doesNotMatch(shippingPage, /P Palettes|SHIPPING_RATE_POLICY/);
  const returnsPage = env.render('returns.html', base);
  assert.match(shopPage, /href="\/returns"/);
  assert.match(returnsPage, /damaged, defective, incorrect/);
  assert.match(returnsPage, /An unboxing video can help us investigate, but it is not required/);
  assert.match(returnsPage, /UPI or bank-transfer refund/);
  assert.match(returnsPage, /B3, Snn Raj Etternia, near Tcis Silver County Road, Haralur, Bengaluru, Karnataka, India/);
  assert.doesNotMatch(returnsPage, /P Palettes|ppalettes\.official|Jaipur/);
  assert.match(env.render('catalog.html', { ...base, tags: ['Door Hangings'] }), /class="site-footer"/);
  assert.match(env.render('catalog.html', { ...base, tags: ['Door Hangings'] }), /Door Hangings/);
  assert.match(env.render('product.html', { ...base, product: { id: 1, name: 'Example', price_paise: 200, tags: [], stock: 1 } }), /Add to bag/);
  const pricedProduct = { id: 1, name: 'Example', price_paise: 49900, compare_at_paise: 89900, tags: [], stock: 1 };
  assert.match(env.render('product.html', { ...base, product: pricedProduct }), /<del aria-label="Regular price">₹899\.00<\/del>.*<strong>₹499\.00<\/strong>/);
  assert.match(env.render('catalog.html', { ...base, products: [pricedProduct], tags: [] }), /<del aria-label="Regular price">₹899\.00<\/del>.*<strong>₹499\.00<\/strong>/);
  const checkoutPage = env.render('checkout.html', { ...base, checkout_token: 'token', shipping_threshold_paise: 100000, standard_shipping_paise: 8000 });
  assert.match(checkoutPage, /Delivery address/);
  assert.match(checkoutPage, /data-threshold="100000" data-standard-fee="8000"/);
  assert.match(checkoutPage, /Total due on delivery/);
  assert.doesNotMatch(checkoutPage, /Open Razorpay test checkout/);
  const testCheckout = env.render('checkout.html', { ...base, checkout_token: 'token', shipping_threshold_paise: 100000, standard_shipping_paise: 8000, razorpay_test_checkout: true });
  assert.match(testCheckout, /Open Razorpay test checkout/);
  assert.match(testCheckout, /₹1 demo/);
  const testPayment = env.render('test-payment.html', { ...base, payment: { status: 'pending', amount_paise: 100, razorpay_order_id: 'order_test' }, token: 'test-token', key_id: 'rzp_test_example', email: base.customer.email });
  assert.match(testPayment, /will not place a Happy Knots order or charge real money/);
  assert.doesNotMatch(testPayment, /example-secret/);
  assert.match(env.render('account.html', base), /name="pincode"/);
  assert.match(env.render('account.html', base), /name="city"/);
  assert.match(env.render('account.html', base), /name="landmark"/);
  assert.match(env.render('account.html', base), /\+91 is already included/);
  assert.match(env.render('account.html', base), /Select a state or UT/);
  assert.doesNotMatch(env.render('account.html', base).split('</title>')[0], /<script>/);
  const order = { id: 11, subtotal_paise: 2400, shipping_paise: 8000, total_paise: 10400, items: [{ product_name: 'Flower', quantity: 2, unit_price_paise: 1200 }] };
  const orderPage = env.render('customer_order.html', { ...base, order, clear_cart: true });
  assert.match(orderPage, /₹24\.00/);
  assert.match(orderPage, /₹80\.00/);
  assert.match(orderPage, /₹104\.00/);
  assert.match(orderPage, /localStorage\.removeItem\('happy-knots-cart'\)/);
  assert.doesNotMatch(env.render('customer_order.html', { ...base, order, clear_cart: false }), /localStorage\.removeItem/);
  const ownerOrder = { ...order, status: 'new', customer_name: 'Test Customer', email: 'buyer@example.com', phone: '9876543210', address: 'Test address', created_at: '2026-11-18T10:00:00.000Z' };
  const analytics = { day: [], week: [], month: [], year: [] };
  const ownerPage = env.render('owner.html', { ...base, customer: { email: 'aryandixit2905@gmail.com' }, orders: [ownerOrder], statuses: ['new', 'delivered'], selected_status: '', overview: { total_orders: 1, open_orders: 1, delivered_orders: 0, order_value_paise: 10400 }, analytics, categories: ['Home Decor'], recent_products: [] });
  assert.match(ownerPage, /Private workspace/);
  assert.match(ownerPage, /buyer@example\.com/);
  assert.doesNotMatch(ownerPage, /rakhidixit987@gmail\.com/);
  assert.match(ownerPage, /id="analyticsChart"/);
  assert.match(ownerPage, /id="ownerProductForm"/);
  assert.match(ownerPage, /name="regular_price"/);
  const ownerOrderPage = env.render('owner_order.html', { ...base, customer: { email: 'aryandixit2905@gmail.com' }, order: ownerOrder, statuses: ['new', 'delivered'], updated: false });
  assert.match(ownerOrderPage, /action="\/owner\/orders\/11\/status"/);
  assert.match(ownerOrderPage, /Personalisation|Test Customer/);
});

test('Cognito setup replaces template placeholders without duplicate keys', () => {
  const source = 'MONGODB_DB=happy_knots\nCOGNITO_POOL_ID=ap-southeast-2_example\nCOGNITO_CLIENT_ID=example\nCOGNITO_CLIENT_SECRET=replace-with-confidential-client-secret\n';
  assert.equal(hasConfiguredAuth(source), false);
  const merged = mergeAuthConfig(source, { COGNITO_POOL_ID: 'ap-southeast-2_real', COGNITO_CLIENT_ID: 'real', COGNITO_CLIENT_SECRET: 'secret' });
  assert.match(merged, /MONGODB_DB=happy_knots/);
  assert.equal((merged.match(/^COGNITO_POOL_ID=/gm) || []).length, 1);
  assert.equal(hasConfiguredAuth(merged), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestOrder, fetchTestPayment, isCapturedPayment, testCredentials, verifyPaymentSignature } from '../backend/razorpay.js';

const credentials = { keyId: 'rzp_test_example', keySecret: 'example-secret' };

test('only test credentials are accepted', () => {
  assert.deepEqual(testCredentials({ RAZORPAY_KEY_ID: credentials.keyId, RAZORPAY_KEY_SECRET: credentials.keySecret }), credentials);
  assert.throws(() => testCredentials({ RAZORPAY_KEY_ID: 'rzp_live_example', RAZORPAY_KEY_SECRET: credentials.keySecret }));
});

test('creates an INR test order with the exact amount and receipt', async () => {
  const order = await createTestOrder({ amountPaise: 18000, receipt: 'hk_test_123' }, credentials, async (url, options) => {
    assert.equal(url, 'https://api.razorpay.com/v1/orders');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { amount: 18000, currency: 'INR', receipt: 'hk_test_123' });
    assert.equal(options.headers.Authorization, 'Basic ' + Buffer.from('rzp_test_example:example-secret').toString('base64'));
    return { ok: true, json: async () => ({ id: 'order_123', amount: 18000, currency: 'INR', status: 'created' }) };
  });
  assert.equal(order.id, 'order_123');
  await assert.rejects(createTestOrder({ amountPaise: 99, receipt: 'hk_test' }, credentials), RangeError);
});

test('rejects unexpected order details and failed API calls', async () => {
  await assert.rejects(createTestOrder({ amountPaise: 18000, receipt: 'hk_test' }, credentials,
    async () => ({ ok: true, json: async () => ({ id: 'order_123', amount: 100, currency: 'INR' }) })), /invalid order/);
  await assert.rejects(createTestOrder({ amountPaise: 18000, receipt: 'hk_test' }, credentials,
    async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('checks a payment ID and verifies the server-side signature', async () => {
  const payment = await fetchTestPayment('pay_123', credentials, async (url) => {
    assert.equal(url, 'https://api.razorpay.com/v1/payments/pay_123');
    return { ok: true, json: async () => ({ id: 'pay_123', status: 'captured', amount: 18000, currency: 'INR', order_id: 'order_123' }) };
  });
  assert.equal(payment.status, 'captured');
  const signature = crypto.createHmac('sha256', credentials.keySecret).update('order_123|pay_123').digest('hex');
  assert.equal(verifyPaymentSignature({ orderId: 'order_123', paymentId: 'pay_123', signature }, credentials.keySecret), true);
  assert.equal(verifyPaymentSignature({ orderId: 'order_123', paymentId: 'pay_124', signature }, credentials.keySecret), false);
  assert.equal(verifyPaymentSignature({ orderId: 'order_123', paymentId: 'pay_123', signature: 'bad' }, credentials.keySecret), false);
  assert.equal(isCapturedPayment(payment, { orderId: 'order_123', paymentId: 'pay_123', amountPaise: 18000 }), true);
  assert.equal(isCapturedPayment({ ...payment, amount: 100 }, { orderId: 'order_123', paymentId: 'pay_123', amountPaise: 18000 }), false);
  assert.equal(isCapturedPayment({ ...payment, status: 'authorized' }, { orderId: 'order_123', paymentId: 'pay_123', amountPaise: 18000 }), false);
});

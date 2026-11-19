import crypto from 'node:crypto';

const API_BASE = 'https://api.razorpay.com/v1';

export function testCredentials(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !/^rzp_test_[A-Za-z0-9]+$/.test(keyId))
    throw new Error('Razorpay test credentials are not configured');
  return { keyId, keySecret };
}

export function liveCredentials(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !/^rzp_live_[A-Za-z0-9]+$/.test(keyId))
    throw new Error('Razorpay live credentials are not configured');
  return { keyId, keySecret };
}

async function request(endpoint, { keyId, keySecret }, { method = 'GET', body, fetchImpl = fetch } = {}) {
  if (!/^\/[a-z0-9/?=&_-]+$/i.test(endpoint)) throw new TypeError('Invalid Razorpay endpoint');
  if (!/^rzp_(?:test|live)_[A-Za-z0-9]+$/.test(keyId || '') || !keySecret) throw new Error('Razorpay credentials are not configured');
  const response = await fetchImpl(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Razorpay request failed (HTTP ${response.status})`);
  return response.json();
}

export async function createTestOrder({ amountPaise, receipt }, credentials = testCredentials(), fetchImpl = fetch) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100) throw new RangeError('Invalid payment amount');
  if (typeof receipt !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(receipt)) throw new TypeError('Invalid receipt');
  const order = await request('/orders', credentials, {
    method: 'POST', body: { amount: amountPaise, currency: 'INR', receipt }, fetchImpl
  });
  if (!/^order_[A-Za-z0-9]+$/.test(order?.id || '') || order.amount !== amountPaise || order.currency !== 'INR')
    throw new Error('Razorpay returned an invalid order');
  return { id: order.id, amountPaise: order.amount, currency: order.currency, status: order.status };
}

export async function createLiveOrder(details, credentials = liveCredentials(), fetchImpl = fetch) {
  return createTestOrder(details, credentials, fetchImpl);
}

export async function fetchTestPayment(paymentId, credentials = testCredentials(), fetchImpl = fetch) {
  if (typeof paymentId !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) throw new TypeError('Invalid payment ID');
  const payment = await request(`/payments/${paymentId}`, credentials, { fetchImpl });
  if (payment?.id !== paymentId) throw new Error('Razorpay returned an invalid payment');
  return payment;
}

export async function fetchLivePayment(paymentId, credentials = liveCredentials(), fetchImpl = fetch) {
  return fetchTestPayment(paymentId, credentials, fetchImpl);
}

export function verifyPaymentSignature({ orderId, paymentId, signature }, keySecret) {
  if (!/^order_[A-Za-z0-9]+$/.test(orderId || '') || !/^pay_[A-Za-z0-9]+$/.test(paymentId || '') ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) || !keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export function isCapturedPayment(payment, { orderId, paymentId, amountPaise }) {
  return payment?.id === paymentId && payment?.order_id === orderId && payment?.status === 'captured' &&
    payment?.amount === amountPaise && payment?.currency === 'INR';
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

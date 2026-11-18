import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import nunjucks from 'nunjucks';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import * as oidc from 'openid-client';
import { INDIAN_STATES_AND_UTS, parseAddress, isCompleteAddress, formatAddress } from './address.js';
import { verifyRecaptcha } from './recaptcha.js';
import { shippingPaise, FREE_SHIPPING_THRESHOLD_PAISE, STANDARD_SHIPPING_PAISE } from './shipping.js';
import { searchProducts } from './search.js';
import { checkoutSelection, discountPercent, pricedLines } from './catalog-options.js';
import { createTestOrder, fetchTestPayment, isCapturedPayment, testCredentials, verifyPaymentSignature } from './razorpay.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
dotenv.config({ path: path.join(projectRoot, '.env.mongo') });
const required = ['MONGODB_URI', 'FLASK_SECRET_KEY'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
const app = express();
if (process.env.RENDER === 'true') app.set('trust proxy', 1);
function resolvedMongoUri() {
  const original = process.env.MONGODB_URI;
  if (process.env.MONGODB_DNS_FALLBACK !== 'dig' || !original.startsWith('mongodb+srv://')) return original;
  const parsed = new URL(original);
  const lookup = (type, name) => execFileSync('dig', ['+time=3', '+tries=1', '+short', type, name],
    { encoding: 'utf8', timeout: 6000 }).trim();
  const members = lookup('SRV', `_mongodb._tcp.${parsed.hostname}`).split('\n').map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4 || !/^\d+$/.test(parts[2])) throw new Error('Invalid Atlas SRV record');
    return parts[3].replace(/\.$/, '') + ':' + parts[2];
  });
  const txt = lookup('TXT', parsed.hostname).replace(/^"|"$/g, '');
  const options = new URLSearchParams(txt);
  for (const [name, value] of parsed.searchParams) options.set(name, value);
  options.set('tls', 'true');
  return `mongodb://${parsed.username}:${parsed.password}@${members.join(',')}/${process.env.MONGODB_DB || 'happy_knots'}?${options}`;
}
const connection = new MongoClient(resolvedMongoUri(), { serverSelectionTimeoutMS: 10000, maxPoolSize: 20, waitQueueTimeoutMS: 5000 });
const database = connection.db(process.env.MONGODB_DB || 'happy_knots');
const products = database.collection('products');
const orders = database.collection('orders');
const stats = database.collection('stats');
const counters = database.collection('counters');
const receipts = database.collection('checkout_receipts');
const sessions = database.collection('sessions');
const loginLimits = database.collection('login_rate_limits');
const customers = database.collection('customers');
const categories = database.collection('customer_totals');
const testPayments = database.collection('razorpay_test_payments');
const catalogDrafts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'database/product-drafts.json'), 'utf8'));
const env = nunjucks.configure(path.join(projectRoot, 'frontend', 'templates'), { autoescape: true, noCache: process.env.NODE_ENV !== 'production' });
const render = (res, name, data = {}) => res.send(env.render(name, { csrf: res.locals.csrf, customer: res.locals.customer, ...data }));
env.addFilter('money', n => (Number(n || 0) / 100).toFixed(2));
env.addFilter('json_safe', x => new nunjucks.runtime.SafeString(JSON.stringify(x).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')));
env.addFilter('urlencode', x => encodeURIComponent(x));
app.use(compression({ threshold: 1024 }));
app.use('/static', express.static(path.join(projectRoot, 'frontend', 'static'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/\.(?:webp|avif|woff2)$/i.test(filePath))
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    else
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
  }
}));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.get('/healthz', (_req, res) => res.sendStatus(200));
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const sign = value => `${value}.${crypto.createHmac('sha256', process.env.FLASK_SECRET_KEY).update(value).digest('base64url')}`;
const unsign = value => { if (!value) return null; const index = value.lastIndexOf('.'); const raw = value.slice(0, index); return index > 0 && equal(sign(raw), value) ? raw : null; };
app.use(async (req, res, next) => {
  try {
    const sid = unsign(req.cookies.hk_session);
    const row = sid ? await sessions.findOne({ _id: digest(sid), expires_at: { $gt: new Date() } }) : null;
    if (!row && req.cookies.hk_session) res.clearCookie('hk_session');
    req.sid = row ? sid : null; req.login = row || {}; res.locals.csrf = row?.csrf;
    res.locals.customer = row?.customer && row.auth_expires_at > Date.now() ? row.customer : null;
    next();
  } catch (error) { next(error); }
});
const customerOnly = (req, res, next) => res.locals.customer ? next() : res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl));
const testPaymentsReady = () => {
  if (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || process.env.RAZORPAY_TEST_CHECKOUT !== 'true') return false;
  try { testCredentials(); return true; } catch { return false; }
};
const testPaymentsOnly = (_req, res, next) => testPaymentsReady() ? next() : res.sendStatus(404);
const csrf = (req, res, next) => equal(req.body.csrf, req.login.csrf) ? next() : res.sendStatus(400);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const now = () => new Date().toISOString();
const errorPage = (res, title, message, status = 200) => res.status(status).send(env.render('message.html', { title, message, csrf: res.locals.csrf }));
async function nextId(name, session) {
  const result = await counters.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  return result.value;
}
function catalogProduct(row) {
  const variants = row.price_options || row.style_options || [];
  return {
    sku: row.sku, name: row.name, category: row.category, tags: [row.category], description: row.description,
    image: row.images[0], images: row.images,
    variants: variants.map(v => ({ code: v.code, label: v.label, image: v.image || row.images[0], price_paise: v.price_paise || row.price_paise, compare_at_paise: v.compare_at_paise || row.compare_at_paise })),
    price_paise: row.price_paise, compare_at_paise: row.compare_at_paise,
    personalisation: row.personalisation || null, badge: row.badge || null,
    made_to_order: true, stock: 9999, active: 1, version: 1, units: 0, sales_revenue: 0
  };
}
async function publishInitialCatalog() {
  const migration = database.collection('migration');
  const markerId = 'product-catalog-2026-11-18';
  if (await migration.findOne({ _id: markerId })) return;
  const transaction = connection.startSession();
  try {
    await transaction.withTransaction(async () => {
      if (await migration.findOne({ _id: markerId }, { session: transaction })) return;
      const highest = await products.find({}, { session: transaction }).sort({ id: -1 }).limit(1).next();
      await counters.updateOne({ _id: 'products' }, { $max: { value: highest?.id || 0 } }, { upsert: true, session: transaction });
      for (const row of catalogDrafts) {
        if (await products.findOne({ sku: row.sku }, { session: transaction })) continue;
        const id = await nextId('products', transaction);
        await products.insertOne({ ...catalogProduct(row), id }, { session: transaction });
      }
      await migration.insertOne({ _id: markerId, state: 'READY', product_count: catalogDrafts.length, created_at: now() }, { session: transaction });
    });
  } finally { await transaction.endSession(); }
}
async function catalog() { return products.find({ active: 1 }).project({ id: 1, name: 1, tags: 1, category: 1, description: 1, price_paise: 1, compare_at_paise: 1, image: 1, images: 1, variants: 1, personalisation: 1, badge: 1, made_to_order: 1, stock: 1 }).sort({ id: -1 }).toArray(); }
const tagNames = ['Personal Accessories & Clothing', 'Door Hangings', 'Wall Hangings', 'Home Decor'];
const tagsFor = p => Array.isArray(p.tags) ? p.tags.filter(t => tagNames.includes(t)) : tagNames.includes(p.category) ? [p.category] : [];
const publicProduct = p => ({ id: p.id, name: p.name, tags: tagsFor(p), description: p.description, price_paise: p.price_paise, compare_at_paise: p.compare_at_paise > p.price_paise ? p.compare_at_paise : null, discount_percent: discountPercent(p.price_paise, p.compare_at_paise), image: p.image, images: Array.isArray(p.images) ? p.images : [], variants: Array.isArray(p.variants) ? p.variants.map(v => ({ ...v, discount_percent: discountPercent(v.price_paise, v.compare_at_paise) })) : [], personalisation: p.personalisation || null, badge: p.badge || null, made_to_order: !!p.made_to_order, stock: p.stock });
app.get('/', wrap(async (req, res) => {
  const listing = (await catalog()).map(publicProduct);
  render(res, 'shop.html', { products: listing.slice(0, 6), product_json: listing });
}));
app.get('/contact', (_req, res) => render(res, 'contact.html'));
app.get('/terms', (_req, res) => render(res, 'terms.html'));
app.get('/privacy', (_req, res) => render(res, 'privacy.html'));
app.get('/shipping', (_req, res) => render(res, 'shipping.html'));
app.get('/returns', (_req, res) => render(res, 'returns.html'));
app.get('/shop', wrap(async (req, res) => {
  const listing = (await catalog()).map(publicProduct);
  const tag = tagNames.includes(req.query.category) ? req.query.category : null;
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const filtered = searchProducts(tag ? listing.filter(p => p.tags.includes(tag)) : listing, searchQuery);
  render(res, 'catalog.html', { products: filtered, product_json: listing, tags: tagNames, selected_tag: tag, search_query: searchQuery });
}));
app.get('/products/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const [product, listing] = await Promise.all([
    products.findOne({ id, active: 1 }, { projection: { id: 1, name: 1, tags: 1, category: 1, description: 1, price_paise: 1, compare_at_paise: 1, image: 1, images: 1, variants: 1, personalisation: 1, badge: 1, made_to_order: 1, stock: 1 } }),
    catalog()
  ]);
  if (!product) return res.sendStatus(404);
  render(res, 'product.html', { product: publicProduct(product), product_json: listing.map(publicProduct) });
}));
app.get('/checkout', customerOnly, wrap(async (req, res) => {
  const [profile, listing] = await Promise.all([
    customers.findOne({ _id: res.locals.customer.sub }, { projection: { addresses: 1 } }),
    catalog()
  ]);
  render(res, 'checkout.html', { profile: { addresses: (profile?.addresses || []).filter(isCompleteAddress) }, product_json: listing.map(publicProduct), checkout_token: sign(random()), shipping_threshold_paise: FREE_SHIPPING_THRESHOLD_PAISE, standard_shipping_paise: STANDARD_SHIPPING_PAISE, razorpay_test_checkout: testPaymentsReady() });
}));
app.post('/payments/test/start', testPaymentsOnly, customerOnly, csrf, wrap(async (req, res) => {
  if (!unsign(req.body.checkout_token)) return res.sendStatus(400);
  const profile = await customers.findOne({ _id: res.locals.customer.sub }, { projection: { addresses: 1 } });
  const address = profile?.addresses?.find(a => a.address_id === req.body.address_id);
  if (!isCompleteAddress(address)) return errorPage(res, 'Complete delivery address required', 'Save a complete delivery address before testing a payment.', 400);
  let submitted;
  try { submitted = JSON.parse(req.body.items || '[]'); } catch { return res.sendStatus(400); }
  const selection = checkoutSelection(submitted);
  if (!selection) return res.sendStatus(400);
  const selected = await products.find({ id: { $in: [...selection.totals.keys()] } }).toArray();
  const lines = pricedLines(selected, selection);
  if (!lines)
    return errorPage(res, 'Bag changed', 'An item is no longer available in that quantity. Please review your bag.', 409);
  const subtotal = lines.reduce((sum, line) => sum + line.unit_price_paise * line.quantity, 0);
  if (!Number.isSafeInteger(subtotal) || (submitted.length && subtotal < 100)) return res.sendStatus(400);
  const isDemo = submitted.length === 0;
  const amountPaise = isDemo ? 100 : subtotal + shippingPaise(subtotal);
  const token = random();
  const razorpayOrder = await createTestOrder({ amountPaise, receipt: `hk_test_${crypto.randomBytes(10).toString('hex')}` });
  await testPayments.insertOne({ _id: digest(token), customer_sub: res.locals.customer.sub,
    razorpay_order_id: razorpayOrder.id, amount_paise: amountPaise, is_demo: isDemo, status: 'pending',
    address_id: address.address_id, items: lines,
    created_at: now(), expires_at: new Date(Date.now() + 60 * 60 * 1000) });
  res.redirect(`/payments/test/${token}`);
}));
app.get('/payments/test/:token', testPaymentsOnly, customerOnly, wrap(async (req, res) => {
  const payment = await testPayments.findOne({ _id: digest(req.params.token), customer_sub: res.locals.customer.sub, expires_at: { $gt: new Date() } });
  if (!payment) return res.sendStatus(404);
  render(res, 'test-payment.html', { payment, token: req.params.token, key_id: testCredentials().keyId });
}));
app.post('/payments/test/:token/verify', testPaymentsOnly, customerOnly, csrf, wrap(async (req, res) => {
  const pending = await testPayments.findOne({ _id: digest(req.params.token), customer_sub: res.locals.customer.sub, expires_at: { $gt: new Date() } });
  if (!pending) return res.sendStatus(404);
  if (pending.status === 'paid') return res.redirect(`/payments/test/${req.params.token}`);
  if (pending.status !== 'pending' || req.body.razorpay_order_id !== pending.razorpay_order_id ||
      !verifyPaymentSignature({ orderId: pending.razorpay_order_id, paymentId: req.body.razorpay_payment_id, signature: req.body.razorpay_signature }, testCredentials().keySecret))
    return res.sendStatus(400);
  const payment = await fetchTestPayment(req.body.razorpay_payment_id);
  if (!isCapturedPayment(payment, { orderId: pending.razorpay_order_id, paymentId: req.body.razorpay_payment_id, amountPaise: pending.amount_paise }))
    return errorPage(res, 'Payment not confirmed', 'Razorpay has not confirmed a captured test payment. No shop order was created.', 409);
  await testPayments.updateOne({ _id: pending._id, status: 'pending' }, { $set: { status: 'paid', razorpay_payment_id: payment.id, paid_at: now() } });
  res.redirect(`/payments/test/${req.params.token}`);
}));
app.post('/orders', customerOnly, csrf, wrap(async (req, res) => {
  const profile = await customers.findOne({ _id: res.locals.customer.sub });
  const address = profile?.addresses?.find(a => a.address_id === req.body.address_id);
  if (!isCompleteAddress(address)) return errorPage(res, 'Complete delivery address required', 'Save and select an address with a city, state and six-digit PIN code before placing an order.', 400);
  const customer = { name: address.name, email: res.locals.customer.email, phone: address.phone,
    address_line1: address.address_line1, address_line2: address.address_line2,
    landmark: address.landmark, city: address.city, state: address.state,
    pincode: address.pincode, address: formatAddress(address) };
  let submitted;
  try { submitted = JSON.parse(req.body.items || '[]'); } catch { return res.sendStatus(400); }
  const selection = checkoutSelection(submitted);
  if (!selection?.lines.length || !unsign(req.body.checkout_token)) return res.sendStatus(400);
  const receiptKey = digest(req.body.checkout_token);
  const fingerprint = digest(JSON.stringify([customer, selection.lines.sort((a, b) => a.id - b.id || a.variant.localeCompare(b.variant) || a.personalisation.localeCompare(b.personalisation))]));
  let orderId;
  const transaction = connection.startSession();
  try {
    await transaction.withTransaction(async () => {
      const previous = await receipts.findOne({ _id: receiptKey }, { session: transaction });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Checkout token was already used'), { status: 409 });
        orderId = previous.order_id; return;
      }
      const selected = await products.find({ id: { $in: [...selection.totals.keys()] } }, { session: transaction }).toArray();
      const items = pricedLines(selected, selection);
      if (!items) throw Object.assign(new Error('An item is no longer available in that quantity. Please review your bag.'), { status: 409 });
      orderId = await nextId('orders', transaction);
      const subtotal = items.reduce((n, item) => n + item.unit_price_paise * item.quantity, 0);
      const shipping = shippingPaise(subtotal);
      const total = subtotal + shipping;
      await orders.insertOne({ id: orderId, customer_sub: res.locals.customer.sub, customer_name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.address, address_line1: customer.address_line1, address_line2: customer.address_line2,
        landmark: customer.landmark, city: customer.city, state: customer.state, pincode: customer.pincode,
        subtotal_paise: subtotal, shipping_paise: shipping, total_paise: total, status: 'new', payment_method: 'cash_on_delivery', created_at: now(), items }, { session: transaction });
      for (const p of selected) {
        const qty = selection.totals.get(p.id);
        const revenue = items.filter(item => item.product_id === p.id).reduce((sum, item) => sum + item.unit_price_paise * item.quantity, 0);
        const result = await products.updateOne({ id: p.id, active: 1, stock: { $gte: qty }, version: p.version }, { $inc: { stock: -qty, version: 1, units: qty, sales_revenue: revenue } }, { session: transaction });
        if (result.matchedCount !== 1) throw Object.assign(new Error('An item changed. Please review your bag.'), { status: 409 });
      }
      await stats.updateOne({ _id: 'shop' }, { $inc: { orders: 1, revenue: total } }, { upsert: true, session: transaction });
      await categories.updateOne({ email: customer.email }, { $set: { customer_name: customer.name }, $inc: { orders: 1, spent: total } }, { upsert: true, session: transaction });
      await receipts.insertOne({ _id: receiptKey, fingerprint, order_id: orderId }, { session: transaction });
    });
  } catch (error) {
    if (error.code === 11000) {
      const previous = await receipts.findOne({ _id: receiptKey });
      if (previous?.fingerprint === fingerprint) orderId = previous.order_id;
      else throw Object.assign(new Error('Checkout changed; please refresh'), { status: 409 });
    } else throw error;
  } finally { await transaction.endSession(); }
  res.cookie('hk_checkout_success', sign(String(orderId)), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60000 });
  res.redirect(`/account/orders/${orderId}`);
}));

const authReady = () => ['COGNITO_ISSUER', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'COGNITO_DOMAIN', 'APP_BASE_URL'].every(k => process.env[k]);
let oidcConfigPromise;
async function cognito() {
  if (!authReady()) return null;
  if (!oidcConfigPromise) {
    oidcConfigPromise = oidc.discovery(new URL(process.env.COGNITO_ISSUER), process.env.COGNITO_CLIENT_ID, process.env.COGNITO_CLIENT_SECRET, oidc.ClientSecretPost(), { timeout: 8 })
      .catch(error => { oidcConfigPromise = null; throw error; });
  }
  return oidcConfigPromise;
}
const safeNext = value => typeof value === 'string' && /^\/(?:account|checkout|shop|products)(?:[/?#]|$)/.test(value) && !value.includes(String.fromCharCode(92)) ? value : '/account';
const loginRateLimit = async (req, res, next) => {
  try {
    const windowMs = 10 * 60 * 1000;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = digest(`${req.ip || req.socket.remoteAddress}:${bucket}`);
    const result = await loginLimits.findOneAndUpdate({ _id: key },
      { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((bucket + 1) * windowMs + 60000) } },
      { upsert: true, returnDocument: 'after' });
    if (result.count > 10) return errorPage(res, 'Please wait a moment', 'Too many sign-in requests. Please try again shortly.', 429);
    next();
  } catch (error) { next(error); }
};
async function startCognitoLogin(req, res, next) {
  const config = await cognito();
  if (!config) return errorPage(res, 'Customer login setup in progress', 'Please try again shortly.', 503);
  const state = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  let sid = req.sid;
  if (!sid) {
    sid = random();
    await sessions.insertOne({ _id: digest(sid), csrf: random(), expires_at: new Date(Date.now() + 10 * 60000),
      oauth: { state, verifier, nonce, next, created_at: Date.now() } });
    res.cookie('hk_session', sign(sid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 10 * 60000 });
  } else {
    await sessions.updateOne({ _id: digest(sid) }, { $set: { oauth: { state, verifier, nonce, next, created_at: Date.now() } } });
  }
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: `${process.env.APP_BASE_URL}/account/callback`, scope: 'openid email', response_type: 'code', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
  res.redirect(url.href);
}
app.get('/account/login', loginRateLimit, wrap(async (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  if (!authReady() || Boolean(process.env.RECAPTCHA_SITE_KEY) !== Boolean(process.env.RECAPTCHA_SECRET_KEY))
    return errorPage(res, 'Customer login setup in progress', 'Please try again shortly.', 503);
  if (!process.env.RECAPTCHA_SITE_KEY) return startCognitoLogin(req, res, safeNext(req.query.next));
  render(res, 'login.html', { next: safeNext(req.query.next), recaptcha_site_key: process.env.RECAPTCHA_SITE_KEY });
}));
app.post('/account/login', loginRateLimit, wrap(async (req, res) => {
  if (res.locals.customer) return res.redirect('/account');
  if (!process.env.RECAPTCHA_SITE_KEY || !process.env.RECAPTCHA_SECRET_KEY || !authReady())
    return errorPage(res, 'Customer login setup in progress', 'Please try again shortly.', 503);
  const next = safeNext(req.body.next);
  const verified = await verifyRecaptcha(req.body['g-recaptcha-response'], {
    secret: process.env.RECAPTCHA_SECRET_KEY,
    hostname: new URL(process.env.APP_BASE_URL).hostname
  });
  if (!verified) return res.status(400).send(env.render('login.html', {
    next, recaptcha_site_key: process.env.RECAPTCHA_SITE_KEY,
    error: 'Please complete the CAPTCHA and try again.'
  }));
  return startCognitoLogin(req, res, next);
}));
app.get('/account/callback', wrap(async (req, res) => {
  const flow = req.login.oauth;
  if (!flow || Date.now() - flow.created_at > 600000 || req.query.state !== flow.state) return res.sendStatus(400);
  await sessions.updateOne({ _id: digest(req.sid) }, { $unset: { oauth: '' } });
  const config = await cognito();
  if (!config) return res.sendStatus(503);
  const tokens = await oidc.authorizationCodeGrant(config, new URL(req.originalUrl, process.env.APP_BASE_URL), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub || !claims.email || claims.email_verified !== true) return errorPage(res, 'Email verification required', 'Please verify your email before signing in.', 403);
  const customer = { sub: claims.sub, email: claims.email };
  await customers.updateOne({ _id: customer.sub }, { $set: { email: customer.email, updated_at: now() }, $setOnInsert: { addresses: [], created_at: now() } }, { upsert: true });
  const sid = random();
  const lifetime = Math.min((tokens.expiresIn() || 3600) * 1000, 3600000);
  await sessions.insertOne({ _id: digest(sid), csrf: random(), customer, auth_expires_at: Date.now() + lifetime, expires_at: new Date(Date.now() + lifetime) });
  await sessions.deleteOne({ _id: digest(req.sid) });
  res.cookie('hk_session', sign(sid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: lifetime });
  res.redirect(flow.next);
}));
app.post('/account/logout', csrf, wrap(async (req, res) => {
  await sessions.deleteOne({ _id: digest(req.sid) });
  res.clearCookie('hk_session');
  if (authReady()) {
    const url = new URL('/logout', process.env.COGNITO_DOMAIN);
    url.searchParams.set('client_id', process.env.COGNITO_CLIENT_ID);
    url.searchParams.set('logout_uri', process.env.APP_BASE_URL);
    return res.redirect(url.href);
  }
  res.redirect('/');
}));
app.get('/account', customerOnly, wrap(async (req, res) => {
  const before = Number(req.query.before);
  const orderFilter = { customer_sub: res.locals.customer.sub };
  if (Number.isSafeInteger(before) && before > 0) orderFilter.id = { $lt: before };
  const [profile, history] = await Promise.all([
    customers.findOne({ _id: res.locals.customer.sub }, { projection: { addresses: 1 } }),
    orders.find(orderFilter).project({ id: 1, created_at: 1, status: 1, subtotal_paise: 1, total_paise: 1 }).sort({ id: -1 }).limit(31).toArray()
  ]);
  const page = history.slice(0, 30);
  render(res, 'account.html', { profile: profile || { addresses: [] }, orders: page, next_cursor: history.length > 30 ? page.at(-1).id : null, states: INDIAN_STATES_AND_UTS });
}));
app.post('/account/addresses', customerOnly, csrf, wrap(async (req, res) => {
  const fields = parseAddress(req.body);
  if (!fields) return res.sendStatus(400);
  const address = { address_id: random(), ...fields };
  const result = await customers.updateOne({ _id: res.locals.customer.sub, 'addresses.4': { $exists: false } }, { $push: { addresses: address } });
  if (!result.modifiedCount) return errorPage(res, 'Address limit reached', 'You can save up to five addresses.', 409);
  res.redirect('/account#addresses');
}));
app.post('/account/addresses/:id/delete', customerOnly, csrf, wrap(async (req, res) => {
  await customers.updateOne({ _id: res.locals.customer.sub }, { $pull: { addresses: { address_id: req.params.id } } });
  res.redirect('/account#addresses');
}));
app.get('/account/orders/:id', customerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const order = Number.isSafeInteger(id) ? await orders.findOne({ id, customer_sub: res.locals.customer.sub }) : null;
  if (!order) return res.sendStatus(404);
  const clear_cart = unsign(req.cookies.hk_checkout_success) === String(id);
  if (req.cookies.hk_checkout_success) res.clearCookie('hk_checkout_success');
  render(res, 'customer_order.html', { order, clear_cart });
}));
app.use((error, req, res, next) => {
  if (error.status && error.status < 500) return errorPage(res, 'Bag changed', error.message, error.status);
  console.error(error);
  errorPage(res, 'Shop temporarily unavailable', 'Please try again shortly.', 503);
});
export async function init() {
  await connection.connect();
  await database.command({ ping: 1 });
  const marker = await database.collection('migration').findOne({ _id: 'happy-knots' });
  if (marker?.state !== 'READY') throw new Error('Atlas migration is not verified; run migrate-to-atlas.js first');
  await Promise.all([
    products.createIndex({ id: 1 }, { unique: true }), products.createIndex({ sku: 1 }, { unique: true, sparse: true }), products.createIndex({ active: 1, id: -1 }), orders.createIndex({ id: 1 }, { unique: true }),
    orders.createIndex({ id: -1 }), orders.createIndex({ customer_sub: 1, id: -1 }), categories.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    testPayments.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    loginLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })]);
  await publishInitialCatalog();
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
  const port = Number(process.env.PORT || 5050);
  init().then(() => app.listen(port, host, () => console.log(`Happy Knots listening on ${host}:${port}`))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { app, connection, database };

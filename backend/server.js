import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express from 'express';
import cookieParser from 'cookie-parser';
import nunjucks from 'nunjucks';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import * as oidc from 'openid-client';
import { INDIAN_STATES_AND_UTS, parseAddress, isCompleteAddress, formatAddress } from './address.js';
import { verifyRecaptcha } from './recaptcha.js';

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
const connection = new MongoClient(resolvedMongoUri(), { serverSelectionTimeoutMS: 10000 });
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
const env = nunjucks.configure(path.join(projectRoot, 'frontend', 'templates'), { autoescape: true, noCache: process.env.NODE_ENV !== 'production' });
const render = (res, name, data = {}) => res.send(env.render(name, { csrf: res.locals.csrf, customer: res.locals.customer, ...data }));
env.addFilter('money', n => (Number(n || 0) / 100).toFixed(2));
env.addFilter('json_safe', x => new nunjucks.runtime.SafeString(JSON.stringify(x).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')));
env.addFilter('urlencode', x => encodeURIComponent(x));
app.use('/static', express.static(path.join(projectRoot, 'frontend', 'static'), { maxAge: '1h' }));
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
const csrf = (req, res, next) => equal(req.body.csrf, req.login.csrf) ? next() : res.sendStatus(400);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const now = () => new Date().toISOString();
const errorPage = (res, title, message, status = 200) => res.status(status).send(env.render('message.html', { title, message, csrf: res.locals.csrf }));
async function nextId(name, session) {
  const result = await counters.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  return result.value;
}
async function catalog(activeOnly = false) { return products.find(activeOnly ? { active: 1 } : {}).sort({ id: -1 }).toArray(); }
const tagNames = ['Personal Accessories & Clothing', 'Door Hangings', 'Wall Hangings', 'Home Decor'];
const tagsFor = p => Array.isArray(p.tags) ? p.tags.filter(t => tagNames.includes(t)) : tagNames.includes(p.category) ? [p.category] : [];
const publicProduct = p => ({ id: p.id, name: p.name, tags: tagsFor(p), description: p.description, price_paise: p.price_paise, image: p.image, stock: p.stock });
app.get('/', wrap(async (req, res) => {
  const listing = (await catalog(true)).slice(0, 6);
  render(res, 'shop.html', { products: listing.map(publicProduct), product_json: (await catalog(true)).map(publicProduct) });
}));
app.get('/contact', (_req, res) => render(res, 'contact.html'));
app.get('/shop', wrap(async (req, res) => {
  const listing = (await catalog(true)).map(publicProduct);
  const tag = tagNames.includes(req.query.category) ? req.query.category : null;
  render(res, 'catalog.html', { products: tag ? listing.filter(p => p.tags.includes(tag)) : listing, product_json: listing, tags: tagNames, selected_tag: tag });
}));
app.get('/products/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const product = Number.isSafeInteger(id) ? await products.findOne({ id, active: 1 }) : null;
  if (!product) return res.sendStatus(404);
  render(res, 'product.html', { product: publicProduct(product), product_json: (await catalog(true)).map(publicProduct) });
}));
app.get('/checkout', customerOnly, wrap(async (req, res) => {
  const profile = await customers.findOne({ _id: res.locals.customer.sub });
  render(res, 'checkout.html', { profile: { addresses: (profile?.addresses || []).filter(isCompleteAddress) }, product_json: (await catalog(true)).map(publicProduct), checkout_token: sign(random()) });
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
  if (!Array.isArray(submitted) || !submitted.length || submitted.length > 50) return res.sendStatus(400);
  const quantities = new Map();
  for (const item of submitted) {
    if (!Number.isSafeInteger(item?.id) || item.id < 1 || !Number.isSafeInteger(item?.quantity) || item.quantity < 1 || item.quantity > 99) return res.sendStatus(400);
    quantities.set(item.id, (quantities.get(item.id) || 0) + item.quantity);
  }
  if ([...quantities.values()].some(q => q > 99) || !unsign(req.body.checkout_token)) return res.sendStatus(400);
  const receiptKey = digest(req.body.checkout_token);
  const fingerprint = digest(JSON.stringify([customer, [...quantities].sort((a, b) => a[0] - b[0])]));
  let orderId;
  const transaction = connection.startSession();
  try {
    await transaction.withTransaction(async () => {
      const previous = await receipts.findOne({ _id: receiptKey }, { session: transaction });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Object.assign(new Error('Checkout token was already used'), { status: 409 });
        orderId = previous.order_id; return;
      }
      const selected = await products.find({ id: { $in: [...quantities.keys()] } }, { session: transaction }).toArray();
      if (selected.length !== quantities.size || selected.some(p => !p.active || p.stock < quantities.get(p.id))) throw Object.assign(new Error('An item is no longer available in that quantity. Please review your bag.'), { status: 409 });
      orderId = await nextId('orders', transaction);
      const items = selected.map(p => ({ product_id: p.id, product_name: p.name, unit_price_paise: p.price_paise, quantity: quantities.get(p.id) }));
      const subtotal = items.reduce((n, item) => n + item.unit_price_paise * item.quantity, 0);
      await orders.insertOne({ id: orderId, customer_sub: res.locals.customer.sub, customer_name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.address, address_line1: customer.address_line1, address_line2: customer.address_line2,
        landmark: customer.landmark, city: customer.city, state: customer.state, pincode: customer.pincode,
        subtotal_paise: subtotal, status: 'new', payment_method: 'cash_on_delivery', created_at: now(), items }, { session: transaction });
      for (const p of selected) {
        const qty = quantities.get(p.id);
        const result = await products.updateOne({ id: p.id, active: 1, stock: { $gte: qty }, version: p.version }, { $inc: { stock: -qty, version: 1, units: qty, sales_revenue: qty * p.price_paise } }, { session: transaction });
        if (result.matchedCount !== 1) throw Object.assign(new Error('An item changed. Please review your bag.'), { status: 409 });
      }
      await stats.updateOne({ _id: 'shop' }, { $inc: { orders: 1, revenue: subtotal } }, { upsert: true, session: transaction });
      await categories.updateOne({ email: customer.email }, { $set: { customer_name: customer.name }, $inc: { orders: 1, spent: subtotal } }, { upsert: true, session: transaction });
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
let oidcConfig;
async function cognito() {
  if (!authReady()) return null;
  if (!oidcConfig) oidcConfig = await oidc.discovery(new URL(process.env.COGNITO_ISSUER), process.env.COGNITO_CLIENT_ID, process.env.COGNITO_CLIENT_SECRET, oidc.ClientSecretPost());
  return oidcConfig;
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
  const profile = await customers.findOne({ _id: res.locals.customer.sub });
  const history = await orders.find({ customer_sub: res.locals.customer.sub }).sort({ id: -1 }).limit(30).toArray();
  render(res, 'account.html', { profile: profile || { addresses: [] }, orders: history, states: INDIAN_STATES_AND_UTS });
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
    products.createIndex({ id: 1 }, { unique: true }), orders.createIndex({ id: 1 }, { unique: true }),
    orders.createIndex({ id: -1 }), orders.createIndex({ customer_sub: 1, id: -1 }), categories.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    loginLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })]);
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
  const port = Number(process.env.PORT || 5050);
  init().then(() => app.listen(port, host, () => console.log(`Happy Knots listening on ${host}:${port}`))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { app, connection, database };

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

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
dotenv.config({ path: path.join(projectRoot, '.env.mongo') });
const required = ['MONGODB_URI', 'FLASK_SECRET_KEY'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required`);
const app = express();
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
const categories = database.collection('customer_totals');
const env = nunjucks.configure(path.join(projectRoot, 'frontend', 'templates'), { autoescape: true, noCache: process.env.NODE_ENV !== 'production' });
const render = (res, name, data = {}) => res.send(env.render(name, { csrf: res.locals.csrf, ...data }));
env.addFilter('money', n => (Number(n || 0) / 100).toFixed(2));
env.addFilter('json_safe', x => new nunjucks.runtime.SafeString(JSON.stringify(x).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')));
app.use('/static', express.static(path.join(projectRoot, 'frontend', 'static'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const sign = value => `${value}.${crypto.createHmac('sha256', process.env.FLASK_SECRET_KEY).update(value).digest('base64url')}`;
const unsign = value => { if (!value) return null; const index = value.lastIndexOf('.'); const raw = value.slice(0, index); return index > 0 && equal(sign(raw), value) ? raw : null; };
app.use(async (req, res, next) => {
  try {
    let sid = unsign(req.cookies.hk_session);
    let row = sid && await sessions.findOne({ _id: digest(sid), expires_at: { $gt: new Date() } });
    if (!row) {
      sid = random(); row = { _id: digest(sid), csrf: random(), owner: false, expires_at: new Date(Date.now() + 30 * 86400000) };
      await sessions.insertOne(row);
      res.cookie('hk_session', sign(sid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400000 });
    }
    req.sid = sid; req.login = row; res.locals.csrf = row.csrf;
    next();
  } catch (error) { next(error); }
});
const protect = (req, res, next) => req.login.owner ? next() : res.redirect('/owner/login');
const csrf = (req, res, next) => equal(req.body.csrf, req.login.csrf) ? next() : res.sendStatus(400);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const now = () => new Date().toISOString();
const errorPage = (res, title, message, status = 200) => res.status(status).send(env.render('message.html', { title, message, csrf: res.locals.csrf }));
async function nextId(name, session) {
  const result = await counters.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  return result.value;
}
async function catalog(activeOnly = false) { return products.find(activeOnly ? { active: 1 } : {}).sort({ id: -1 }).toArray(); }
function productInput(body, active) {
  if (body.price == null || String(body.price).trim() === '' || body.stock == null || String(body.stock).trim() === '') return null;
  const price = Number(body.price), stock = Number(body.stock);
  if (!Number.isFinite(price) || !Number.isSafeInteger(Math.round(price * 100)) || price < 0 || !Number.isSafeInteger(stock) || stock < 0 || stock > 1e9) return null;
  const name = String(body.name || '').trim(), image = String(body.image || '').trim();
  if (!name || name.length > 120 || image.length > 2048 || (image && !image.startsWith('/static/assets/') && !image.startsWith('https://'))) return null;
  return { name, image, price_paise: Math.round(price * 100), stock, active, category: String(body.category || 'Other').slice(0, 60), description: String(body.description || '').slice(0, 1000) };
}
app.get('/', wrap(async (req, res) => {
  const listing = await catalog(true);
  const publicFields = listing.map(({ id, name, category, description, price_paise, image, stock }) => ({ id, name, category, description, price_paise, image, stock }));
  render(res, 'shop.html', { products: listing, product_json: publicFields, checkout_token: sign(random()) });
}));
app.post('/orders', csrf, wrap(async (req, res) => {
  const customer = Object.fromEntries(['name','email','phone','address'].map(k => [k, String(req.body[k] || '').trim()]));
  if (Object.values(customer).some(v => !v || v.length > 500) || !customer.email.includes('@')) return res.sendStatus(400);
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
      await orders.insertOne({ id: orderId, customer_name: customer.name, email: customer.email, phone: customer.phone, address: customer.address, subtotal_paise: subtotal, status: 'new', payment_method: 'cash_on_delivery', created_at: now(), items }, { session: transaction });
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
  errorPage(res, `Order #${orderId} received`, 'Thank you. Your order has been recorded. Payment and delivery confirmation will be arranged separately.');
}));
function verifyOwnerPassword(password, stored) {
  const match = /^scrypt:(\d+):(\d+):(\d+)\$([^$]+)\$([a-f0-9]+)$/.exec(stored);
  if (!match) return false;
  const [, N, r, p, salt, hex] = match;
  const expected = Buffer.from(hex, 'hex');
  try { return crypto.timingSafeEqual(crypto.scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 }), expected); } catch { return false; }
}
app.get('/owner/login', (req, res) => render(res, 'login.html'));
app.post('/owner/login', csrf, wrap(async (req, res) => {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH && equal(req.body.email, process.env.ADMIN_EMAIL) && verifyOwnerPassword(String(req.body.password || ''), process.env.ADMIN_PASSWORD_HASH)) {
    await sessions.deleteOne({ _id: digest(req.sid) });
    const sid = random();
    await sessions.insertOne({ _id: digest(sid), csrf: random(), owner: true, expires_at: new Date(Date.now() + 30 * 86400000) });
    res.cookie('hk_session', sign(sid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 86400000 });
    return res.redirect('/owner');
  }
  render(res, 'login.html', { error: 'Invalid login.' });
}));
app.post('/owner/logout', protect, csrf, wrap(async (req, res) => { await sessions.deleteOne({ _id: digest(req.sid) }); res.clearCookie('hk_session'); res.redirect('/'); }));
app.get('/owner', protect, wrap(async (req, res) => {
  const [summary, listing, recent, topProducts, topCustomers] = await Promise.all([
    stats.findOne({ _id: 'shop' }), catalog(), orders.find().sort({ id: -1 }).limit(30).toArray(),
    products.find({ units: { $gt: 0 } }).sort({ units: -1 }).limit(5).toArray(),
    categories.find().sort({ spent: -1 }).limit(5).toArray()]);
  render(res, 'owner.html', { stats: summary || { orders: 0, revenue: 0 }, products: listing, stock_total: listing.reduce((n,p) => n + p.stock, 0), orders: recent,
    best: topProducts.map(p => ({ product_name: p.name, units: p.units })), customers: topCustomers });
}));
app.post('/owner/products', protect, csrf, wrap(async (req, res) => {
  const values = productInput(req.body, 1); if (!values) return res.sendStatus(400);
  const id = await nextId('products');
  await products.insertOne({ id, ...values, version: 1, units: 0, sales_revenue: 0, created_at: now() });
  res.redirect('/owner');
}));
app.post('/owner/products/:id', protect, csrf, wrap(async (req, res) => {
  const values = productInput(req.body, req.body.active ? 1 : 0);
  const id = Number(req.params.id), version = Number(req.body.version);
  if (!values || !Number.isSafeInteger(id) || !Number.isSafeInteger(version)) return res.sendStatus(400);
  const result = await products.updateOne({ id, version }, { $set: values, $inc: { version: 1 } });
  if (!result.matchedCount) return errorPage(res, 'Please refresh', 'Product changed; reload before saving.', 409);
  res.redirect('/owner');
}));
app.post('/owner/orders/:id', protect, csrf, wrap(async (req, res) => {
  if (!['new', 'confirmed', 'shipped', 'completed', 'cancelled'].includes(req.body.status)) return res.sendStatus(400);
  const result = await orders.updateOne({ id: Number(req.params.id) }, { $set: { status: req.body.status } });
  if (!result.matchedCount) return res.sendStatus(404);
  res.redirect('/owner');
}));
app.get('/owner/orders/:id', protect, wrap(async (req, res) => {
  const order = await orders.findOne({ id: Number(req.params.id) });
  if (!order) return res.sendStatus(404);
  render(res, 'order.html', { order, items: order.items });
}));
app.get('/account/login', (req, res) => errorPage(res, 'Customer login is being prepared', 'Please continue shopping as a guest while we finish connecting accounts.', 503));
app.get('/account', (req, res) => res.redirect('/account/login'));
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
    orders.createIndex({ id: -1 }), categories.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })]);
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  init().then(() => app.listen(Number(process.env.PORT || 5050), '127.0.0.1', () => console.log(`Happy Knots at http://127.0.0.1:${process.env.PORT || 5050}`))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { app, connection, database };

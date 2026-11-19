import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import nunjucks from 'nunjucks';
import { GridFSBucket, MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
import * as oidc from 'openid-client';
import QRCode from 'qrcode';
import { INDIAN_STATES_AND_UTS, parseAddress, isCompleteAddress, formatAddress } from './address.js';
import { verifyRecaptcha } from './recaptcha.js';
import { shippingPaise, FREE_SHIPPING_THRESHOLD_PAISE, STANDARD_SHIPPING_PAISE } from './shipping.js';
import { searchProducts } from './search.js';
import { checkoutSelection, discountPercent, pricedLines, withOrderItemImages } from './catalog-options.js';
import { createLiveOrder, createTestOrder, fetchLivePayment, fetchTestPayment, isCapturedPayment, liveCredentials, testCredentials, verifyPaymentSignature, verifyWebhookSignature } from './razorpay.js';
import { appBaseUrl } from './base-url.js';
import { isOrderStatus, isOwner, ORDER_STATUSES } from './owner-access.js';
import { ownerProductDraft, ownerProductUpdateDraft } from './owner-product.js';
import { orderAnalytics } from './analytics.js';
import { decryptValue, encryptValue } from './secure-data.js';
import { generateTotpSecret, totpUri, verifyTotp } from './owner-mfa.js';
import { reviewDraft, reviewerDisplayName, reviewSummary } from './reviews.js';
import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, SITE_UPDATED, CONTACT_EMAIL, FAQS, JOURNAL_PATH, seoFor, organizationSchema, websiteSchema, faqSchema, productSchema, breadcrumbSchema, robotsText, sitemapXml, rssXml, googleProductsXml, llmsText } from './seo.js';

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
const onlinePayments = database.collection('razorpay_online_payments');
const razorpayWebhookEvents = database.collection('razorpay_webhook_events');
const ownerMfa = database.collection('owner_mfa');
const ownerAudit = database.collection('owner_security_audit');
const reviews = database.collection('product_reviews');
const productImages = new GridFSBucket(database, { bucketName: 'product_images' });
const catalogDrafts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'database/product-drafts.json'), 'utf8'));
const env = nunjucks.configure(path.join(projectRoot, 'frontend', 'templates'), { autoescape: true, noCache: process.env.NODE_ENV !== 'production' });
const render = (res, name, data = {}) => res.send(env.render(name, {
  csrf: res.locals.csrf, customer: res.locals.customer, is_owner: isOwner(res.locals.customer),
  ...seoFor(res.req.path, data), ...data
}));
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
app.get('/googlea51508c5e38f5282.html', (_req, res) => res.sendFile(path.join(projectRoot, 'frontend', 'static', 'googlea51508c5e38f5282.html')));
app.get('/robots.txt', (_req, res) => res.type('text/plain').set({ 'Cache-Control': 'public, max-age=60, must-revalidate', 'X-Robots-Tag': 'noindex' }).send(robotsText()));
const random = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const sign = value => `${value}.${crypto.createHmac('sha256', process.env.FLASK_SECRET_KEY).update(value).digest('base64url')}`;
const unsign = value => { if (!value) return null; const index = value.lastIndexOf('.'); const raw = value.slice(0, index); return index > 0 && equal(sign(raw), value) ? raw : null; };
const sessionDays = Math.min(Math.max(Number(process.env.SESSION_DAYS) || 30, 1), 30);
const sessionLifetime = sessionDays * 86400000;
const ownerMfaLifetime = 12 * 60 * 60 * 1000;
const encryptedRefresh = token => encryptValue(token, process.env.FLASK_SECRET_KEY, 'cognito-refresh-token');
const decryptedRefresh = token => decryptValue(token, process.env.FLASK_SECRET_KEY, 'cognito-refresh-token');
const encryptedMfa = secret => encryptValue(secret, process.env.FLASK_SECRET_KEY, 'owner-mfa-secret');
const decryptedMfa = secret => decryptValue(secret, process.env.FLASK_SECRET_KEY, 'owner-mfa-secret');
async function auditOwner(event, req, details = {}) {
  const customer = resCustomer(req);
  await ownerAudit.insertOne({
    event, owner_email: customer?.email || null, customer_sub: customer?.sub || null,
    ip: String(req.ip || req.socket.remoteAddress || '').slice(0, 100),
    user_agent: String(req.get('user-agent') || '').slice(0, 300), details, created_at: now()
  });
}
const resCustomer = req => req.login?.customer || null;
app.use(async (req, res, next) => {
  try {
    const sid = unsign(req.cookies.hk_session);
    let row = sid ? await sessions.findOne({ _id: digest(sid), expires_at: { $gt: new Date() } }) : null;
    if (row?.customer && row.auth_expires_at <= Date.now() && row.refresh_token_encrypted && row.refresh_expires_at > Date.now()) {
      try {
        const refreshToken = decryptedRefresh(row.refresh_token_encrypted);
        const config = await cognito();
        if (!config) throw new Error('Cognito is not configured');
        const tokens = await oidc.refreshTokenGrant(config, refreshToken);
        const replacement = tokens.refresh_token || refreshToken;
        const accessLifetime = Math.min((tokens.expiresIn() || 3600) * 1000, 3600000);
        const update = {
          auth_expires_at: Date.now() + accessLifetime,
          refresh_token_encrypted: encryptedRefresh(replacement),
          refreshed_at: now()
        };
        await sessions.updateOne({ _id: row._id }, { $set: update });
        row = { ...row, ...update };
      } catch (error) {
        console.warn('Session refresh failed', error?.code || error?.message || 'unknown');
        await sessions.deleteOne({ _id: row._id });
        row = null;
      }
    }
    if (!row && req.cookies.hk_session) res.clearCookie('hk_session');
    req.sid = row ? sid : null; req.login = row || {}; res.locals.csrf = row?.csrf;
    res.locals.customer = row?.customer && row.auth_expires_at > Date.now() ? row.customer : null;
    next();
  } catch (error) { next(error); }
});
const customerOnly = (req, res, next) => res.locals.customer ? next() : res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl));
const ownerIdentityOnly = (req, res, next) => {
  if (!res.locals.customer) return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl));
  if (!isOwner(res.locals.customer)) {
    auditOwner('owner_access_denied', req, { path: req.originalUrl }).catch(() => {});
    return res.sendStatus(404);
  }
  res.set('Cache-Control', 'private, no-store');
  next();
};
const ownerOnly = (req, res, next) => ownerIdentityOnly(req, res, async () => {
  try {
    if (!req.login.owner_mfa_verified_at || Date.now() - req.login.owner_mfa_verified_at > ownerMfaLifetime)
      return res.redirect('/owner/mfa?next=' + encodeURIComponent(req.originalUrl));
    next();
  } catch (error) { next(error); }
});
const testPaymentsReady = () => {
  if (process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || process.env.RAZORPAY_TEST_CHECKOUT !== 'true') return false;
  try { testCredentials(); return true; } catch { return false; }
};
const testPaymentsOnly = (_req, res, next) => testPaymentsReady() ? next() : res.sendStatus(404);
const livePaymentsReady = () => {
  try { return !!process.env.RAZORPAY_WEBHOOK_SECRET && !!liveCredentials(); } catch { return false; }
};
const livePaymentsOnly = (_req, res, next) => livePaymentsReady() ? next() : res.sendStatus(404);
const csrf = (req, res, next) => equal(req.body.csrf, req.login.csrf) ? next() : res.sendStatus(400);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const now = () => new Date().toISOString();
const errorPage = (res, title, message, status = 200) => res.status(status).send(env.render('message.html', { title, message, csrf: res.locals.csrf }));
async function nextId(name, session) {
  const result = await counters.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  return result.value;
}

async function finaliseOnlinePayment(paymentRecord, razorpayPayment, changedBy = 'razorpay') {
  let orderId;
  const transaction = connection.startSession();
  try {
    await transaction.withTransaction(async () => {
      const current = await onlinePayments.findOne({ _id: paymentRecord._id }, { session: transaction });
      if (!current) throw Object.assign(new Error('Payment record was not found'), { status: 404 });
      if (current.status === 'paid' && current.order_id) { orderId = current.order_id; return; }
      if (current.status !== 'pending' || current.razorpay_order_id !== razorpayPayment.order_id ||
          current.amount_paise !== razorpayPayment.amount || razorpayPayment.status !== 'captured')
        throw Object.assign(new Error('Payment could not be confirmed'), { status: 409 });
      orderId = await nextId('orders', transaction);
      const createdAt = now();
      await orders.insertOne({
        id: orderId, customer_sub: current.customer_sub, customer_name: current.customer.name,
        email: current.customer.email, phone: current.customer.phone, address: current.customer.address,
        address_line1: current.customer.address_line1, address_line2: current.customer.address_line2,
        landmark: current.customer.landmark, city: current.customer.city, state: current.customer.state,
        pincode: current.customer.pincode, subtotal_paise: current.subtotal_paise,
        shipping_paise: current.shipping_paise, total_paise: current.amount_paise, status: 'new',
        status_history: [{ status: 'new', changed_at: createdAt, changed_by: changedBy }],
        payment_method: 'razorpay', payment_status: 'paid', razorpay_order_id: current.razorpay_order_id,
        razorpay_payment_id: razorpayPayment.id, paid_at: createdAt, created_at: createdAt, items: current.items
      }, { session: transaction });
      const quantities = new Map();
      for (const item of current.items) quantities.set(item.product_id, (quantities.get(item.product_id) || 0) + item.quantity);
      for (const [productId, quantity] of quantities) {
        const revenue = current.items.filter(item => item.product_id === productId).reduce((sum, item) => sum + item.unit_price_paise * item.quantity, 0);
        const result = await products.updateOne({ id: productId, active: 1, stock: { $gte: quantity } },
          { $inc: { stock: -quantity, version: 1, units: quantity, sales_revenue: revenue } }, { session: transaction });
        if (result.matchedCount !== 1) throw Object.assign(new Error('A paid item is no longer available'), { status: 409 });
      }
      await stats.updateOne({ _id: 'shop' }, { $inc: { orders: 1, revenue: current.amount_paise } }, { upsert: true, session: transaction });
      await categories.updateOne({ email: current.customer.email }, { $set: { customer_name: current.customer.name }, $inc: { orders: 1, spent: current.amount_paise } }, { upsert: true, session: transaction });
      const completed = await onlinePayments.updateOne({ _id: current._id, status: 'pending' }, {
        $set: { status: 'paid', order_id: orderId, razorpay_payment_id: razorpayPayment.id, paid_at: createdAt },
        $unset: { expires_at: '' }
      }, { session: transaction });
      if (completed.modifiedCount !== 1) throw new Error('Payment was finalised concurrently');
    });
  } finally { await transaction.endSession(); }
  return orderId;
}
function catalogProduct(row) {
  const variants = row.price_options || row.style_options || [];
  return {
    sku: row.sku, name: row.name, category: row.category, tags: [row.category], keywords: Array.isArray(row.keywords) ? row.keywords : [], description: row.description,
    image: row.images[0], images: row.images,
    variants: variants.map(v => ({ code: v.code, label: v.label, image: v.image || row.images[0], price_paise: v.price_paise || row.price_paise, compare_at_paise: v.compare_at_paise || row.compare_at_paise })),
    price_paise: row.price_paise, compare_at_paise: row.compare_at_paise,
    personalisation: row.personalisation || null, badge: row.badge || null,
    made_to_order: true, stock: 9999, active: 1, version: 1, units: 0, sales_revenue: 0
  };
}
function storeProductImage(image, filename) {
  return new Promise((resolve, reject) => {
    const stream = productImages.openUploadStream(filename, { contentType: image.contentType, metadata: { purpose: 'product' } });
    stream.once('error', reject);
    stream.once('finish', () => resolve(stream.id));
    stream.end(image.buffer);
  });
}
async function deleteStoredProductImages(urls) {
  const ids = (Array.isArray(urls) ? urls : []).map(url => String(url).match(/^\/media\/products\/([a-f0-9]{24})$/i)?.[1]).filter(Boolean);
  await Promise.allSettled(ids.map(id => productImages.delete(new ObjectId(id))));
}
async function publishInitialCatalog() {
  const migration = database.collection('migration');
  const markerId = 'product-catalog-2026-11-18';
  const transaction = connection.startSession();
  try {
    await transaction.withTransaction(async () => {
      if (!await migration.findOne({ _id: markerId }, { session: transaction })) {
        const highest = await products.find({}, { session: transaction }).sort({ id: -1 }).limit(1).next();
        await counters.updateOne({ _id: 'products' }, { $max: { value: highest?.id || 0 } }, { upsert: true, session: transaction });
        for (const row of catalogDrafts) {
          if (await products.findOne({ sku: row.sku }, { session: transaction })) continue;
          const id = await nextId('products', transaction);
          await products.insertOne({ ...catalogProduct(row), id }, { session: transaction });
        }
        await migration.insertOne({ _id: markerId, state: 'READY', product_count: catalogDrafts.length, created_at: now() }, { session: transaction });
      }
      const doilyMarker = 'merge-round-doily-colours-2026-11-18';
      if (!await migration.findOne({ _id: doilyMarker }, { session: transaction })) {
        const row = catalogDrafts.find(item => item.sku === 'orange-cream-crochet-doily');
        const update = catalogProduct(row);
        delete update.units;
        delete update.sales_revenue;
        delete update.version;
        await products.updateOne({ sku: row.sku }, { $set: update, $inc: { version: 1 } }, { session: transaction });
        await products.updateOne({ sku: 'gold-red-crochet-doily' }, { $set: { active: 0 }, $inc: { version: 1 } }, { session: transaction });
        await migration.insertOne({ _id: doilyMarker, state: 'READY', created_at: now() }, { session: transaction });
      }
      const keywordMarker = 'catalog-search-keywords-2026-11-19';
      if (!await migration.findOne({ _id: keywordMarker }, { session: transaction })) {
        for (const row of catalogDrafts) {
          await products.updateOne({ sku: row.sku }, { $set: { keywords: Array.isArray(row.keywords) ? row.keywords : [] } }, { session: transaction });
        }
        await migration.insertOne({ _id: keywordMarker, state: 'READY', created_at: now() }, { session: transaction });
      }
    });
  } finally { await transaction.endSession(); }
}
async function catalog() { return products.find({ active: 1 }).project({ id: 1, name: 1, tags: 1, keywords: 1, category: 1, description: 1, price_paise: 1, compare_at_paise: 1, image: 1, images: 1, variants: 1, personalisation: 1, badge: 1, made_to_order: 1, stock: 1 }).sort({ id: -1 }).toArray(); }
const tagNames = ['Personal Accessories & Clothing', 'Door Hangings', 'Wall Hangings', 'Home Decor'];
const tagsFor = p => Array.isArray(p.tags) ? p.tags.filter(t => tagNames.includes(t)) : tagNames.includes(p.category) ? [p.category] : [];
const publicProduct = p => ({ id: p.id, name: p.name, tags: tagsFor(p), keywords: Array.isArray(p.keywords) ? p.keywords : [], description: p.description, price_paise: p.price_paise, compare_at_paise: p.compare_at_paise > p.price_paise ? p.compare_at_paise : null, discount_percent: discountPercent(p.price_paise, p.compare_at_paise), image: p.image, images: Array.isArray(p.images) ? p.images : [], variants: Array.isArray(p.variants) ? p.variants.map(v => ({ ...v, discount_percent: discountPercent(v.price_paise, v.compare_at_paise) })) : [], personalisation: p.personalisation || null, badge: p.badge || null, made_to_order: !!p.made_to_order, stock: p.stock });
const schemaGraph = (...nodes) => ({ '@context': 'https://schema.org', '@graph': nodes });
let cachedSitemap = sitemapXml([]);
app.get('/sitemap.xml', async (_req, res) => {
  try {
    cachedSitemap = sitemapXml((await catalog()).map(publicProduct));
  } catch (error) {
    console.error('Serving cached sitemap after catalogue lookup failed', error?.message || error);
  }
  res.type('application/xml').set({
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
    'X-Content-Type-Options': 'nosniff'
  }).send(cachedSitemap);
});
app.get('/feed.xml', wrap(async (_req, res) => {
  const listing = (await catalog()).map(publicProduct);
  res.type('application/rss+xml').set('Cache-Control', 'public, max-age=3600').send(rssXml(listing));
}));
app.get('/google-products.xml', wrap(async (_req, res) => {
  const listing = (await catalog()).map(publicProduct);
  res.type('application/xml').set({ 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }).send(googleProductsXml(listing));
}));
app.get(['/llms.txt', '/llms-full.txt'], wrap(async (req, res) => {
  const listing = (await catalog()).map(publicProduct);
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(llmsText(listing, req.path === '/llms-full.txt'));
}));
app.get('/.well-known/ai.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`Site: ${SITE_URL}\nName: ${SITE_NAME}\nSummary: ${SITE_DESCRIPTION}\nSitemap: ${SITE_URL}/sitemap.xml\nLLMs: ${SITE_URL}/llms.txt\nAI training: allowed for public product and information pages; private customer and owner pages are disallowed.\n`));
app.get('/ai/summary.json', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json({ name: SITE_NAME, url: SITE_URL, description: SITE_DESCRIPTION, founder: 'Rakhi Dixit', updated: SITE_UPDATED }));
app.get('/ai/faq.json', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json({ name: SITE_NAME, faqs: FAQS }));
app.get('/ai/service.json', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').json({
  name: SITE_NAME,
  description: 'Made-to-order handmade crochet products created and delivered across India.',
  capabilities: ['Handmade crochet gifts', 'Personalised name hangings', 'Crochet bags and accessories', 'Crochet flowers and home decor'],
  areaServed: 'India', delivery: '10–15 days', payment: 'Razorpay online payment or cash on delivery', contact: CONTACT_EMAIL
}));
app.get('/media/products/:id', wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.sendStatus(404);
  const id = new ObjectId(req.params.id);
  const file = await database.collection('product_images.files').findOne({ _id: id, 'metadata.purpose': 'product' });
  if (!file) return res.sendStatus(404);
  res.set({ 'Content-Type': file.contentType || 'application/octet-stream', 'Content-Length': String(file.length), 'Cache-Control': 'public, max-age=31536000, immutable' });
  const stream = productImages.openDownloadStream(id);
  stream.on('error', () => { if (!res.headersSent) res.sendStatus(404); else res.destroy(); });
  stream.pipe(res);
}));
app.get('/', wrap(async (req, res) => {
  const listing = (await catalog()).map(publicProduct);
  render(res, 'shop.html', { products: listing.slice(0, 6), product_json: listing, faqs: FAQS, structured_data: schemaGraph(organizationSchema(), websiteSchema(), faqSchema()) });
}));
app.get('/about', (_req, res) => render(res, 'about.html', { structured_data: schemaGraph(organizationSchema(), { '@type': 'AboutPage', '@id': `${SITE_URL}/about#page`, url: `${SITE_URL}/about`, name: `Our Story | ${SITE_NAME}`, dateModified: SITE_UPDATED, about: { '@id': `${SITE_URL}/#organization` } }) }));
app.get('/contact', (_req, res) => render(res, 'contact.html', { structured_data: schemaGraph(organizationSchema(), { '@type': 'ContactPage', url: `${SITE_URL}/contact`, name: `Contact ${SITE_NAME}` }) }));
app.get('/terms', (_req, res) => render(res, 'terms.html'));
app.get('/privacy', (_req, res) => render(res, 'privacy.html'));
app.get('/shipping', (_req, res) => render(res, 'shipping.html'));
app.get('/returns', (_req, res) => render(res, 'returns.html'));
app.get(JOURNAL_PATH, (_req, res) => render(res, 'gift_guide.html', { structured_data: schemaGraph(organizationSchema(), { '@type': 'Article', headline: 'Handmade Crochet Gift Guide for Every Occasion', description: 'A practical guide to choosing handmade crochet gifts in India.', image: `${SITE_URL}/static/assets/featured/lotus-crochet-flowers.webp`, author: { '@type': 'Person', name: 'Rakhi Dixit' }, publisher: { '@id': `${SITE_URL}/#organization` }, datePublished: SITE_UPDATED, dateModified: SITE_UPDATED, mainEntityOfPage: `${SITE_URL}${JOURNAL_PATH}` }) }));
app.get('/shop', wrap(async (req, res) => {
  const listing = (await catalog()).map(publicProduct);
  const tag = tagNames.includes(req.query.category) ? req.query.category : null;
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const filtered = searchProducts(tag ? listing.filter(p => p.tags.includes(tag)) : listing, searchQuery);
  render(res, 'catalog.html', { products: filtered, product_json: listing, tags: tagNames, selected_tag: tag, search_query: searchQuery, structured_data: schemaGraph(organizationSchema(), { '@type': 'CollectionPage', url: `${SITE_URL}/shop`, name: 'Handmade crochet products', description: 'Made-to-order crochet bags, flowers, accessories and home decor.', mainEntity: { '@type': 'ItemList', itemListElement: filtered.map((product, index) => ({ '@type': 'ListItem', position: index + 1, url: `${SITE_URL}/products/${product.id}`, name: product.name })) } }) });
}));
app.get('/products/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const [product, listing] = await Promise.all([
    products.findOne({ id, active: 1 }, { projection: { id: 1, name: 1, tags: 1, category: 1, description: 1, price_paise: 1, compare_at_paise: 1, image: 1, images: 1, variants: 1, personalisation: 1, badge: 1, made_to_order: 1, stock: 1 } }),
    catalog()
  ]);
  if (!product) return res.sendStatus(404);
  const publicItem = publicProduct(product);
  const customer = res.locals.customer;
  const [publishedReviews, customerReview, deliveredOrder] = await Promise.all([
    reviews.find({ product_id: id, status: 'approved' }).project({ rating: 1, comment: 1, display_name: 1, created_at: 1 }).sort({ created_at: -1 }).limit(100).toArray(),
    customer ? reviews.findOne({ product_id: id, customer_sub: customer.sub }, { projection: { status: 1 } }) : null,
    customer ? orders.findOne({ customer_sub: customer.sub, status: 'delivered', 'items.product_id': id }, { projection: { id: 1 } }) : null
  ]);
  const summary = reviewSummary(publishedReviews);
  const publicReviews = publishedReviews.map(review => ({ ...review, stars: '★'.repeat(review.rating) }));
  render(res, 'product.html', {
    product: publicItem, product_json: listing.map(publicProduct), reviews: publicReviews, review_summary: summary,
    can_review: !!deliveredOrder && !customerReview, review_state: customerReview?.status || '', review_submitted: req.query.review === 'pending',
    structured_data: schemaGraph(organizationSchema(), productSchema(publicItem, { reviews: publishedReviews, summary }), breadcrumbSchema(publicItem))
  });
}));
app.post('/products/:id/reviews', customerOnly, csrf, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const draft = reviewDraft(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !draft) return errorPage(res, 'Check your review', 'Choose a rating and write at least 10 characters about the product.', 400);
  const [product, deliveredOrder] = await Promise.all([
    products.findOne({ id, active: 1 }, { projection: { id: 1, name: 1 } }),
    orders.findOne({ customer_sub: res.locals.customer.sub, status: 'delivered', 'items.product_id': id }, { projection: { id: 1, customer_name: 1 } })
  ]);
  if (!product || !deliveredOrder) return res.sendStatus(403);
  try {
    await reviews.insertOne({
      product_id: id, product_name: product.name, customer_sub: res.locals.customer.sub,
      display_name: reviewerDisplayName(deliveredOrder.customer_name), rating: draft.rating, comment: draft.comment,
      verified_purchase: true, order_id: deliveredOrder.id, status: 'pending', created_at: now()
    });
  } catch (error) {
    if (error.code === 11000) return errorPage(res, 'Review already received', 'You have already reviewed this product.', 409);
    throw error;
  }
  res.redirect(`/products/${id}?review=pending#reviews`);
}));
app.get('/checkout', customerOnly, wrap(async (req, res) => {
  const [profile, listing] = await Promise.all([
    customers.findOne({ _id: res.locals.customer.sub }, { projection: { addresses: 1 } }),
    catalog()
  ]);
  render(res, 'checkout.html', { profile: { addresses: (profile?.addresses || []).filter(isCompleteAddress) }, product_json: listing.map(publicProduct), checkout_token: sign(random()), shipping_threshold_paise: FREE_SHIPPING_THRESHOLD_PAISE, standard_shipping_paise: STANDARD_SHIPPING_PAISE, razorpay_live_checkout: livePaymentsReady(), razorpay_test_checkout: testPaymentsReady() });
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
app.post('/payments/razorpay/start', livePaymentsOnly, customerOnly, csrf, wrap(async (req, res) => {
  const rawCheckoutToken = unsign(req.body.checkout_token);
  if (!rawCheckoutToken) return res.sendStatus(400);
  const profile = await customers.findOne({ _id: res.locals.customer.sub }, { projection: { addresses: 1 } });
  const address = profile?.addresses?.find(a => a.address_id === req.body.address_id);
  if (!isCompleteAddress(address)) return errorPage(res, 'Complete delivery address required', 'Save and select a complete delivery address before paying.', 400);
  let submitted;
  try { submitted = JSON.parse(req.body.items || '[]'); } catch { return res.sendStatus(400); }
  const selection = checkoutSelection(submitted);
  if (!selection?.lines.length) return res.sendStatus(400);
  const selected = await products.find({ id: { $in: [...selection.totals.keys()] } }).toArray();
  const items = pricedLines(selected, selection);
  if (!items) return errorPage(res, 'Bag changed', 'An item is no longer available in that quantity. Please review your bag.', 409);
  const subtotal = items.reduce((sum, item) => sum + item.unit_price_paise * item.quantity, 0);
  const shipping = shippingPaise(subtotal);
  const amountPaise = subtotal + shipping;
  const receiptKey = digest(req.body.checkout_token);
  const previous = await onlinePayments.findOne({ checkout_receipt_key: receiptKey, customer_sub: res.locals.customer.sub, status: 'pending' });
  if (previous) return res.redirect(`/payments/razorpay/${previous.public_token}`);
  const token = random();
  const publicToken = token.slice(0, 32);
  const razorpayOrder = await createLiveOrder({ amountPaise, receipt: `hk_${crypto.randomBytes(12).toString('hex')}` });
  const customer = {
    name: address.name, email: res.locals.customer.email, phone: address.phone,
    address_line1: address.address_line1, address_line2: address.address_line2,
    landmark: address.landmark, city: address.city, state: address.state,
    pincode: address.pincode, address: formatAddress(address)
  };
  await onlinePayments.insertOne({
    _id: digest(token), public_token: publicToken, checkout_receipt_key: receiptKey,
    customer_sub: res.locals.customer.sub, customer, items, subtotal_paise: subtotal,
    shipping_paise: shipping, amount_paise: amountPaise, razorpay_order_id: razorpayOrder.id,
    status: 'pending', created_at: now(), expires_at: new Date(Date.now() + 7 * 86400000)
  });
  res.cookie('hk_payment_token', sign(token), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 });
  res.redirect(`/payments/razorpay/${publicToken}`);
}));
app.get('/payments/razorpay/:token', livePaymentsOnly, customerOnly, wrap(async (req, res) => {
  const secretToken = unsign(req.cookies.hk_payment_token);
  const payment = secretToken ? await onlinePayments.findOne({ _id: digest(secretToken), public_token: req.params.token, customer_sub: res.locals.customer.sub }) : null;
  if (!payment) return res.sendStatus(404);
  if (payment.status === 'paid' && payment.order_id) return res.redirect(`/account/orders/${payment.order_id}`);
  if (payment.status !== 'pending' || payment.expires_at <= new Date()) return errorPage(res, 'Payment session expired', 'Return to checkout to start a new secure payment.', 410);
  render(res, 'live-payment.html', { payment, token: req.params.token, key_id: liveCredentials().keyId });
}));
app.post('/payments/razorpay/:token/verify', livePaymentsOnly, customerOnly, csrf, wrap(async (req, res) => {
  const secretToken = unsign(req.cookies.hk_payment_token);
  const pending = secretToken ? await onlinePayments.findOne({ _id: digest(secretToken), public_token: req.params.token, customer_sub: res.locals.customer.sub }) : null;
  if (!pending) return res.sendStatus(404);
  if (pending.status === 'paid' && pending.order_id) return res.redirect(`/account/orders/${pending.order_id}`);
  const credentials = liveCredentials();
  if (pending.status !== 'pending' || req.body.razorpay_order_id !== pending.razorpay_order_id ||
      !verifyPaymentSignature({ orderId: pending.razorpay_order_id, paymentId: req.body.razorpay_payment_id, signature: req.body.razorpay_signature }, credentials.keySecret))
    return res.sendStatus(400);
  const payment = await fetchLivePayment(req.body.razorpay_payment_id, credentials);
  if (!isCapturedPayment(payment, { orderId: pending.razorpay_order_id, paymentId: req.body.razorpay_payment_id, amountPaise: pending.amount_paise }))
    return errorPage(res, 'Payment confirmation pending', 'We have not received a captured-payment confirmation yet. Your order will appear automatically after Razorpay confirms it.', 409);
  const orderId = await finaliseOnlinePayment(pending, payment);
  res.cookie('hk_checkout_success', sign(String(orderId)), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60000 });
  res.clearCookie('hk_payment_token');
  res.redirect(`/account/orders/${orderId}`);
}));
app.post('/webhooks/razorpay', express.raw({ type: 'application/json', limit: '512kb' }), wrap(async (req, res) => {
  if (!livePaymentsReady() || !Buffer.isBuffer(req.body)) return res.sendStatus(404);
  const signature = req.get('x-razorpay-signature');
  if (!verifyWebhookSignature(req.body, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) return res.sendStatus(400);
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (!['payment.captured', 'order.paid'].includes(event?.event)) return res.sendStatus(204);
  const entity = event?.payload?.payment?.entity;
  if (!entity?.id || !entity?.order_id) return res.sendStatus(400);
  const pending = await onlinePayments.findOne({ razorpay_order_id: entity.order_id });
  if (!pending) return res.sendStatus(204);
  const payment = await fetchLivePayment(entity.id);
  if (!isCapturedPayment(payment, { orderId: pending.razorpay_order_id, paymentId: entity.id, amountPaise: pending.amount_paise })) return res.sendStatus(409);
  await finaliseOnlinePayment(pending, payment, 'razorpay_webhook');
  const eventId = String(req.get('x-razorpay-event-id') || '').slice(0, 200);
  if (eventId) await razorpayWebhookEvents.updateOne({ _id: eventId }, { $setOnInsert: { event: event.event, payment_id: entity.id, received_at: new Date() } }, { upsert: true });
  res.sendStatus(204);
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
      const createdAt = now();
      await orders.insertOne({ id: orderId, customer_sub: res.locals.customer.sub, customer_name: customer.name, email: customer.email, phone: customer.phone,
        address: customer.address, address_line1: customer.address_line1, address_line2: customer.address_line2,
        landmark: customer.landmark, city: customer.city, state: customer.state, pincode: customer.pincode,
        subtotal_paise: subtotal, shipping_paise: shipping, total_paise: total, status: 'new', status_history: [{ status: 'new', changed_at: createdAt, changed_by: 'customer' }], payment_method: 'cash_on_delivery', created_at: createdAt, items }, { session: transaction });
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
const safeNext = value => typeof value === 'string' && /^\/(?:account|checkout|shop|products|owner)(?:[/?#]|$)/.test(value) && !value.includes(String.fromCharCode(92)) ? value : '/account';
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
  const url = oidc.buildAuthorizationUrl(config, { redirect_uri: `${appBaseUrl()}/account/callback`, scope: 'openid email', response_type: 'code', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
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
    hostname: new URL(appBaseUrl()).hostname
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
  const tokens = await oidc.authorizationCodeGrant(config, new URL(req.originalUrl, appBaseUrl()), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims?.sub || !claims.email || claims.email_verified !== true) return errorPage(res, 'Email verification required', 'Please verify your email before signing in.', 403);
  const customer = { sub: claims.sub, email: claims.email };
  await customers.updateOne({ _id: customer.sub }, { $set: { email: customer.email, updated_at: now() }, $setOnInsert: { addresses: [], created_at: now() } }, { upsert: true });
  const sid = random();
  const lifetime = Math.min((tokens.expiresIn() || 3600) * 1000, 3600000);
  const refreshToken = tokens.refresh_token;
  const persistedLifetime = refreshToken ? sessionLifetime : lifetime;
  await sessions.insertOne({
    _id: digest(sid), csrf: random(), customer, auth_expires_at: Date.now() + lifetime,
    refresh_token_encrypted: refreshToken ? encryptedRefresh(refreshToken) : null,
    refresh_expires_at: refreshToken ? Date.now() + sessionLifetime : null,
    expires_at: new Date(Date.now() + persistedLifetime)
  });
  await sessions.deleteOne({ _id: digest(req.sid) });
  req.login.customer = customer;
  if (isOwner(customer)) await auditOwner('owner_identity_authenticated', req, { provider: claims.identities ? 'federated' : 'cognito' });
  res.cookie('hk_session', sign(sid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: persistedLifetime });
  res.redirect(flow.next);
}));
app.post('/account/logout', csrf, wrap(async (req, res) => {
  if (isOwner(res.locals.customer)) await auditOwner('owner_logout', req);
  if (req.login.refresh_token_encrypted && authReady()) {
    try {
      const config = await cognito();
      await oidc.tokenRevocation(config, decryptedRefresh(req.login.refresh_token_encrypted), { token_type_hint: 'refresh_token' });
    } catch (error) { console.warn('Refresh token revocation failed', error?.code || error?.message || 'unknown'); }
  }
  await sessions.deleteOne({ _id: digest(req.sid) });
  res.clearCookie('hk_session');
  if (authReady()) {
    const url = new URL('/logout', process.env.COGNITO_DOMAIN);
    url.searchParams.set('client_id', process.env.COGNITO_CLIENT_ID);
    url.searchParams.set('logout_uri', appBaseUrl());
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
    orders.find(orderFilter).project({ id: 1, created_at: 1, status: 1, subtotal_paise: 1, total_paise: 1, items: 1 }).sort({ id: -1 }).limit(31).toArray()
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
const safeOwnerNext = value => typeof value === 'string' && /^\/owner(?:[/?#]|$)/.test(value) && !value.includes(String.fromCharCode(92)) ? value : '/owner';
app.get('/owner/mfa', ownerIdentityOnly, wrap(async (req, res) => {
  if (req.login.owner_mfa_verified_at && Date.now() - req.login.owner_mfa_verified_at <= ownerMfaLifetime)
    return res.redirect(safeOwnerNext(req.query.next));
  const ownerKey = res.locals.customer.email.trim().toLowerCase();
  const record = await ownerMfa.findOne({ _id: ownerKey });
  let secret;
  if (record?.secret_encrypted) secret = decryptedMfa(record.secret_encrypted);
  else if (req.login.owner_mfa_pending?.expires_at > Date.now()) secret = decryptedMfa(req.login.owner_mfa_pending.secret_encrypted);
  else {
    secret = generateTotpSecret();
    await sessions.updateOne({ _id: digest(req.sid) }, { $set: { owner_mfa_pending: { secret_encrypted: encryptedMfa(secret), expires_at: Date.now() + 10 * 60000 } } });
  }
  const enrolling = !record?.secret_encrypted;
  const qr = enrolling ? await QRCode.toDataURL(totpUri(secret, res.locals.customer.email), { errorCorrectionLevel: 'M', margin: 1, width: 260 }) : null;
  render(res, 'owner_mfa.html', { enrolling, qr, manual_secret: enrolling ? secret.match(/.{1,4}/g).join(' ') : null, next: safeOwnerNext(req.query.next) });
}));
app.post('/owner/mfa', ownerIdentityOnly, csrf, wrap(async (req, res) => {
  const next = safeOwnerNext(req.body.next);
  if (req.login.owner_mfa_blocked_until > Date.now())
    return res.status(429).send(env.render('owner_mfa.html', { enrolling: false, next, error: 'Too many incorrect codes. Please wait ten minutes and try again.', csrf: res.locals.csrf, customer: res.locals.customer }));
  const ownerKey = res.locals.customer.email.trim().toLowerCase();
  const record = await ownerMfa.findOne({ _id: ownerKey });
  const pending = req.login.owner_mfa_pending;
  const encrypted = record?.secret_encrypted || (pending?.expires_at > Date.now() ? pending.secret_encrypted : null);
  if (!encrypted) return res.redirect('/owner/mfa?next=' + encodeURIComponent(next));
  const valid = verifyTotp(decryptedMfa(encrypted), req.body.code);
  if (!valid) {
    const result = await sessions.findOneAndUpdate({ _id: digest(req.sid) }, { $inc: { owner_mfa_attempts: 1 } }, { returnDocument: 'after' });
    if ((result?.owner_mfa_attempts || 0) >= 5)
      await sessions.updateOne({ _id: digest(req.sid) }, { $set: { owner_mfa_attempts: 0, owner_mfa_blocked_until: Date.now() + 10 * 60000 } });
    await auditOwner('owner_mfa_failed', req);
    const enrolling = !record?.secret_encrypted;
    const secret = decryptedMfa(encrypted);
    const qr = enrolling ? await QRCode.toDataURL(totpUri(secret, res.locals.customer.email), { errorCorrectionLevel: 'M', margin: 1, width: 260 }) : null;
    return res.status(400).send(env.render('owner_mfa.html', { enrolling, qr, manual_secret: enrolling ? secret.match(/.{1,4}/g).join(' ') : null, next, error: 'That code is not valid. Enter the current six-digit code from your authenticator app.', csrf: res.locals.csrf, customer: res.locals.customer }));
  }
  if (!record?.secret_encrypted) {
    await ownerMfa.updateOne({ _id: ownerKey }, { $set: { email: ownerKey, secret_encrypted: encrypted, enrolled_at: now() } }, { upsert: true });
    await auditOwner('owner_mfa_enrolled', req);
  }
  const verifiedAt = Date.now();
  await sessions.updateOne({ _id: digest(req.sid) }, { $set: { owner_mfa_verified_at: verifiedAt, owner_mfa_attempts: 0 }, $unset: { owner_mfa_pending: '', owner_mfa_blocked_until: '' } });
  req.login.owner_mfa_verified_at = verifiedAt;
  await auditOwner('owner_mfa_verified', req);
  res.redirect(next);
}));
app.get('/owner', ownerOnly, wrap(async (req, res) => {
  const before = Number(req.query.before);
  const selectedStatus = isOrderStatus(req.query.status) ? req.query.status : '';
  const filter = selectedStatus ? { status: selectedStatus } : {};
  if (Number.isSafeInteger(before) && before > 0) filter.id = { $lt: before };
  const [history, totalOrders, openOrders, deliveredOrders, orderValue, analyticsRows, listedProducts, securityEvents, productReviews] = await Promise.all([
    orders.find(filter).project({ id: 1, created_at: 1, status: 1, customer_name: 1, email: 1, total_paise: 1, subtotal_paise: 1 }).sort({ id: -1 }).limit(51).toArray(),
    orders.countDocuments(),
    orders.countDocuments({ status: { $nin: ['delivered', 'cancelled'] } }),
    orders.countDocuments({ status: 'delivered' }),
    orders.aggregate([{ $match: { status: { $ne: 'cancelled' } } }, { $group: { _id: null, value: { $sum: { $ifNull: ['$total_paise', '$subtotal_paise'] } } } }]).next(),
    orders.find({ created_at: { $gte: new Date(Date.now() - 370 * 86400000).toISOString() } }).project({ created_at: 1, status: 1, total_paise: 1, subtotal_paise: 1 }).toArray(),
    products.find({ active: 1 }).project({ id: 1, name: 1, image: 1, price_paise: 1, compare_at_paise: 1, category: 1 }).sort({ id: -1 }).limit(100).toArray(),
    ownerAudit.find({}).project({ event: 1, owner_email: 1, details: 1, created_at: 1 }).sort({ _id: -1 }).limit(50).toArray(),
    reviews.find({}).project({ product_id: 1, product_name: 1, display_name: 1, rating: 1, comment: 1, verified_purchase: 1, status: 1, created_at: 1 }).sort({ status: -1, created_at: -1 }).limit(100).toArray()
  ]);
  const page = history.slice(0, 50);
  render(res, 'owner.html', {
    orders: page, statuses: ORDER_STATUSES, selected_status: selectedStatus,
    next_cursor: history.length > 50 ? page.at(-1).id : null,
    overview: { total_orders: totalOrders, open_orders: openOrders, delivered_orders: deliveredOrders, order_value_paise: orderValue?.value || 0 },
    analytics: orderAnalytics(analyticsRows), categories: tagNames, recent_products: listedProducts,
    listed_product_id: Number(req.query.listed) || null, security_events: securityEvents, product_reviews: productReviews
  });
}));
app.post('/owner/reviews/:id/status', ownerOnly, csrf, wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id) || !['approved', 'hidden'].includes(req.body.status)) return res.sendStatus(400);
  const result = await reviews.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: req.body.status, moderated_at: now(), moderated_by: res.locals.customer.email } });
  if (!result.matchedCount) return res.sendStatus(404);
  await auditOwner('review_moderated', req, { review_id: req.params.id, status: req.body.status }).catch(error => console.error('Owner audit failed', error));
  res.redirect('/owner#reviews');
}));
app.post('/owner/products', ownerOnly, express.json({ limit: '28mb' }), csrf, wrap(async (req, res) => {
  const draft = ownerProductDraft(req.body, tagNames);
  if (!draft) return errorPage(res, 'Check the product details', 'Add 1–4 images under 5 MB each. Images are automatically converted to WebP. The regular price must be higher than the selling price.', 400);
  const imageIds = [];
  try {
    for (const [index, image] of draft.images.entries()) imageIds.push(await storeProductImage(image, `product-${Date.now()}-${index}`));
    const imageUrls = imageIds.map(id => `/media/products/${id}`);
    const id = await nextId('products');
    const variants = draft.colors.map((label, index) => ({
      code: `color-${index + 1}`,
      label,
      image: imageUrls[index] || imageUrls[0],
      price_paise: draft.price_paise,
      compare_at_paise: draft.compare_at_paise
    }));
    await products.insertOne({
      id, sku: `owner-${id}`, name: draft.name, category: draft.category, tags: [draft.category], keywords: draft.keywords,
      description: draft.description, image: imageUrls[0], images: imageUrls, variants,
      price_paise: draft.price_paise, compare_at_paise: draft.compare_at_paise,
      personalisation: null, badge: 'New', made_to_order: true, stock: 9999, active: 1, version: 1,
      units: 0, sales_revenue: 0, created_at: now(), created_by: res.locals.customer.email
    });
    await auditOwner('product_listed', req, { product_id: id, product_name: draft.name }).catch(error => console.error('Owner audit failed', error));
    res.json({ ok: true, redirect: `/owner?listed=${id}#products` });
  } catch (error) {
    await Promise.allSettled(imageIds.map(id => productImages.delete(id)));
    throw error;
  }
}));
app.get('/owner/products/:id/edit', ownerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const product = Number.isSafeInteger(id) ? await products.findOne({ id, active: 1 }) : null;
  if (!product) return res.sendStatus(404);
  const colours = Array.isArray(product.variants) ? product.variants.map(variant => variant.label).filter(Boolean) : [];
  render(res, 'owner_product_edit.html', {
    product, categories: tagNames, colours: colours.join(', '), tags: (product.keywords || []).join(', '),
    selling_price: (product.price_paise / 100).toFixed(2).replace(/\.00$/, ''),
    regular_price: (product.compare_at_paise / 100).toFixed(2).replace(/\.00$/, ''),
    saved: req.query.saved === '1'
  });
}));
app.post('/owner/products/:id', ownerOnly, express.json({ limit: '28mb' }), csrf, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = Number.isSafeInteger(id) ? await products.findOne({ id, active: 1 }) : null;
  if (!existing) return res.sendStatus(404);
  if (!Number.isSafeInteger(Number(req.body.version)) || Number(req.body.version) !== existing.version)
    return errorPage(res, 'Product changed', 'This product was updated in another owner session. Reload the edit page before saving again.', 409);
  const draft = ownerProductUpdateDraft(req.body, tagNames);
  if (!draft) return errorPage(res, 'Check the product details', 'Use valid prices, tags and colours. Replacement images are automatically converted to WebP and must remain under 5 MB each.', 400);
  const newImageIds = [];
  try {
    for (const [index, image] of draft.images.entries()) newImageIds.push(await storeProductImage(image, `product-${id}-update-${Date.now()}-${index}`));
    const imageUrls = newImageIds.length ? newImageIds.map(imageId => `/media/products/${imageId}`) : existing.images;
    const variants = draft.colors.map((label, index) => ({
      code: `color-${index + 1}`, label, image: imageUrls[index] || imageUrls[0],
      price_paise: draft.price_paise, compare_at_paise: draft.compare_at_paise
    }));
    const previousColours = Array.isArray(existing.variants) ? existing.variants.map(variant => variant.label).filter(Boolean) : [];
    const changedFields = [];
    if (draft.name !== existing.name) changedFields.push('name');
    if (draft.category !== existing.category) changedFields.push('category');
    if (draft.description !== existing.description) changedFields.push('description');
    if (draft.price_paise !== existing.price_paise) changedFields.push('price');
    if (draft.compare_at_paise !== existing.compare_at_paise) changedFields.push('regular_price');
    if (JSON.stringify(draft.keywords) !== JSON.stringify(existing.keywords || [])) changedFields.push('tags');
    if (JSON.stringify(draft.colors) !== JSON.stringify(previousColours)) changedFields.push('colours');
    if (newImageIds.length) changedFields.push('images');
    const result = await products.updateOne({ id, active: 1, version: existing.version }, { $set: {
      name: draft.name, category: draft.category, tags: [draft.category], keywords: draft.keywords,
      description: draft.description, image: imageUrls[0], images: imageUrls, variants,
      price_paise: draft.price_paise, compare_at_paise: draft.compare_at_paise,
      updated_at: now(), updated_by: res.locals.customer.email
    }, $inc: { version: 1 } });
    if (!result.matchedCount) throw Object.assign(new Error('Product changed in another owner session'), { status: 409 });
    if (newImageIds.length) await deleteStoredProductImages(existing.images);
    await auditOwner('product_updated', req, { product_id: id, product_name: draft.name, changed_fields: changedFields }).catch(error => console.error('Owner audit failed', error));
    res.json({ ok: true, redirect: `/owner/products/${id}/edit?saved=1` });
  } catch (error) {
    await Promise.allSettled(newImageIds.map(imageId => productImages.delete(imageId)));
    throw error;
  }
}));
app.get('/owner/orders/:id', ownerOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const order = Number.isSafeInteger(id) ? await orders.findOne({ id }) : null;
  if (!order) return res.sendStatus(404);
  render(res, 'owner_order.html', { order, statuses: ORDER_STATUSES, updated: req.query.updated === '1' });
}));
app.post('/owner/orders/:id/status', ownerOnly, csrf, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || !isOrderStatus(req.body.status)) return res.sendStatus(400);
  const changedAt = now();
  const result = await orders.updateOne({ id }, {
    $set: { status: req.body.status, updated_at: changedAt },
    $push: { status_history: { status: req.body.status, changed_at: changedAt, changed_by: res.locals.customer.email } }
  });
  if (!result.matchedCount) return res.sendStatus(404);
  await auditOwner('order_status_changed', req, { order_id: id, status: req.body.status }).catch(error => console.error('Owner audit failed', error));
  res.redirect(`/owner/orders/${id}?updated=1`);
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
    onlinePayments.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    onlinePayments.createIndex({ razorpay_order_id: 1 }, { unique: true }),
    onlinePayments.createIndex({ checkout_receipt_key: 1, customer_sub: 1 }, { unique: true }),
    razorpayWebhookEvents.createIndex({ received_at: 1 }, { expireAfterSeconds: 90 * 86400 }),
    loginLimits.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    ownerMfa.createIndex({ email: 1 }, { unique: true }),
    ownerAudit.createIndex({ created_at: -1 }), ownerAudit.createIndex({ owner_email: 1, created_at: -1 }),
    reviews.createIndex({ product_id: 1, status: 1, created_at: -1 }), reviews.createIndex({ product_id: 1, customer_sub: 1 }, { unique: true })]);
  await publishInitialCatalog();
  const missingImageOrders = await orders.find({ items: { $elemMatch: { image: { $exists: false } } } }).project({ id: 1, items: 1 }).toArray();
  if (missingImageOrders.length) {
    const productIds = [...new Set(missingImageOrders.flatMap(order => order.items.map(item => item.product_id).filter(Number.isSafeInteger)))];
    const selected = productIds.length ? await products.find({ id: { $in: productIds } }).project({ id: 1, image: 1, variants: 1 }).toArray() : [];
    await Promise.all(missingImageOrders.map(order => {
      const items = withOrderItemImages(order.items, selected);
      return items.some((item, index) => item.image !== order.items[index].image)
        ? orders.updateOne({ id: order.id, items: { $elemMatch: { image: { $exists: false } } } }, { $set: { items } })
        : Promise.resolve();
    }));
  }
  return app;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1';
  const port = Number(process.env.PORT || 5050);
  init().then(() => app.listen(port, host, () => console.log(`Happy Knots listening on ${host}:${port}`))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
export { app, connection, database };

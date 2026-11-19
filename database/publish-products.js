import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const drafts = JSON.parse(fs.readFileSync(path.join(root, 'database/product-drafts.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const allowed = new Set(['Personal Accessories & Clothing', 'Door Hangings', 'Wall Hangings', 'Home Decor']);
function assert(ok, message) { if (!ok) throw new Error(message); }
function imageExists(url) { return typeof url === 'string' && url.startsWith('/static/assets/products/') && fs.existsSync(path.join(root, 'frontend', url)); }
function build(row) {
  assert(row.sku && row.name && allowed.has(row.category), `Invalid identity/category: ${row.sku}`);
  assert(Number.isSafeInteger(row.price_paise) && row.price_paise >= 100, `Missing selling price: ${row.sku}`);
  assert(Number.isSafeInteger(row.compare_at_paise) && row.compare_at_paise > row.price_paise, `Missing regular price: ${row.sku}`);
  assert(typeof row.description === 'string' && row.description.length > 15, `Missing description: ${row.sku}`);
  assert(Array.isArray(row.images) && row.images.length && row.images.every(imageExists), `Missing image: ${row.sku}`);
  assert(row.made_to_order === true || Number.isSafeInteger(row.stock) && row.stock >= 0, `Missing availability: ${row.sku}`);
  const variants = row.price_options || row.style_options || [];
  assert(variants.every(v => v.code && v.label && (!v.image || imageExists(v.image)) && (!v.price_paise || Number.isSafeInteger(v.price_paise))), `Invalid option: ${row.sku}`);
  const resolvedVariants = variants.map(v => ({ code: v.code, label: v.label, image: v.image || row.images[0], price_paise: v.price_paise || row.price_paise, compare_at_paise: v.compare_at_paise || row.compare_at_paise }));
  assert(resolvedVariants.every(v => v.compare_at_paise > v.price_paise), `Invalid option regular price: ${row.sku}`);
  return { sku: row.sku, name: row.name, category: row.category, tags: [row.category], keywords: Array.isArray(row.keywords) ? row.keywords : [], description: row.description, image: row.images[0], images: row.images, variants: resolvedVariants, price_paise: row.price_paise, compare_at_paise: row.compare_at_paise, personalisation: row.personalisation || null, badge: row.badge || null, made_to_order: !!row.made_to_order, active: 1 };
}
const catalog = drafts.map(build);
assert(new Set(catalog.map(p => p.sku)).size === catalog.length, 'Duplicate SKU');
if (!apply) { console.log(`Validated ${catalog.length} products. Run with --apply to publish.`); process.exit(0); }
dotenv.config({ path: path.join(root, '.env.mongo') });
assert(process.env.MONGODB_URI, 'MONGODB_URI is required');
function uri() {
  const original = process.env.MONGODB_URI;
  if (process.env.MONGODB_DNS_FALLBACK !== 'dig' || !original.startsWith('mongodb+srv://')) return original;
  const parsed = new URL(original);
  const lookup = (type, name) => execFileSync('dig', ['+time=3', '+tries=1', '+short', type, name], { encoding: 'utf8', timeout: 6000 }).trim();
  const members = lookup('SRV', `_mongodb._tcp.${parsed.hostname}`).split('\n').map(line => { const parts = line.trim().split(/\s+/); assert(parts.length === 4 && /^\d+$/.test(parts[2]), 'Invalid Atlas SRV record'); return parts[3].replace(/\.$/, '') + ':' + parts[2]; });
  const options = new URLSearchParams(lookup('TXT', parsed.hostname).replace(/^"|"$/g, ''));
  for (const [name, value] of parsed.searchParams) options.set(name, value);
  options.set('tls', 'true');
  return `mongodb://${parsed.username}:${parsed.password}@${members.join(',')}/${process.env.MONGODB_DB || 'happy_knots'}?${options}`;
}
const client = new MongoClient(uri(), { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'happy_knots');
  const products = db.collection('products');
  const counters = db.collection('counters');
  const highest = await products.find().sort({ id: -1 }).limit(1).next();
  await counters.updateOne({ _id: 'products' }, { $max: { value: highest?.id || 0 } }, { upsert: true });
  for (const product of catalog) {
    const existing = await products.findOne({ sku: product.sku });
    if (existing) {
      await products.updateOne({ _id: existing._id }, { $set: product, $inc: { version: 1 } });
      console.log(`Updated ${product.sku}`);
    } else {
      const id = (await counters.findOneAndUpdate({ _id: 'products' }, { $inc: { value: 1 } }, { returnDocument: 'after' })).value;
      const draft = drafts.find(d => d.sku === product.sku);
      await products.insertOne({ ...product, id, stock: product.made_to_order ? 9999 : draft.stock, version: 1, units: 0, sales_revenue: 0 });
      console.log(`Created ${product.sku} as product ${id}`);
    }
  }
  await products.updateOne({ sku: 'gold-red-crochet-doily' }, { $set: { active: 0 }, $inc: { version: 1 } });
  console.log('Retired gold-red-crochet-doily (now a colour option)');
} finally { await client.close(); }

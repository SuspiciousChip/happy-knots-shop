// One-time, read-only DynamoDB export and guarded MongoDB Atlas import.
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { init, database, connection } from '../backend/server.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const region = 'ap-southeast-2';
const source = new DynamoDBClient({ region });
const collections = ['products','orders','stats','counters','checkout_receipts','customer_totals'];
const target = Object.fromEntries(collections.map(name => [name, database.collection(name)]));
const migration = database.collection('migration');

async function readSource() {
  let cursor;
  const rows = [];
  do {
    const page = await source.send(new ScanCommand({ TableName: 'happy-knots', ConsistentRead: true, ExclusiveStartKey: cursor }));
    rows.push(...(page.Items || []).map(item => unmarshall(item)));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const marker = rows.find(item => item.collection === 'MIGRATION');
  if (!marker || marker.state !== 'READY') throw new Error('Source migration marker is not READY');
  return rows;
}

export function classify(rows) {
  const output = Object.fromEntries(collections.map(name => [name, []]));
  for (const row of rows) {
    const { collection, ...data } = row;
    if (collection === 'MIGRATION' || collection.startsWith('AUTH_')) continue;
    if (collection === 'PRODUCTS') output.products.push({ ...data, _id: data.id });
    else if (collection === 'ORDERS') output.orders.push({ ...data, _id: data.id });
    else if (collection === 'STATS') output.stats.push({ ...data, _id: 'shop' });
    else if (collection.startsWith('COUNTER#')) output.counters.push({ _id: collection.slice(8), value: data.value });
    else if (collection.startsWith('CHECKOUT#')) output.checkout_receipts.push({ _id: collection.slice(9), fingerprint: data.fingerprint, order_id: data.order_id });
    else if (collection.startsWith('CUSTOMER#')) output.customer_totals.push({ ...data, _id: collection.slice(9) });
    else if (collection.startsWith('ACCOUNT#') || collection.startsWith('HISTORICAL#')) throw new Error(`Unsupported source records: ${collection}. Account data needs an explicit migration.`);
    else throw new Error(`Unknown source collection: ${collection}`);
  }
  return output;
}

async function run() {
  await connection.connect();
  await database.command({ ping: 1 });
  const rows = await readSource();
  const grouped = classify(rows);
  const counts = Object.fromEntries(collections.map(name => [name, grouped[name].length]));
  const existing = await Promise.all(collections.map(name => target[name].estimatedDocumentCount()));
  if (existing.some(Boolean) || await migration.countDocuments()) throw new Error('Atlas target is not empty. Refusing to merge or overwrite.');
  if (grouped.stats.length !== 1 || grouped.counters.length !== 2) throw new Error('Source lacks required totals/counters');
  await migration.insertOne({ _id: 'happy-knots', state: 'IMPORTING', counts, source_region: region });
  try {
    for (const name of collections) if (grouped[name].length) await target[name].insertMany(grouped[name], { ordered: true });
    for (const name of collections) {
      const copied = await target[name].countDocuments();
      if (copied !== counts[name]) throw new Error(`${name}: copied ${copied}, expected ${counts[name]}`);
    }
    await migration.updateOne({ _id: 'happy-knots', state: 'IMPORTING' }, { $set: { state: 'READY', verified_at: new Date() } });
    await init();
    console.log(JSON.stringify({ status: 'READY', counts, region }));
  } catch (error) { console.error('Import incomplete. Keep both sources and do not start the Node app.'); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { await connection.close(); source.destroy(); });
}

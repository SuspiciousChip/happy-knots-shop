// Historical source mapping. The one-time importer is retired after the completed migration.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const collections = ['products','orders','stats','counters','checkout_receipts','customer_totals'];

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('This one-time DynamoDB to Atlas importer is retired. The completed migration must not be rerun.');
  process.exitCode = 1;
}

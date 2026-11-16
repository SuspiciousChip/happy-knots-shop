# Happy Knots DynamoDB migration

## Access patterns (ranked by expected frequency)

Actual traffic and typical record sizes are unknown. No capacity or monthly bill is promised.
The existing application limits orders to 50 distinct products; text fields are bounded.

| Pattern | Authorization | API and consistency | Items returned |
|---|---|---|---|
| Browse catalog | Public | Query PRODUCTS, strong; active filter in application | Catalog (all pages) |
| Checkout | Session-bound signed token + CSRF | Strong GetItem per product; TransactWriteItems | One receipt |
| Owner catalog/edit | Owner session + CSRF on writes | Query/GetItem, strong; conditional UpdateItem | Catalog or one product |
| Latest orders | Owner session | Query ORDERS descending, strong | 30 |
| Order detail/status | Owner session + CSRF on writes | GetItem, strong; conditional UpdateItem | One order with items |
| Total orders/revenue | Owner session | GetItem STATS, strong | One |
| Top products/customers | Owner session | Query rankings GSI descending | Five each; eventual |

The single-shop server owns authorization. Public responses contain only catalog fields.
Customers cannot look up order IDs. Database credentials never reach the browser.
This model is not tenant-isolated; adding shops or customer accounts requires new authorization and keys.

## Layout

One table, `happy-knots`, in `ap-southeast-2`. Partition key `collection` (string), sort key `id` (number).

| collection | id | Contents |
|---|---|---|
| PRODUCTS | Existing/new numeric product ID | Product, stock, version, lifetime units and sales revenue |
| ORDERS | Existing/new numeric order ID | Order and embedded immutable line-item snapshots |
| STATS | 0 | Order count and recorded revenue |
| CUSTOMER#SHA256(email) | 0 | Customer name/email and lifetime order count/spend |
| CHECKOUT#SHA256(signed token) | 0 | Request fingerprint and order ID for durable deduplication |
| COUNTER#products / COUNTER#orders | 0 | Atomic numeric ID sequences |
| MIGRATION | 0 | Source fingerprint and IMPORTING/READY state |
| HISTORICAL#SHA256(name) | 0 | Imported sales with no surviving product reference |

The `rankings` GSI uses `rank_group` (string) and `rank_value` (number). Groups are
PRODUCT_SALES (units) and CUSTOMER_SPEND (paise). INCLUDE projection: name, units,
sales_revenue, customer_name, email, orders, spent. Zero-sale products have no GSI entry.

On-demand capacity; 35-day PITR; deletion protection; default AWS-owned encryption;
TLS; no TTL, Streams, replication, or stream consumers. Products and orders share
backup/restore settings. The owner did not know operational requirements; these were
explained and selected as defaults rather than inferred divergent requirements.

## Transaction and correctness details

Checkout strongly reads products and writes one transaction containing the order,
receipt, product decrements/sales counters, total sales counters, and customer totals.
At 50 distinct products this is 54 transaction actions. Product version, active state,
and stock conditions prevent stale prices and overselling. A failed transaction rolls
back all of these writes. Allocated numeric IDs can have gaps on failures.

The signed checkout token is tied to the session CSRF token. A replay with matching
customer/cart returns the previous order ID, even after the DynamoDB request-token
window. Reuse for different input returns 409. Transport retries of the same SDK call
also use ClientRequestToken. Receipt records have no TTL.

Owner product updates require the rendered version. This avoids restoring stale stock
if a purchase occurs while the edit form is open. Order status updates require an
existing order (no phantom upsert). Creates require an absent key. Cancelling an order
continues the old application's behavior: it does not restock or subtract recorded sales.

Top-product totals now follow product IDs, rather than grouping by historical product
name. Order lines retain original names/prices. Top-customer names use the latest order.
GSI rankings may lag briefly after checkout; order details and total sales read strongly.
Dashboard queries do not scan order history. Migration verification deliberately scans
its offline target; it is not a request path.

Single catalog partition and global counters are appropriate for a small shop, not
unbounded traffic. Measure actual load before scaling; counters can become contention
points. Catalog browsing still reads the catalog, including inactive products, to
preserve the existing interface. No SQL search or general analytics engine was added.

## Data sizes and costs

No observed product/order sizes exist: the SQLite database was empty. The fields are
known from code; typical text lengths, traffic, and monthly costs are not known.
Product fields: numeric ID/price/stock/active/version/counters; name (<=120 characters),
category (<=60), description (<=1000), image URL (<=2048), timestamp and keys.
Order fields: ID/subtotal/status/payment/timestamp, four customer strings (<=500 characters
each), keys, and up to 50 product ID/name/price/quantity snapshots.
Customer summaries contain email, name, three counters and keys. Receipts contain two
hash/key strings and order ID. Imports reject JSON records over 350 KB as a conservative
margin below DynamoDB's 400 KiB item limit.

DynamoDB reads/writes, storage, GSI maintenance and PITR consume AWS credits or incur
charges. The current project is on the Free plan, not Paid; check AWS Settings > Billing
for actual spend/credits. Do not equate on-demand with free. A meaningful monthly
estimate requires expected visits, catalog size and orders/day; no invented forecast
is included. For production, configure CloudWatch alarms for ThrottledRequests,
SystemErrors and UserErrors, and CloudTrail data events for customer-data access;
those additional billable logging/monitoring resources are not provisioned here.

## Migration and rollback

1. Stop all old SQLite writers and all new DynamoDB writers. Do not run both backends.
2. Run `python migrate.py --source store.db` (offline validation, no AWS calls).
3. Run `python migrate.py --source store.db --profile Aryan-Dixit --apply`.
   This creates/configures the table, saves a SQLite backup under `backups/`, imports
   records with conditional writes, checks exact contents, then marks the table READY.
4. A different snapshot or populated target is rejected. An interrupted IMPORTING run
   can resume with the same source. A completed run can be verified again only while
   the target still equals that snapshot. The app rejects requests before READY.
5. Start the new app with the environment in README.md and verify the storefront and
   owner dashboard. There is no background dual-write or automatic source deletion.

Before any new DynamoDB orders exist, rollback means stopping the new app and restoring
the original source from `backups/sqlite-app-before-dynamodb.tar` into a SEPARATE folder,
then copying the retained SQLite database into that folder and running the old app.
Never blindly roll back after DynamoDB accepts writes: export/reconcile those orders,
stock changes and owner edits first, or they will disappear from the application's view.
Do not delete DynamoDB during rollback; retain it for reconciliation. PITR restore
creates a replacement table, so use DYNAMODB_TABLE to switch after verification.

Local synthetic tests use Moto, not AWS. No benchmark Lambda or test orders are created
in the real shop. Live verification should read the empty catalog, migration marker,
backups configuration, and Flask responses. Stop writers again before rerunning import.

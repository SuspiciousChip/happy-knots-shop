# Database

The active database is MongoDB Atlas, named by `MONGODB_DB` (default
`happy_knots`). The connection URI lives only in the ignored root `.env.mongo`.

Collections used by the Node app:

| Collection | Contents |
|---|---|
| `products` | Catalog, stock, version, lifetime sales |
| `orders` | Customer delivery details and immutable line-item snapshots |
| `stats` | Order count and revenue |
| `counters` | Numeric order/product ID sequences |
| `checkout_receipts` | Durable duplicate-checkout guard |
| `customer_totals` | Owner dashboard customer summaries |
| `sessions` | Server-side owner sessions, with expiry |
| `migration` | Verified source import marker |

`migrate-to-atlas.js` is a one-time importer from the old DynamoDB table in
`ap-southeast-2`. It refuses a populated Atlas target, reads every source page,
checks collection counts, and marks the target READY only after verification.
The app refuses to start before that marker is READY. The importer completed on
16 November 2026; do not rerun it against this populated target. The source
DynamoDB table is retained for rollback. No credentials belong in this folder.

# Database

The active database is MongoDB Atlas, named by `MONGODB_DB` (default `happy_knots`). The connection URI and Cognito client secret live only in ignored `.env.mongo`.

| Collection | Contents |
|---|---|
| `products` | Catalog, stock, version, tags, and lifetime sales |
| `customers` | Cognito subject (`_id`), verified email, saved delivery addresses (two address lines, state or Union Territory, six-digit PIN code) |
| `orders` | Customer subject, delivery snapshot including address lines, state and PIN code; immutable line items; status |
| `sessions` | Expiring server-side customer sessions and short-lived OAuth state |
| `checkout_receipts` | Duplicate-checkout guard |
| `stats`, `counters`, `customer_totals` | Shop totals and numeric IDs |
| `migration` | Verified source import marker |

## Product contract for the future admin portal

The separate admin portal should write the same `products` collection. Each active product has a unique numeric `id`, `name`, `description`, `image`, `price_paise` (integer rupees × 100), `stock` (integer), `active: 1`, `version` (integer), and `tags` (array). The allowed tags are `Personal Accessories & Clothing`, `Door Hangings`, `Wall Hangings`, and `Home Decor`. A product may have several tags and appears automatically under each matching category. `All products` is a view of every active product. The storefront also reads legacy `category` when a product has no `tags` array. An admin should update `version` with stock and price to avoid overwriting a checkout change. Product images must use `/static/assets/` or an HTTPS URL.

The old DynamoDB-to-Atlas importer completed on 16 November 2026. Do not rerun it against the populated Atlas database. The old table remains for rollback.

New delivery addresses require address line 1, a selected Indian state or Union Territory, and a six-digit PIN code. Address line 2 is optional. Older saved addresses remain visible in the account but must be replaced before checkout.

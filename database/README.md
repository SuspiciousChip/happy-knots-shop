# Database

The active database is MongoDB Atlas, named by `MONGODB_DB` (default `happy_knots`). The connection URI and Cognito client secret live only in ignored `.env.mongo`.

| Collection | Contents |
|---|---|
| `products` | Catalog, stock, version, tags, and lifetime sales |
| `customers` | Cognito subject (`_id`), verified email, saved delivery addresses (two address lines, city, optional landmark, state or Union Territory, six-digit PIN code) |
| `orders` | Customer subject, delivery snapshot including address lines, city, landmark, state and PIN code; immutable line items; status |
| `sessions` | Expiring server-side customer sessions and short-lived OAuth state |
| `product_images.files`, `product_images.chunks` | Owner-uploaded product images stored through GridFS |
| `login_rate_limits` | Expiring per-IP login-initiation counters |
| `checkout_receipts` | Duplicate-checkout guard |
| `stats`, `counters`, `customer_totals` | Shop totals and numeric IDs |
| `migration` | Verified source import marker |

## Product contract for the future admin portal

The separate admin portal should write the same `products` collection. Each active product has a unique numeric `id`, `name`, `description`, `image`, `price_paise` (integer rupees × 100), `stock` (integer), `active: 1`, `version` (integer), and `tags` (array). The allowed tags are `Personal Accessories & Clothing`, `Door Hangings`, `Wall Hangings`, and `Home Decor`. A product may have several tags and appears automatically under each matching category. `All products` is a view of every active product. The storefront also reads legacy `category` when a product has no `tags` array. An admin should update `version` with stock and price to avoid overwriting a checkout change. Product images must use `/static/assets/` or an HTTPS URL. Optional `compare_at_paise` displays a crossed-out genuine regular price when greater than `price_paise`. Optional `images` provides a detail gallery; `variants` holds selectable `{ code, label, image, price_paise, compare_at_paise }` options. `personalisation` holds a label for required customer text, which is saved on each order line. `made_to_order: true` displays the production status.

The catalog prepared from the customer photos is in `product-drafts.json`. Run `node database/publish-products.js` to validate it, then `node database/publish-products.js --apply` to create or update products in Atlas. The script preserves the current remaining order capacity on updates.

The old DynamoDB-to-Atlas importer completed on 16 November 2026. Its executable entry point is retired so a paginated scan cannot be mistaken for a consistent snapshot or replayed into the populated Atlas database. The old table remains for rollback.

New delivery addresses require an exact 10-digit Indian phone number (stored with the +91 prefix), address line 1, city, a selected Indian state or Union Territory, and a six-digit PIN code. Address line 2 and landmark are optional. Older saved addresses remain visible in the account but must be replaced before checkout.

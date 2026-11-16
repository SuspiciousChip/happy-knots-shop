# Verification — 16 November 2026

Local SQLite source: zero products, zero orders, zero order items.

Live AWS verification:

- Region: ap-southeast-2
- Table: happy-knots, ACTIVE
- Index: rankings, ACTIVE
- Capacity: PAY_PER_REQUEST
- Deletion protection: enabled
- Point-in-time recovery: enabled, 35 days
- Migration marker: READY
- Products/orders: zero/zero
- Flask test-client storefront response against live AWS: HTTP 200
- Unauthenticated owner access: HTTP 302 to login
- Authenticated owner dashboard against live AWS: HTTP 200

Local validation: 13 tests passed; Python compilation and git diff whitespace checks passed.
Synthetic checkout tests ran against Moto. No customer/order test records were written
to the live table, and no AWS load benchmark was run. No public hosting deployment was
performed; this change updates the local Flask app and provisions its live database.

The source SQLite file, a private SQLite backup and the original committed source
archive remain under the workspace (backups are excluded from Git). The DynamoDB table
is retained for use by the application.

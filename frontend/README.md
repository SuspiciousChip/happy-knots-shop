# Customer frontend

`templates/` contains the home, category catalog, product detail, checkout, account, and order pages rendered by the Node server. `static/` contains the customer CSS, cart, checkout script, and images. The cart is stored in browser localStorage; the server rechecks its items and prices at checkout.

Owner screens from the earlier combined site are inactive and kept under `archive/owner-portal-legacy/`. The future admin portal should have its own frontend and share the Atlas product contract documented in `database/README.md`.

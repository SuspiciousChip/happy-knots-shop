# Backend

`server.js` is the active Node.js/Express app. It handles the storefront,
checkout, owner session and routes, and template rendering. It loads local
settings from the root `.env.mongo` and serves `frontend/static/`.

Checkout runs in a MongoDB transaction: one order record, conditional stock
updates, sales totals, and a durable checkout receipt commit together. The
transaction requires an Atlas replica set. Owner product edits use a version
check so an old form cannot silently overwrite stock changed by a purchase.

Customer login is not implemented in Node yet. `/account/login` returns a clear
temporary message. Owner login is disabled unless both owner environment
settings are present. The app listens on localhost by default and uses the
Express development process; use an appropriate hosted runtime for public use.

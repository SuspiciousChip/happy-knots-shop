# Backend

`server.js` is the active Node.js/Express customer app. It serves the storefront, category and product pages, Cognito customer login, saved addresses, customer order history, and checkout. The old owner routes are removed from this server.

Customer sign-in uses the Cognito Lite classic hosted UI and authorization-code flow with PKCE. The server keeps customer identity in an HttpOnly, signed, server-side session. Cognito owns passwords and email verification; Atlas owns address and order data. Login sessions currently expire after at most one hour, requiring a new sign-in. The local callback is `http://localhost:5050/account/callback`. A public HTTPS URL requires updating the Cognito app client's exact callback and `APP_BASE_URL` before launch.

Checkout requires an authenticated customer and an address stored under that customer's Cognito `sub`. It recalculates prices and availability on the server and commits the order, stock changes, totals, and duplicate-checkout receipt in a MongoDB transaction. Payment is cash on delivery; no online payment gateway is installed. The address and phone used for an order are snapshotted into that order.

`database/setup-customer-auth.js` was run once to provision the user pool, confidential app client, and classic hosted UI domain in the AWS project's assigned `ap-southeast-2` Region. It stores IDs and the secret in ignored `.env.mongo`. Do not rerun it for this existing pool.

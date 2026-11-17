# Backend

`server.js` is the active Node.js/Express customer app. It serves the storefront, category and product pages, Cognito customer login, saved addresses, customer order history, and checkout. The old owner routes are removed from this server.

Customer sign-in uses the Cognito Lite classic hosted UI and authorization-code flow with PKCE. The server keeps customer identity in an HttpOnly, signed, server-side session. Public browsing does not create a session document; the login flow creates a short-lived OAuth session, then rotates it after sign-in. Login initiation is limited to ten requests per IP per ten-minute window in Atlas. Cognito owns passwords and email verification; Atlas owns address and order data. Login sessions currently expire after at most one hour, requiring a new sign-in. The local callback is `http://localhost:5050/account/callback`. A public HTTPS URL requires updating the Cognito app client's exact callback and `APP_BASE_URL` before launch.

Checkout requires an authenticated customer and an address stored under that customer's Cognito `sub`. It recalculates prices and availability on the server and commits the order, stock changes, totals, and duplicate-checkout receipt in a MongoDB transaction. Payment is cash on delivery; no online payment gateway is installed. The address and phone used for an order are snapshotted into that order.

`razorpay.js` handles simulated Razorpay orders, payment lookup, and signature verification using credentials kept in the ignored `.env.mongo` file. It accepts only `rzp_test_` keys. Set `RAZORPAY_TEST_CHECKOUT=true` locally to show a second checkout button that launches Razorpay test mode. The test route verifies a captured payment against the server-stored order ID and amount, then records the simulation in `razorpay_test_payments`. It never creates a real shop order, changes stock, or updates sales figures. It is unavailable on Render or when `NODE_ENV=production`. Cash on delivery remains the only live payment method until a separate live pending-order and recovery flow is built. Never put the key secret in a template, browser script, or Git.

`database/setup-customer-auth.js` was run once to provision the user pool, confidential app client, and classic hosted UI domain in the AWS project's assigned `ap-southeast-2` Region. It stores IDs and the secret in ignored `.env.mongo`. Do not rerun it for this existing pool.

If the catalog is empty, the local test checkout offers a ₹1 simulated demo. It creates only a Razorpay test order and test record; no shop order or stock change occurs.

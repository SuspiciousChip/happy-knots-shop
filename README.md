# Happy Knots

Happy Knots is a customer storefront for handmade crochet. The active app is Node.js/Express with MongoDB Atlas. Customers can browse products without an account, sign up or sign in through Amazon Cognito, save delivery addresses, and place cash-on-delivery orders. A separate admin portal is planned later.

## Customer CAPTCHA

Customer sign-in and registration start at `/account/login`, where a Google reCAPTCHA v2 checkbox is verified by the Node server before redirecting to Cognito when both keys are configured. Create a **Challenge (v2) → “I'm not a robot” Checkbox** key in the reCAPTCHA admin console with `happyknots.shop` as an allowed domain. In Render **Environment**, add `RECAPTCHA_SITE_KEY` (public) and `RECAPTCHA_SECRET_KEY` (private), and set `APP_BASE_URL=https://www.happyknots.shop`. Redeploy after saving those variables. Keep the secret key out of Git and browser code. For local testing, register `localhost` on a separate development key and put both keys in the ignored `.env.mongo` file. The server rejects missing, expired, invalid, or wrong-hostname tokens. Without either key, the existing Cognito redirect remains active; with only one key, login returns a setup error.

## Project map

| Folder | Purpose |
|---|---|
| [`frontend/`](frontend/README.md) | Customer pages, browser JavaScript, CSS, images |
| [`backend/`](backend/README.md) | Express routes, customer login, addresses, checkout |
| [`database/`](database/README.md) | Atlas collections, product contract, migration and auth setup scripts |
| [`archive/owner-portal-legacy/`](archive/owner-portal-legacy/README.md) | Inactive owner screens from the combined site |
| [`archive/python-flask/`](archive/python-flask/README.md) | Earlier Python implementation |

## Run locally

Install Node.js 20 or later, then run `npm install` and `npm start` from this folder. Open [http://localhost:5050](http://localhost:5050). The ignored `.env.mongo` file contains the real Atlas and Cognito configuration. `.env.example` lists the required names. `MONGODB_DNS_FALLBACK=dig` is needed on this Mac when Node's Atlas SRV lookup fails.

The app currently uses a localhost-only Cognito callback. Before a public launch, host the site over HTTPS and register its exact callback URL in the Cognito app client. Customer login must be tested with a verified email address. The catalog is empty until products are added via the future admin portal or directly to Atlas following `database/README.md`.

Run `npm test` for the Node checks. The existing Atlas migration marker is verified when the server starts.

## Deploy to Render and connect happyknots.shop

1. Create a **Web Service** from the `SuspiciousChip/happy-knots-shop` GitHub repository. Use Node, build command `npm ci`, start command `npm start`, and health check path `/healthz`. The repository root contains `package.json`; leave Render's root directory blank. The server listens on Render's `PORT` and `0.0.0.0` there.
2. In Render **Environment**, set `NODE_ENV=production`, `APP_BASE_URL=https://www.happyknots.shop`, `MONGODB_URI`, `MONGODB_DB=happy_knots`, `FLASK_SECRET_KEY`, `COGNITO_ISSUER`, `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, and `COGNITO_DOMAIN` from the ignored local `.env.mongo`. Keep the secret values private. Do not set `MONGODB_DNS_FALLBACK=dig` or `PORT` on Render. Use a persistent `FLASK_SECRET_KEY` so sessions survive redeploys.
3. In the Render service's **Connect → Outbound** panel, copy its outbound IP ranges. Add those ranges to MongoDB Atlas **Network Access → IP Access List** so the app can reach Atlas. Test the temporary `onrender.com` URL and `/healthz` after deployment. Account login will need the public Cognito callback before it works.
4. In Render **Settings → Custom Domains**, add `www.happyknots.shop`. Render also adds the root domain and redirects it to `www`. Enter the exact DNS records Render requests in GoDaddy **Domain Portfolio → happyknots.shop → DNS**; keep unrelated MX/TXT email records. Return to Render and verify the domain and HTTPS certificate.
5. In the existing Cognito app client, add `https://www.happyknots.shop/account/callback` as a callback URL and `https://www.happyknots.shop` as a sign-out URL. Preserve the localhost URLs for local testing. Do not rerun `database/setup-customer-auth.js` or create a second pool. Test sign-in, saved address, and a checkout with a test product before accepting customer orders.
6. In Google reCAPTCHA, allow `www.happyknots.shop` and `localhost` (or use separate production and local keys). The app does not yet display or verify a reCAPTCHA challenge; its keys alone do not protect login.

The storefront has no admin portal or online payment gateway yet. Orders use cash on delivery, and products must be added to Atlas following [`database/README.md`](database/README.md).

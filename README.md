# Happy Knots

Happy Knots is a customer storefront for handmade crochet. The active app is Node.js/Express with MongoDB Atlas. Customers can browse products without an account, sign up or sign in through Amazon Cognito, save delivery addresses, and place cash-on-delivery orders. A separate admin portal is planned later.

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

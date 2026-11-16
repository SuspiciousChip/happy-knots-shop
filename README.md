# Happy Knots

Happy Knots is a crochet storefront. The active app runs on Node.js/Express and
MongoDB Atlas. Customers can browse and place cash-on-delivery orders; the owner
can manage products, stock, and orders. Customer accounts are still being built,
so the Sign in link currently shows a temporary message.

## Project map

| Folder | Purpose |
|---|---|
| [`frontend/`](frontend/README.md) | Nunjucks page templates, browser JavaScript, CSS, and images |
| [`backend/`](backend/README.md) | Express server, routes, sessions, checkout, owner login |
| [`database/`](database/README.md) | One-time DynamoDB-to-Atlas transfer and database layout |
| [`node-tests/`](node-tests/) | Node migration and template checks |
| [`archive/python-flask/`](archive/python-flask/README.md) | Previous Python/SQLite/DynamoDB implementation, retained for reference |

`package.json` starts and tests the active Node app. `.env.example` lists the
settings; `.env.mongo` holds your real local settings and is ignored by Git.

## Run locally

Install Node.js 20 or later, then run from this folder:

```sh
npm install
npm start
```

Open [http://127.0.0.1:5050](http://127.0.0.1:5050). Copy `.env.example` to
`.env.mongo` and fill in the real Atlas URI, database name, and stable session
secret. The server checks Atlas and the completed migration marker before it
listens. `MONGODB_DNS_FALLBACK=dig` is required on this Mac because Node's SRV
lookup fails here; omit it where normal Node DNS works.

For owner login, add `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` to `.env.mongo`.
Until both are set, owner login stays disabled. The prior Flask app's Werkzeug
scrypt hash is accepted. To generate a new hash locally:

```sh
.venv/bin/python -c 'from werkzeug.security import generate_password_hash; import getpass; print(generate_password_hash(getpass.getpass("Owner password: ")))'
```

Keep the URI, password, and secret out of Git and chat. In Atlas, allow the app's
IP address and give its database user read/write access to `happy_knots`.

## Data and verification

The one-time transfer finished on 16 November 2026. DynamoDB had no products
or orders; Atlas received the totals and ID counters. The old DynamoDB table
and local SQLite backup remain for rollback. Atlas connection and transaction
checks passed, and the Node storefront returned HTTP 200.

Run `npm test` for the Node checks. The account signup and saved-address pages
from the previous Python work are archived and are not active in the Node app.

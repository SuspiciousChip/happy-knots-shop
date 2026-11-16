# Happy Knots Shop

A Flask storefront with a private owner dashboard. Customers can browse products, add items to a bag, and place cash-on-delivery orders. The owner can manage products and stock, review orders, update order status, and see sales summaries.

## Run locally

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Generate a password hash for the owner login:

```sh
python3 -c 'from werkzeug.security import generate_password_hash; import getpass; print(generate_password_hash(getpass.getpass("Owner password: ")))'
```

Set the following environment variables in your shell, using your own values:

```sh
export FLASK_SECRET_KEY='replace-with-a-long-random-secret'
export ADMIN_EMAIL='you@example.com'
export ADMIN_PASSWORD_HASH='paste-the-generated-hash-here'
```

Then start the app:

```sh
python3 app.py
```

Open `http://127.0.0.1:5000` for the shop and `http://127.0.0.1:5000/owner/login` for the owner dashboard. The app creates a local SQLite database (`store.db`) on first start. You can set `DATABASE_PATH` to store it elsewhere.

## Data and payments

Products, orders, order items, and stock are stored in SQLite for local development. The first catalog is empty; add real products from the owner dashboard. Image assets from the earlier Happy Knots site are included under `static/assets/`.

Orders are recorded as cash on delivery. Online payment is not connected. For a public deployment, plan for a hosted database, HTTPS, backups, and a payment provider if online checkout is needed.

## Keep secrets out of Git

The repository ignores `.env`, `*.db`, and virtual environments. Set real credentials through environment variables or your deployment platform's secret settings. Never commit AWS credentials, access keys, the owner password, or a database file. `.env.example` contains placeholders only.

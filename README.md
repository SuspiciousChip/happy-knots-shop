# The Happy Knots shop

A separate Flask storefront and owner dashboard. It uses SQLite for local development and does not depend on Odoo or the earlier static preview.

## Run locally

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python3 -c 'from werkzeug.security import generate_password_hash; import getpass; print(generate_password_hash(getpass.getpass("Owner password: ")))' 
```

Set `FLASK_SECRET_KEY` to a long random value, `ADMIN_EMAIL` to your owner email, and `ADMIN_PASSWORD_HASH` to the generated hash. Set `DATABASE_PATH` if you want the database outside the project. Then run `python3 app.py` and visit `http://127.0.0.1:5000`. The owner dashboard is at `/owner/login`.

## Current scope

- Owner: add/edit products, price, stock, visibility, inspect orders, update order status, view sales and top products/customers.
- Customer: browse/filter products, cart, checkout with contact and delivery address, cash on delivery order recording.
- No card or online payment provider is connected. Do not advertise online payments until one is configured.
- The first catalog is empty so the owner can add real products and prices. Photos from the existing Happy Knots site are included for use in product entries.

For production, use a hosted database, HTTPS, a fixed secret key, protected owner credentials, migrations, backups, and a payment provider. Replace the `db()` adapter and schema setup when connecting your chosen database. Do not commit `.env` or a database file.

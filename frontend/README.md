# Frontend

`templates/` contains Nunjucks server-rendered pages. `static/` contains browser
JavaScript, CSS, and image assets, served at `/static/*` by Express.

The active entry page is `templates/shop.html`; the owner pages are
`templates/login.html`, `templates/owner.html`, and `templates/order.html`.
`templates/account.html` and `templates/customer_order.html` are unfinished
customer-account views and have no active routes yet. Keep user data escaped in
templates. Product JSON is serialized by the backend's `json_safe` filter.

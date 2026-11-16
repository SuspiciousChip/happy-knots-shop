import json
import os
import secrets
from pathlib import Path
from datetime import timedelta
from dotenv import load_dotenv
from requests.exceptions import RequestException
from customer_auth import CustomerAuth
from datetime import datetime, timezone
from functools import wraps
from flask import Flask, abort, g, redirect, render_template, request, session, url_for
from decimal import Decimal, InvalidOperation
from itsdangerous import URLSafeSerializer, BadSignature
from botocore.exceptions import BotoCoreError, ClientError
from storage import Store, BagChanged, Conflict, NotReady
from werkzeug.security import check_password_hash

load_dotenv(Path(__file__).parent / '.env.auth')
app = Flask(__name__)
for name in ('COGNITO_POOL_ID', 'COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET', 'COGNITO_DOMAIN'):
    app.config[name] = os.environ.get(name, '')
app.config['APP_BASE_URL'] = os.environ.get('APP_BASE_URL', 'http://localhost:5050').rstrip('/')
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(days=30)
app.config['MAX_CONTENT_LENGTH'] = 128 * 1024
if app.config['COGNITO_CLIENT_ID'] and not os.environ.get('FLASK_SECRET_KEY'):
    raise RuntimeError('Set a stable FLASK_SECRET_KEY before enabling customer login')
app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.environ.get('FLASK_ENV') == 'production')


def db():
    if 'store' not in g:
        g.store = Store()
        g.store.ensure_ready()
    return g.store


@app.errorhandler(RequestException)
@app.errorhandler(NotReady)
@app.errorhandler(BotoCoreError)
@app.errorhandler(ClientError)
def database_unavailable(error):
    app.logger.error("DynamoDB request failed (%s)", type(error).__name__)
    return render_template('message.html', title='Shop temporarily unavailable',
                           message='Please try again shortly. If you already submitted an order, retry the same checkout.'), 503


@app.errorhandler(Conflict)
def conflict(error):
    return render_template('message.html', title='Please refresh', message=str(error)), 409


def product_values(data, active):
    try:
        amount = Decimal(data.get('price', ''))
        if not amount.is_finite() or amount < 0 or amount > 1_000_000_000:
            abort(400)
        price = int((amount * 100).quantize(Decimal('1')))
        stock = int(data.get('stock', ''))
    except (ValueError, InvalidOperation):
        abort(400)
    name = data.get('name', '').strip()
    image = data.get('image', '').strip()
    if not name or len(name) > 120 or not 0 <= stock <= 1_000_000_000 or len(image) > 2048:
        abort(400)
    if image and not (image.startswith('/static/assets/') or image.startswith('https://')):
        abort(400)
    return dict(name=name, category=data.get('category', 'Other')[:60],
                description=data.get('description', '')[:1000], price_paise=price,
                image=image, stock=stock, active=active)


def csrf():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    return session['csrf']


def check_csrf():
    if not session.get('csrf') or not secrets.compare_digest(request.form.get('csrf', ''), session['csrf']):
        abort(400)


def owner(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        if not session.get('owner'):
            return redirect(url_for('login'))
        return fn(*args, **kwargs)
    return wrapped


def now():
    return datetime.now(timezone.utc).isoformat()


@app.context_processor
def inject():
    return {'csrf': csrf(), 'csp_nonce': g.get('csp_nonce', '')}


@app.route('/')
def home():
    customer = customer_auth.current()
    profile = db().account_profile(customer['sub']) if customer else {'addresses': []}
    products = db().products(active_only=True)
    token = URLSafeSerializer(app.secret_key, salt='checkout').dumps({'csrf': csrf(), 'nonce': secrets.token_hex(16)})
    public_fields = ('id', 'name', 'category', 'description', 'price_paise', 'image', 'stock')
    return render_template('shop.html', products=products,
                           product_json=[{k: p[k] for k in public_fields} for p in products], checkout_token=token,
                           customer=customer, profile=profile, auth_enabled=customer_auth.enabled)


@app.post('/orders')
def place_order():
    check_csrf()
    data = request.form
    customer = customer_auth.current()
    name, email, phone, address = [data.get(k, '').strip() for k in ('name', 'email', 'phone', 'address')]
    if customer:
        email = customer['email']
        if data.get('address_id'):
            addresses = db().account_profile(customer['sub'])['addresses']
            saved = next((a for a in addresses if a['address_id'] == data['address_id']), None)
            if not saved:
                abort(400)
            name, phone, address = saved['name'], saved['phone'], saved['address']
    if not name or not email or '@' not in email or not phone or not address or any(len(x) > 500 for x in (name, email, phone, address)):
        abort(400)
    try:
        items = json.loads(data.get('items', '[]'))
    except (ValueError, TypeError):
        abort(400)
    if not isinstance(items, list) or not items or len(items) > 50:
        abort(400)
    quantities = {}
    for item in items:
        if not isinstance(item, dict) or type(item.get('id')) is not int or type(item.get('quantity')) is not int or not 1 <= item['quantity'] <= 99:
            abort(400)
        quantities[item['id']] = quantities.get(item['id'], 0) + item['quantity']
    if any(identifier <= 0 or quantity > 99 for identifier, quantity in quantities.items()):
        abort(400)
    token = data.get('checkout_token', '')
    try:
        signed = URLSafeSerializer(app.secret_key, salt='checkout').loads(token)
        if signed.get('csrf') != session['csrf']:
            abort(400)
    except (BadSignature, AttributeError):
        abort(400)
    try:
        identifier = db().place_order(dict(customer_name=name, email=email, phone=phone, address=address),
                                      quantities, now(), token, subject=customer['sub'] if customer else None)
    except BagChanged:
        return render_template('message.html', title='Bag changed', message='An item changed or is no longer available in that quantity. Please review your bag.'), 409
    return render_template('message.html', title=f'Order #{identifier} received', message='Thank you. Your order has been recorded. Payment and delivery confirmation will be arranged separately.')


@app.route('/owner/login', methods=['GET','POST'])
def login():
    error = None
    if request.method == 'POST':
        check_csrf()
        email = os.environ.get('ADMIN_EMAIL', '')
        password_hash = os.environ.get('ADMIN_PASSWORD_HASH', '')
        if email and password_hash and secrets.compare_digest(request.form.get('email',''), email) and check_password_hash(password_hash, request.form.get('password','')):
            session.clear()
            session['owner'] = True
            return redirect(url_for('dashboard'))
        error = 'Invalid login.'
    return render_template('login.html', error=error)


@app.post('/owner/logout')
@owner
def logout():
    check_csrf()
    session.clear()
    return redirect(url_for('home'))


@app.get('/owner')
@owner
def dashboard():
    return render_template('owner.html', **db().dashboard())


@app.post('/owner/products')
@owner
def create_product():
    check_csrf()
    db().create_product({**product_values(request.form, 1), 'created_at': now()})
    return redirect(url_for('dashboard'))


@app.post('/owner/products/<int:product_id>')
@owner
def update_product(product_id):
    check_csrf()
    if not db().get('PRODUCTS', product_id):
        abort(404)
    try:
        version = int(request.form.get('version', ''))
    except ValueError:
        abort(400)
    db().update_product(product_id, product_values(request.form, 1 if request.form.get('active') else 0), version)
    return redirect(url_for('dashboard'))


@app.post('/owner/orders/<int:order_id>')
@owner
def update_order(order_id):
    check_csrf()
    status=request.form.get('status')
    if status not in ('new','confirmed','shipped','completed','cancelled'): abort(400)
    try:
        db().update_order(order_id, status)
    except KeyError:
        abort(404)
    return redirect(url_for('dashboard'))


@app.get('/owner/orders/<int:order_id>')
@owner
def order_detail(order_id):
    order=db().get('ORDERS', order_id)
    if not order: abort(404)
    items=order['items']
    return render_template('order.html', order=order, items=items)


customer_auth = CustomerAuth(app, db, check_csrf)


@app.before_request
def request_nonce():
    g.csp_nonce = secrets.token_urlsafe(24)


@app.after_request
def privacy_headers(response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self' 'nonce-" + g.get('csp_nonce', '') +
        "'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    if app.config['SESSION_COOKIE_SECURE']:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000'
    return response


@app.get('/account')
@customer_auth.required
def customer_account():
    customer = customer_auth.current()
    before = request.args.get('before', type=int)
    if before is not None and before < 1:
        abort(400)
    orders, next_cursor = db().account_orders(customer['sub'], before)
    return render_template('account.html', customer=customer,
                           profile=db().account_profile(customer['sub']), orders=orders, next_cursor=next_cursor)


@app.post('/account/addresses')
@customer_auth.required
def save_address():
    check_csrf()
    customer = customer_auth.current()
    profile = db().account_profile(customer['sub'])
    try:
        version = int(request.form.get('version', ''))
    except ValueError:
        abort(400)
    if profile['version'] != version:
        raise Conflict('Your saved details changed. Refresh this page and try again.')
    addresses = profile['addresses']
    if len(addresses) >= 5:
        raise Conflict('You can save up to five addresses. Remove one before adding another.')
    values = {field: request.form.get(field, '').strip() for field in ('label', 'name', 'phone', 'address')}
    limits = {'label': 40, 'name': 120, 'phone': 50, 'address': 500}
    if any(not value or len(value) > limits[field] for field, value in values.items()):
        abort(400)
    addresses = [*addresses, {**values, 'address_id': secrets.token_hex(16)}]
    db().save_account_profile(customer['sub'], {'addresses': addresses}, version)
    return redirect(url_for('customer_account', _anchor='addresses'))


@app.post('/account/addresses/<address_id>/delete')
@customer_auth.required
def delete_address(address_id):
    check_csrf()
    customer = customer_auth.current()
    profile = db().account_profile(customer['sub'])
    try:
        version = int(request.form.get('version', ''))
    except ValueError:
        abort(400)
    addresses = [a for a in profile['addresses'] if a['address_id'] != address_id]
    if len(addresses) == len(profile['addresses']):
        abort(404)
    db().save_account_profile(customer['sub'], {'addresses': addresses}, version)
    return redirect(url_for('customer_account', _anchor='addresses'))


@app.get('/account/orders/<int:order_id>')
@customer_auth.required
def customer_order(order_id):
    order = db().account_order(customer_auth.current()['sub'], order_id)
    if not order:
        abort(404)
    return render_template('customer_order.html', order=order)


if __name__ == '__main__':
    app.run(debug=os.environ.get('FLASK_DEBUG') == '1')

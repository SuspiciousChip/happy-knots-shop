import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from flask import Flask, abort, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash

ROOT = Path(__file__).parent
app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', secrets.token_hex(32))
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_SECURE=os.environ.get('FLASK_ENV') == 'production')
DB = Path(os.environ.get('DATABASE_PATH', ROOT / 'store.db'))


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys=ON')
    return g.db


@app.teardown_appcontext
def close_db(_):
    conn = g.pop('db', None)
    if conn:
        conn.close()


def init_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB) as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_paise INTEGER NOT NULL CHECK(price_paise >= 0), image TEXT NOT NULL DEFAULT '', stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, subtotal_paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', payment_method TEXT NOT NULL DEFAULT 'cash_on_delivery', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER REFERENCES products(id), product_name TEXT NOT NULL, unit_price_paise INTEGER NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0));
        ''')


def csrf():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_urlsafe(32)
    return session['csrf']


def check_csrf():
    if not secrets.compare_digest(request.form.get('csrf', ''), session.get('csrf', '')):
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
    return {'csrf': csrf()}


@app.route('/')
def home():
    products = db().execute('SELECT * FROM products WHERE active=1 ORDER BY id DESC').fetchall()
    return render_template('shop.html', products=products, product_json=[dict(p) for p in products])


@app.post('/orders')
def place_order():
    check_csrf()
    data = request.form
    name, email, phone, address = [data.get(k, '').strip() for k in ('name', 'email', 'phone', 'address')]
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
        if not isinstance(item, dict) or not isinstance(item.get('id'), int) or not isinstance(item.get('quantity'), int) or not 1 <= item['quantity'] <= 99:
            abort(400)
        quantities[item['id']] = quantities.get(item['id'], 0) + item['quantity']
    conn = db()
    try:
        conn.execute('BEGIN IMMEDIATE')
        rows = conn.execute(f"SELECT * FROM products WHERE active=1 AND id IN ({','.join('?' for _ in quantities)})", list(quantities)).fetchall()
        if len(rows) != len(quantities) or any(p['stock'] < quantities[p['id']] for p in rows):
            conn.rollback()
            return render_template('message.html', title='Bag changed', message='An item is no longer available in that quantity. Please review your bag.'), 409
        total = sum(p['price_paise'] * quantities[p['id']] for p in rows)
        cur = conn.execute('INSERT INTO orders (customer_name,email,phone,address,subtotal_paise,created_at) VALUES (?,?,?,?,?,?)', (name,email,phone,address,total,now()))
        for p in rows:
            qty = quantities[p['id']]
            conn.execute('INSERT INTO order_items (order_id,product_id,product_name,unit_price_paise,quantity) VALUES (?,?,?,?,?)', (cur.lastrowid,p['id'],p['name'],p['price_paise'],qty))
            conn.execute('UPDATE products SET stock=stock-? WHERE id=?', (qty,p['id']))
        conn.commit()
        return render_template('message.html', title=f'Order #{cur.lastrowid} received', message='Thank you. Your order has been recorded. Payment and delivery confirmation will be arranged separately.')
    except Exception:
        conn.rollback()
        raise


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
    conn = db()
    stats = conn.execute("SELECT COUNT(*) orders, COALESCE(SUM(subtotal_paise),0) revenue FROM orders").fetchone()
    products = conn.execute('SELECT * FROM products ORDER BY id DESC').fetchall()
    orders = conn.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 30').fetchall()
    best = conn.execute('SELECT product_name, SUM(quantity) units, SUM(unit_price_paise * quantity) revenue FROM order_items GROUP BY product_name ORDER BY units DESC LIMIT 5').fetchall()
    customers = conn.execute('SELECT customer_name,email,COUNT(*) orders,SUM(subtotal_paise) spent FROM orders GROUP BY email ORDER BY spent DESC LIMIT 5').fetchall()
    return render_template('owner.html', stats=stats, products=products, orders=orders, best=best, customers=customers)


@app.post('/owner/products')
@owner
def create_product():
    check_csrf()
    data = request.form
    try:
        price = int(round(float(data.get('price','')) * 100))
        stock = int(data.get('stock',''))
    except ValueError:
        abort(400)
    name = data.get('name','').strip()
    if not name or len(name)>120 or price<0 or stock<0:
        abort(400)
    image = data.get('image','').strip()
    if image and not (image.startswith('/static/assets/') or image.startswith('https://')):
        abort(400)
    db().execute('INSERT INTO products (name,category,description,price_paise,image,stock,created_at) VALUES (?,?,?,?,?,?,?)',(name,data.get('category','Other')[:60],data.get('description','')[:1000],price,image,stock,now()))
    db().commit()
    return redirect(url_for('dashboard'))


@app.post('/owner/products/<int:product_id>')
@owner
def update_product(product_id):
    check_csrf()
    p = db().execute('SELECT id FROM products WHERE id=?',(product_id,)).fetchone()
    if not p: abort(404)
    data=request.form
    try:
        price=int(round(float(data.get('price',''))*100));stock=int(data.get('stock',''))
    except ValueError: abort(400)
    name=data.get('name','').strip();image=data.get('image','').strip()
    if not name or len(name)>120 or price<0 or stock<0 or (image and not (image.startswith('/static/assets/') or image.startswith('https://'))): abort(400)
    db().execute('UPDATE products SET name=?,category=?,description=?,price_paise=?,image=?,stock=?,active=? WHERE id=?',(name,data.get('category','Other')[:60],data.get('description','')[:1000],price,image,stock,1 if data.get('active') else 0,product_id))
    db().commit()
    return redirect(url_for('dashboard'))


@app.post('/owner/orders/<int:order_id>')
@owner
def update_order(order_id):
    check_csrf()
    status=request.form.get('status')
    if status not in ('new','confirmed','shipped','completed','cancelled'): abort(400)
    db().execute('UPDATE orders SET status=? WHERE id=?',(status,order_id));db().commit()
    return redirect(url_for('dashboard'))


@app.get('/owner/orders/<int:order_id>')
@owner
def order_detail(order_id):
    order=db().execute('SELECT * FROM orders WHERE id=?',(order_id,)).fetchone()
    if not order: abort(404)
    items=db().execute('SELECT * FROM order_items WHERE order_id=?',(order_id,)).fetchall()
    return render_template('order.html', order=order, items=items)


if __name__ == '__main__':
    init_db()
    app.run(debug=os.environ.get('FLASK_DEBUG') == '1')

import re
import sqlite3

import boto3
import pytest
from moto import mock_aws

import app as web
from migrate import build_items, create_table, ensure_backup, migrate
from storage import Store, BagChanged, Conflict, key

EMPTY = {'products': [], 'orders': [], 'order_items': []}
CUSTOMER = dict(customer_name='Test Customer', email='test@example.invalid', phone='123', address='Test address')
PRODUCT = dict(name='Crochet flower', category='Flowers', description='Handmade', price_paise=1234,
               image='', stock=5, active=1, created_at='2026-11-16')


@pytest.mark.parametrize('value', [1.5, b'binary'])
def test_migration_rejects_unsupported_sqlite_values(value):
    rows = {**EMPTY, 'products': [{'id': 1, **PRODUCT, 'description': value}]}
    with pytest.raises(ValueError, match='source.products\\[0\\].description'):
        build_items(rows)


def test_backup_replaces_incomplete_file(tmp_path):
    snapshot = sqlite3.connect(':memory:')
    snapshot.execute('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)')
    snapshot.execute('INSERT INTO products VALUES (1, "Flower")')
    snapshot.commit()
    backup_path = tmp_path / 'backup.db'
    backup_path.touch()
    ensure_backup(snapshot, backup_path)
    with sqlite3.connect(backup_path) as backup:
        assert backup.execute('SELECT name FROM products').fetchone()[0] == 'Flower'
    ensure_backup(snapshot, backup_path)


@pytest.fixture
def store(monkeypatch):
    monkeypatch.delenv('AWS_PROFILE', raising=False)
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='ap-southeast-2')
        create_table(resource, 'test-happy-knots')
        result = Store(resource, 'test-happy-knots')
        migrate(result, EMPTY)
        monkeypatch.setattr(web, 'Store', lambda: result)
        web.app.config.update(TESTING=True, SECRET_KEY='test-secret')
        yield result


def test_checkout_atomic_and_idempotent(store):
    product = store.create_product(PRODUCT)
    order_id = store.place_order(CUSTOMER, {product: 2}, 'now', 'request-1')
    assert store.place_order(CUSTOMER, {product: 2}, 'later', 'request-1') == order_id
    assert store.get('PRODUCTS', product)['stock'] == 3
    assert store.get('STATS')['orders'] == 1
    assert store.get('STATS')['revenue'] == 2468
    assert store.get('ORDERS', order_id)['items'][0]['unit_price_paise'] == 1234
    assert store.dashboard()['customers'][0]['spent'] == 2468
    assert store.dashboard()['best'][0]['units'] == 2
    with pytest.raises(Conflict):
        store.place_order(CUSTOMER, {product: 1}, 'now', 'request-1')


def test_rejected_checkout_leaves_everything_unchanged(store):
    first = store.create_product(PRODUCT)
    second = store.create_product({**PRODUCT, 'stock': 0})
    with pytest.raises(BagChanged):
        store.place_order(CUSTOMER, {first: 1, second: 1}, 'now', 'request')
    assert store.get('PRODUCTS', first)['stock'] == 5
    assert store.get('STATS')['orders'] == 0
    assert store.query('ORDERS') == []


def test_transaction_rejects_intervening_price_or_stock_change(store, monkeypatch):
    product = store.create_product(PRODUCT)
    transact = store.client.transact_write_items
    def race(**kwargs):
        store.update_product(product, {**PRODUCT, 'stock': 0}, 1)
        return transact(**kwargs)
    monkeypatch.setattr(store.client, 'transact_write_items', race)
    with pytest.raises(BagChanged):
        store.place_order(CUSTOMER, {product: 1}, 'now', 'request')
    assert store.get('STATS')['orders'] == 0
    assert store.query('ORDERS') == []


def test_stale_owner_edit_cannot_restore_sold_stock(store):
    product = store.create_product(PRODUCT)
    store.place_order(CUSTOMER, {product: 1}, 'now', 'request')
    with pytest.raises(Conflict):
        store.update_product(product, PRODUCT, 1)
    assert store.get('PRODUCTS', product)['stock'] == 4
    with pytest.raises(KeyError):
        store.update_order(999, 'completed')
    assert store.get('ORDERS', 999) is None


def test_fifty_line_checkout(store):
    identifiers = [store.create_product(PRODUCT) for _ in range(50)]
    identifier = store.place_order(CUSTOMER, dict.fromkeys(identifiers, 1), 'now', 'big-bag')
    assert len(store.get('ORDERS', identifier)['items']) == 50
    assert store.get('STATS')['revenue'] == 50 * 1234


def test_pagination(store):
    for i in range(40):
        store.table.put_item(Item={**key('ORDERS', i + 1), 'payload': 'x' * 30000})
    assert len(store.query('ORDERS')) == 40
    assert [o['id'] for o in store.query('ORDERS', 30)] == list(range(40, 10, -1))


def test_migration_preserves_ids_history_and_counters(store):
    resource = store.resource
    create_table(resource, 'migration-target')
    target = Store(resource, 'migration-target')
    rows = {'products': [{'id': 12, **PRODUCT}],
            'orders': [{'id': 42, **CUSTOMER, 'subtotal_paise': 2468, 'created_at': 'yesterday',
                        'status': 'completed', 'payment_method': 'cash_on_delivery'}],
            'order_items': [{'id': 77, 'order_id': 42, 'product_id': 12, 'product_name': 'Old flower name',
                             'unit_price_paise': 1234, 'quantity': 2}]}
    migrate(target, rows)
    migrate(target, rows)
    assert target.get('ORDERS', 42)['items'][0]['product_name'] == 'Old flower name'
    assert target.get('ORDERS', 42)['items'][0]['id'] == 77
    assert target.get('PRODUCTS', 12)['stock'] == 5
    assert target.next_id('products') == 13
    assert target.next_id('orders') == 43
    assert target.dashboard()['stats']['revenue'] == 2468
    with pytest.raises(ValueError):
        migrate(target, EMPTY)
    with pytest.raises(ValueError):
        migrate(target, rows)  # counters have changed; no silent overwrite


def test_import_rejects_populated_target(store):
    create_table(store.resource, 'occupied')
    target = Store(store.resource, 'occupied')
    target.table.put_item(Item={**key('PRODUCTS', 1), **PRODUCT})
    with pytest.raises(ValueError):
        migrate(target, EMPTY)
    assert target.get('MIGRATION') is None


def test_interrupted_migration_resumes(store, monkeypatch):
    create_table(store.resource, 'resume')
    target = Store(store.resource, 'resume')
    original = target.table.put_item
    def fail_stats(**kwargs):
        if kwargs['Item']['collection'] == 'STATS':
            raise RuntimeError('simulated interruption')
        return original(**kwargs)
    monkeypatch.setattr(target.table, 'put_item', fail_stats)
    with pytest.raises(RuntimeError):
        migrate(target, EMPTY)
    assert target.get('MIGRATION')['state'] == 'IMPORTING'
    monkeypatch.setattr(target.table, 'put_item', original)
    migrate(target, EMPTY)
    target.ensure_ready()


def checkout_form(client, product):
    response = client.get('/')
    token = re.search(r'name="checkout_token" value="([^"]+)"', response.text)[1]
    with client.session_transaction() as session:
        csrf = session['csrf']
    return dict(csrf=csrf, checkout_token=token, name='Customer', email='test@example.invalid',
                phone='123', address='Test address', items='[{"id":%d,"quantity":1}]' % product)


def test_flask_routes_and_owner_protection(store):
    product = store.create_product(PRODUCT)
    client = web.app.test_client()
    form = checkout_form(client, product)
    assert client.post('/orders', data=form).status_code == 200
    assert client.post('/orders', data=form).status_code == 200
    assert store.get('STATS')['orders'] == 1
    assert client.get('/owner/orders/1').status_code == 302
    assert client.get('/owner').status_code == 302
    assert client.post('/owner/orders/1', data={'status': 'completed'}).status_code == 302
    with client.session_transaction() as session:
        session['owner'] = True
    assert client.get('/owner').status_code == 200
    assert client.get('/owner/orders/1').status_code == 200
    assert client.post('/owner/orders/1', data={'csrf': form['csrf'], 'status': 'completed'}).status_code == 302
    assert store.get('ORDERS', 1)['status'] == 'completed'
    assert 'test@example.invalid' not in client.get('/').text


def test_invalid_checkout_and_empty_csrf(store):
    product = store.create_product(PRODUCT)
    client = web.app.test_client()
    assert client.post('/orders', data={}).status_code == 400
    form = checkout_form(client, product)
    for invalid in ('[]', 'null', '[{"id":true,"quantity":1}]', '[{"id":1,"quantity":true}]',
                    '[{"id":1,"quantity":99},{"id":1,"quantity":99}]'):
        assert client.post('/orders', data={**form, 'items': invalid}).status_code == 400
    assert client.post('/orders', data={**form, 'checkout_token': 'forged'}).status_code == 400
    other_client = web.app.test_client()
    other_form = checkout_form(other_client, product)
    assert other_client.post('/orders', data={**other_form, 'checkout_token': form['checkout_token']}).status_code == 400
    assert store.get('STATS')['orders'] == 0


def test_new_table_waits_for_backup_readiness(store, monkeypatch):
    client = store.client
    update = client.update_continuous_backups
    calls = []
    def initially_unavailable(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            raise client.exceptions.ContinuousBackupsUnavailableException(
                {'Error': {'Code': 'ContinuousBackupsUnavailableException', 'Message': 'initializing'}},
                'UpdateContinuousBackups')
        return update(**kwargs)
    monkeypatch.setattr(client, 'update_continuous_backups', initially_unavailable)
    monkeypatch.setattr('migrate.time.sleep', lambda seconds: None)
    create_table(store.resource, 'test-happy-knots')
    assert len(calls) == 2


def test_owner_product_create_edit_and_validation(store):
    client = web.app.test_client()
    client.get('/')
    with client.session_transaction() as session:
        session['owner'] = True
        token = session['csrf']
    form = dict(csrf=token, name='Flower', category='Gift', description='test',
                price='12.34', stock='4', image='')
    assert client.post('/owner/products', data=form).status_code == 302
    product = store.products()[0]
    assert product['price_paise'] == 1234
    assert client.post(f"/owner/products/{product['id']}", data={**form, 'version': 1, 'active': 'on', 'stock': '3'}).status_code == 302
    assert client.post(f"/owner/products/{product['id']}", data={**form, 'version': 1}).status_code == 409
    for price in ('NaN', 'Infinity', '-1', 'not-money'):
        assert client.post('/owner/products', data={**form, 'price': price}).status_code == 400

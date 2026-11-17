"""Offline, resumable SQLite migration. Default invocation only validates data."""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import BotoCoreError, ClientError
from storage import DEFAULT_TABLE, REGION, Store, dynamodb_resource, key, native


def create_table(resource, name):
    client = resource.meta.client
    try:
        description = client.describe_table(TableName=name)["Table"]
    except client.exceptions.ResourceNotFoundException:
        client.create_table(
            TableName=name, BillingMode="PAY_PER_REQUEST", DeletionProtectionEnabled=True,
            AttributeDefinitions=[{"AttributeName": n, "AttributeType": t} for n, t in
                                  [("collection", "S"), ("id", "N"), ("rank_group", "S"), ("rank_value", "N")]],
            KeySchema=[{"AttributeName": "collection", "KeyType": "HASH"}, {"AttributeName": "id", "KeyType": "RANGE"}],
            GlobalSecondaryIndexes=[{
                "IndexName": "rankings", "KeySchema": [{"AttributeName": "rank_group", "KeyType": "HASH"},
                                                        {"AttributeName": "rank_value", "KeyType": "RANGE"}],
                "Projection": {"ProjectionType": "INCLUDE", "NonKeyAttributes":
                               ["name", "units", "sales_revenue", "customer_name", "email", "orders", "spent"]}}],
            Tags=[{"Key": "Application", "Value": "HappyKnots"}])
        client.get_waiter("table_exists").wait(TableName=name, WaiterConfig={"Delay": 2, "MaxAttempts": 60})
        description = client.describe_table(TableName=name)["Table"]
    expected = [{"AttributeName": "collection", "KeyType": "HASH"}, {"AttributeName": "id", "KeyType": "RANGE"}]
    indexes = description.get("GlobalSecondaryIndexes", [])
    rank_keys = [{"AttributeName": "rank_group", "KeyType": "HASH"}, {"AttributeName": "rank_value", "KeyType": "RANGE"}]
    expected_projection = {"name", "units", "sales_revenue", "customer_name", "email", "orders", "spent"}
    types = {a["AttributeName"]: a["AttributeType"] for a in description["AttributeDefinitions"]}
    if (description["KeySchema"] != expected or len(indexes) != 1 or indexes[0]["IndexName"] != "rankings"
            or indexes[0]["KeySchema"] != rank_keys
            or indexes[0]["Projection"]["ProjectionType"] != "INCLUDE"
            or set(indexes[0]["Projection"].get("NonKeyAttributes", [])) != expected_projection
            or types != {"collection": "S", "id": "N", "rank_group": "S", "rank_value": "N"}):
        raise ValueError("Existing table has an incompatible schema; no data was imported")
    if not description.get("DeletionProtectionEnabled"):
        client.update_table(TableName=name, DeletionProtectionEnabled=True)
    # ACTIVE can precede backup readiness on a newly created real table.
    for attempt in range(12):
        try:
            client.update_continuous_backups(TableName=name, PointInTimeRecoverySpecification={
                "PointInTimeRecoveryEnabled": True, "RecoveryPeriodInDays": 35})
            break
        except client.exceptions.ContinuousBackupsUnavailableException:
            if attempt == 11:
                raise
            time.sleep(5)


def read_sqlite(path):
    if not path.is_file():
        raise ValueError(f"SQLite source does not exist: {path}")
    snapshot = sqlite3.connect(":memory:")
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as source:
        source.backup(snapshot)
    snapshot.row_factory = sqlite3.Row
    if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("SQLite integrity check failed")
    if snapshot.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("SQLite has broken foreign keys")
    rows = {name: [dict(row) for row in snapshot.execute(f"SELECT * FROM {name} ORDER BY id")]
            for name in ("products", "orders", "order_items")}
    return snapshot, rows


def build_items(rows):
    def validate(value, location):
        if isinstance(value, (float, bytes)):
            raise ValueError(f"Unsupported SQLite value at {location}: {type(value).__name__}")
        if isinstance(value, dict):
            for name, child in value.items():
                validate(child, f"{location}.{name}")
        elif isinstance(value, (list, tuple)):
            for index, child in enumerate(value):
                validate(child, f"{location}[{index}]")

    validate(rows, "source")
    products = {p["id"]: {**p, "collection": "PRODUCTS", "version": 1, "units": 0, "sales_revenue": 0}
                for p in rows["products"]}
    orders = {o["id"]: {**o, "collection": "ORDERS", "items": []} for o in rows["orders"]}
    customers = {}
    historical = {}
    for p in products.values():
        if type(p["id"]) is not int or p["id"] <= 0 or p["price_paise"] < 0 or p["stock"] < 0:
            raise ValueError("Invalid product identifier, price or stock")
    for item in rows["order_items"]:
        if item["order_id"] not in orders or item["quantity"] <= 0 or item["unit_price_paise"] < 0:
            raise ValueError("Invalid order item")
        orders[item["order_id"]]["items"].append(item)
        product = products.get(item["product_id"])
        if product is None:
            digest = hashlib.sha256(item["product_name"].encode()).hexdigest()
            product = historical.setdefault(digest, {**key("HISTORICAL#" + digest), "name": item["product_name"],
                                                     "units": 0, "sales_revenue": 0})
        product["units"] += item["quantity"]
        product["sales_revenue"] += item["unit_price_paise"] * item["quantity"]
        product.update(rank_group="PRODUCT_SALES", rank_value=product["units"])
    for order in orders.values():
        if order["id"] <= 0 or sum(i["unit_price_paise"] * i["quantity"] for i in order["items"]) != order["subtotal_paise"]:
            raise ValueError("Order subtotal does not match its line items")
        digest = hashlib.sha256(order["email"].encode()).hexdigest()
        customer = customers.setdefault(digest, {**key("CUSTOMER#" + digest), "email": order["email"],
                                                 "orders": 0, "spent": 0, "rank_group": "CUSTOMER_SPEND"})
        customer["customer_name"] = order["customer_name"]
        customer["orders"] += 1
        customer["spent"] += order["subtotal_paise"]
        customer["rank_value"] = customer["spent"]
    result = [*products.values(), *orders.values(), *customers.values(), *historical.values(),
              {**key("STATS"), "orders": len(orders), "revenue": sum(o["subtotal_paise"] for o in orders.values())},
              {**key("COUNTER#products"), "value": max(products, default=0)},
              {**key("COUNTER#orders"), "value": max(orders, default=0)}]
    for item in result:
        # Conservative margin for DynamoDB's 400 KiB limit, including attribute names.
        if len(json.dumps(item, ensure_ascii=False).encode()) > 350_000:
            raise ValueError("A source record is too large for the migration's 350 KB safety limit")
    return result


def all_items(store):
    return [native(item) for page in store.client.get_paginator("scan").paginate(
        TableName=store.table.name, ConsistentRead=True) for item in page.get("Items", [])]


def migrate(store, rows):
    items = build_items(rows)
    fingerprint = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    existing = all_items(store)
    marker = next((i for i in existing if i["collection"] == "MIGRATION"), None)
    if marker is None:
        if existing:
            raise ValueError("Target is not empty. Refusing to merge or overwrite existing data")
        store.table.put_item(Item={**key("MIGRATION"), "state": "IMPORTING", "source_sha256": fingerprint},
                             ConditionExpression=Attr("collection").not_exists())
    elif marker.get("source_sha256") != fingerprint:
        raise ValueError("Target belongs to another SQLite snapshot; refusing to overwrite")
    elif marker["state"] == "READY":
        verify(store, items)
        return
    for item in items:
        try:
            store.table.put_item(Item=item, ConditionExpression=Attr("collection").not_exists())
        except store.client.exceptions.ConditionalCheckFailedException:
            if store.get(item["collection"], item["id"]) != item:
                raise ValueError("Target changed during import; refusing to overwrite")
    verify(store, items)
    store.table.update_item(Key=key("MIGRATION"), UpdateExpression="SET #s = :ready",
                            ExpressionAttributeNames={"#s": "state"}, ExpressionAttributeValues={":ready": "READY"},
                            ConditionExpression=Attr("source_sha256").eq(fingerprint) & Attr("state").eq("IMPORTING"))


def verify(store, expected):
    actual = [item for item in all_items(store) if item["collection"] != "MIGRATION"]
    by_key = lambda items: {(item["collection"], item["id"]): item for item in items}
    if by_key(actual) != by_key(expected):
        raise ValueError("Verification failed: target records differ from the source; keep writers stopped")


def ensure_backup(snapshot, backup_path):
    """Keep a verified SQLite backup before any AWS writes."""
    def digest(connection):
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite backup failed integrity check")
        return hashlib.sha256("\n".join(connection.iterdump()).encode()).digest()

    expected = digest(snapshot)
    if backup_path.exists():
        try:
            with sqlite3.connect(backup_path) as existing:
                if digest(existing) == expected:
                    return
        except (sqlite3.Error, ValueError):
            pass
    fd, temporary = tempfile.mkstemp(prefix=".sqlite-backup-", suffix=".db", dir=backup_path.parent)
    os.close(fd)
    try:
        with sqlite3.connect(temporary) as backup:
            snapshot.backup(backup)
            if digest(backup) != expected:
                raise ValueError("SQLite backup does not match source snapshot")
        os.replace(temporary, backup_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).parent / "store.db")
    parser.add_argument("--table", default=DEFAULT_TABLE)
    parser.add_argument("--profile")
    parser.add_argument("--apply", action="store_true", help="Create/configure the table and import; stop all writers first")
    args = parser.parse_args()
    try:
        snapshot, rows = read_sqlite(args.source)
        items = build_items(rows)
        print(json.dumps({"source_counts": {k: len(v) for k, v in rows.items()}, "target_items": len(items), "region": REGION}))
        if not args.apply:
            print("Validation passed. No AWS changes made. Stop all writers before using --apply.")
            return 0
        backup_dir = args.source.parent / "backups"
        backup_dir.mkdir(mode=0o700, exist_ok=True)
        digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()[:16]
        backup_path = backup_dir / f"sqlite-before-dynamodb-{digest}.db"
        ensure_backup(snapshot, backup_path)
        resource = dynamodb_resource(args.profile)
        create_table(resource, args.table)
        migrate(Store(resource, args.table), rows)
        print("Migration verified. DynamoDB is READY. SQLite and a backup have been retained.")
        return 0
    except (ValueError, sqlite3.Error, BotoCoreError, ClientError) as exc:
        print(f"Migration failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

"""DynamoDB persistence for the single-shop Happy Knots application."""
import hashlib
import json
import os
import time
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.config import Config

REGION = "ap-southeast-2"
DEFAULT_TABLE = "happy-knots"


class BagChanged(Exception):
    pass


class Conflict(Exception):
    pass


class NotReady(Exception):
    pass


def native(value):
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, dict):
        return {k: native(v) for k, v in value.items()}
    if isinstance(value, list):
        return [native(v) for v in value]
    return value


def key(collection, identifier=0):
    return {"collection": collection, "id": identifier}


def dynamodb_resource(profile=None):
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", REGION))
    if region != REGION:
        raise ValueError(f"Happy Knots must use {REGION}")
    return boto3.Session(profile_name=profile, region_name=REGION).resource(
        "dynamodb", config=Config(retries={"mode": "standard", "total_max_attempts": 4},
                                connect_timeout=5, read_timeout=15))


class Store:
    def __init__(self, resource=None, table_name=None):
        self.resource = resource or dynamodb_resource()
        self.table = self.resource.Table(table_name or os.environ.get("DYNAMODB_TABLE", DEFAULT_TABLE))
        self.client = self.table.meta.client

    def get(self, collection, identifier=0):
        return native(self.table.get_item(Key=key(collection, identifier), ConsistentRead=True).get("Item"))

    def ensure_ready(self):
        if (self.get("MIGRATION") or {}).get("state") != "READY":
            raise NotReady("Run migrate.py before starting the shop")

    def query(self, collection, limit=None, index=False):
        kwargs = {"TableName": self.table.name,
                  "KeyConditionExpression": Key("rank_group" if index else "collection").eq(collection),
                  "ScanIndexForward": False}
        if index:
            kwargs["IndexName"] = "rankings"
        else:
            kwargs["ConsistentRead"] = True
        if limit:
            kwargs["PaginationConfig"] = {"PageSize": limit}
        result = []
        for page in self.client.get_paginator("query").paginate(**kwargs):
            result.extend(native(page.get("Items", [])))
            if limit and len(result) >= limit:
                return result[:limit]
        return result

    def products(self, active_only=False):
        products = self.query("PRODUCTS")
        return [p for p in products if p["active"]] if active_only else products

    def next_id(self, entity):
        result = self.table.update_item(
            Key=key("COUNTER#" + entity), UpdateExpression="ADD #v :one",
            ExpressionAttributeNames={"#v": "value"}, ExpressionAttributeValues={":one": 1},
            ReturnValues="UPDATED_NEW")
        return int(result["Attributes"]["value"])

    def create_product(self, values):
        identifier = self.next_id("products")
        self.table.put_item(Item={**key("PRODUCTS", identifier), **values, "version": 1,
                                  "units": 0, "sales_revenue": 0},
                            ConditionExpression=Attr("collection").not_exists())
        return identifier

    def update_product(self, identifier, values, version):
        names = {f"#f{i}": field for i, field in enumerate(values)}
        vals = {f":v{i}": value for i, value in enumerate(values.values())}
        names["#version"] = "version"
        vals[":one"] = 1
        expression = ", ".join(f"#f{i} = :v{i}" for i in range(len(values)))
        try:
            self.table.update_item(
                Key=key("PRODUCTS", identifier),
                UpdateExpression="SET " + expression + " ADD #version :one",
                ExpressionAttributeNames=names, ExpressionAttributeValues=vals,
                ConditionExpression=Attr("collection").exists() & Attr("version").eq(version))
        except self.client.exceptions.ConditionalCheckFailedException as exc:
            raise Conflict("Product changed; reload before saving") from exc

    def update_order(self, identifier, status):
        try:
            self.table.update_item(Key=key("ORDERS", identifier), UpdateExpression="SET #s = :s",
                                   ExpressionAttributeNames={"#s": "status"},
                                   ExpressionAttributeValues={":s": status},
                                   ConditionExpression=Attr("collection").exists())
        except self.client.exceptions.ConditionalCheckFailedException as exc:
            raise KeyError(identifier) from exc

    def dashboard(self):
        return {"stats": self.get("STATS") or {"orders": 0, "revenue": 0},
                "products": self.products(), "orders": self.query("ORDERS", 30),
                "best": [{**p, "product_name": p["name"]} for p in self.query("PRODUCT_SALES", 5, True)],
                "customers": self.query("CUSTOMER_SPEND", 5, True)}

    def account_profile(self, subject):
        return self.get("ACCOUNT#" + subject) or {"addresses": [], "version": 0}

    def save_account_profile(self, subject, values, version):
        try:
            self.table.put_item(
                Item={**key("ACCOUNT#" + subject), **values, "version": version + 1},
                ConditionExpression=(Attr("version").eq(version) if version else Attr("collection").not_exists()))
        except self.client.exceptions.ConditionalCheckFailedException as exc:
            raise Conflict("Your saved details changed. Refresh this page and try again.") from exc

    def account_orders(self, subject, before=None):
        condition = Key("collection").eq("ACCOUNT#" + subject) & Key("id").gt(0)
        kwargs = {"KeyConditionExpression": condition, "ConsistentRead": True,
                  "ScanIndexForward": False, "Limit": 20}
        if before:
            kwargs["ExclusiveStartKey"] = key("ACCOUNT#" + subject, before)
        response = self.table.query(**kwargs)
        refs = native(response.get("Items", []))
        orders = [self.account_order(subject, ref["id"]) for ref in refs]
        cursor = native(response.get("LastEvaluatedKey", {})).get("id")
        return [order for order in orders if order], cursor

    def account_order(self, subject, identifier):
        if not self.get("ACCOUNT#" + subject, identifier):
            return None
        order = self.get("ORDERS", identifier)
        return order if order and order.get("customer_sub") == subject else None

    def auth_record(self, namespace, identifier):
        collection = namespace + "#" + hashlib.sha256(identifier.encode()).hexdigest()
        record = self.get(collection)
        if record and record.get("expires_at", 0) > int(time.time()):
            return record
        return None

    def put_auth_record(self, namespace, identifier, values):
        collection = namespace + "#" + hashlib.sha256(identifier.encode()).hexdigest()
        self.table.put_item(Item={**key(collection), **values})

    def delete_auth_record(self, namespace, identifier):
        collection = namespace + "#" + hashlib.sha256(identifier.encode()).hexdigest()
        self.table.delete_item(Key=key(collection))

    def place_order(self, customer, quantities, created_at, token, subject=None):
        fingerprint = hashlib.sha256(json.dumps([customer, sorted(quantities.items()), subject],
                                                sort_keys=True).encode()).hexdigest()
        receipt_collection = "CHECKOUT#" + hashlib.sha256(token.encode()).hexdigest()

        def previous_order():
            receipt = self.get(receipt_collection)
            if receipt:
                if receipt["fingerprint"] != fingerprint:
                    raise Conflict("This checkout was already used for a different order")
                return receipt["order_id"]
            return None

        existing = previous_order()
        if existing is not None:
            return existing
        products = [self.get("PRODUCTS", identifier) for identifier in quantities]
        if any(not p or not p["active"] or p["stock"] < quantities[p["id"]] for p in products):
            raise BagChanged()
        order_id = self.next_id("orders")
        items = [{"product_id": p["id"], "product_name": p["name"],
                  "unit_price_paise": p["price_paise"], "quantity": quantities[p["id"]]}
                 for p in products]
        total = sum(i["unit_price_paise"] * i["quantity"] for i in items)
        order = {**key("ORDERS", order_id), **customer, "subtotal_paise": total,
                 "created_at": created_at, "status": "new", "payment_method": "cash_on_delivery", "items": items}
        if subject:
            order["customer_sub"] = subject
        writes = [{"Put": {"TableName": self.table.name, "Item": item,
                           "ConditionExpression": "attribute_not_exists(#pk)",
                           "ExpressionAttributeNames": {"#pk": "collection"}}}
                  for item in [order, {**key(receipt_collection), "fingerprint": fingerprint, "order_id": order_id}]]
        if subject:
            writes.append({"Put": {"TableName": self.table.name,
                                   "Item": {**key("ACCOUNT#" + subject, order_id), "kind": "order_reference"},
                                   "ConditionExpression": "attribute_not_exists(#pk)",
                                   "ExpressionAttributeNames": {"#pk": "collection"}}})
        for p in products:
            quantity = quantities[p["id"]]
            writes.append({"Update": {
                "TableName": self.table.name, "Key": key("PRODUCTS", p["id"]),
                "UpdateExpression": "SET #stock = #stock - :qty, rank_group = :group ADD #v :one, #units :qty, rank_value :qty, sales_revenue :revenue",
                "ConditionExpression": "attribute_exists(#pk) AND #active = :one AND #stock >= :qty AND #v = :version",
                "ExpressionAttributeNames": {"#v": "version", "#pk": "collection", "#active": "active", "#stock": "stock", "#units": "units"},
                "ExpressionAttributeValues": {":qty": quantity, ":one": 1, ":version": p["version"],
                                              ":group": "PRODUCT_SALES", ":revenue": quantity * p["price_paise"]}}})
        writes.append({"Update": {"TableName": self.table.name, "Key": key("STATS"),
                                  "UpdateExpression": "ADD #o :one, revenue :total",
                                  "ExpressionAttributeNames": {"#o": "orders"},
                                  "ExpressionAttributeValues": {":one": 1, ":total": total}}})
        customer_key = "CUSTOMER#" + hashlib.sha256(customer["email"].encode()).hexdigest()
        writes.append({"Update": {
            "TableName": self.table.name, "Key": key(customer_key),
            "UpdateExpression": "SET customer_name = :name, email = :email, rank_group = :group ADD #o :one, spent :total, rank_value :total",
            "ExpressionAttributeNames": {"#o": "orders"},
            "ExpressionAttributeValues": {":name": customer["customer_name"], ":email": customer["email"],
                                          ":group": "CUSTOMER_SPEND", ":one": 1, ":total": total}}})
        try:
            self.client.transact_write_items(TransactItems=writes,
                                             ClientRequestToken=hashlib.sha256(json.dumps(native(writes), sort_keys=True).encode()).hexdigest()[:36])
        except self.client.exceptions.TransactionCanceledException as exc:
            existing = previous_order()
            if existing is not None:
                return existing
            reasons = [r.get("Code") for r in exc.response.get("CancellationReasons", [])]
            if any(r in ("ConditionalCheckFailed", "TransactionConflict") for r in reasons):
                raise BagChanged() from exc
            raise
        return order_id

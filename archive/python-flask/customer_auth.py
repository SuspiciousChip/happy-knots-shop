"""Cognito OIDC login; tokens remain in server-side DynamoDB sessions."""
import hashlib
import secrets
import time
from functools import wraps
from urllib.parse import urlencode

import jwt
import requests
from authlib.integrations.flask_client import OAuth
from authlib.integrations.base_client.errors import OAuthError
from authlib.integrations.requests_client import OAuth2Session
from boto3.dynamodb.conditions import Attr
from flask import abort, g, redirect, render_template, request, session, url_for
from joserfc.errors import JoseError

from storage import Conflict, NotReady, REGION, key


class LoginRequired(Exception):
    pass


class StateCache:
    def __init__(self, get_store):
        self.get_store = get_store

    def get(self, name):
        record = self.get_store().auth_record("AUTH_STATE", name)
        return record["value"] if record else None

    def set(self, name, value, timeout):
        self.get_store().put_auth_record("AUTH_STATE", name,
                                         {"value": value, "expires_at": int(time.time()) + min(timeout, 600)})

    def delete(self, name):
        self.get_store().delete_auth_record("AUTH_STATE", name)


class CustomerAuth:
    def __init__(self, app, get_store, check_csrf):
        self.app, self.get_store = app, get_store
        self.config = app.config
        self.enabled = bool(self.config.get("COGNITO_POOL_ID") and self.config.get("COGNITO_CLIENT_ID"))
        self.oauth = OAuth(app, cache=StateCache(get_store))
        self.jwks = None
        if self.enabled:
            if not self.config["COGNITO_POOL_ID"].startswith(REGION + "_"):
                raise ValueError("Customer login must use the Sydney Cognito pool")
            self.issuer = f"https://cognito-idp.{REGION}.amazonaws.com/{self.config['COGNITO_POOL_ID']}"
            self.jwks = jwt.PyJWKClient(self.issuer + "/.well-known/jwks.json", timeout=5)
            self.oauth.register(
                "cognito", client_id=self.config["COGNITO_CLIENT_ID"],
                client_secret=self.config.get("COGNITO_CLIENT_SECRET"),
                server_metadata_url=self.issuer + "/.well-known/openid-configuration",
                client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256",
                               "token_endpoint_auth_method": "client_secret_basic", "timeout": 10})

        app.add_url_rule("/account/login", "customer_login", self.login)
        app.add_url_rule("/account/signup", "customer_signup", self.login)
        app.add_url_rule("/account/callback", "customer_callback", self.callback)
        app.add_url_rule("/account/logout", "customer_logout", lambda: self.logout(check_csrf), methods=["POST"])

        @app.errorhandler(LoginRequired)
        def login_required(_):
            session.pop("customer_session", None)
            return redirect(url_for("customer_login"))

    def validate_access(self, token):
        signing_key = self.jwks.get_signing_key_from_jwt(token)
        claims = jwt.decode(token, signing_key.key, algorithms=["RS256"], issuer=self.issuer,
                            options={"verify_aud": False, "require": ["exp", "iat", "sub", "iss", "client_id", "token_use"]})
        if claims["token_use"] != "access" or claims["client_id"] != self.config["COGNITO_CLIENT_ID"]:
            raise jwt.InvalidTokenError("Unexpected Cognito token")
        return claims

    def current(self):
        if "customer" in g:
            return g.customer
        g.customer = None
        sid = session.get("customer_session")
        if not sid:
            return None
        if not self.enabled:
            raise NotReady("Customer login is not configured")
        record = self.get_store().auth_record("AUTH_SESSION", sid)
        if not record:
            session.pop("customer_session", None)
            raise LoginRequired()
        try:
            if record["access_expires_at"] <= int(time.time()) + 30:
                record = self.refresh(sid, record)
            claims = self.validate_access(record["access_token"])
            if claims["sub"] != record["sub"]:
                raise jwt.InvalidTokenError("Subject mismatch")
        except jwt.PyJWKClientConnectionError as exc:
            raise NotReady("Login verification is temporarily unavailable") from exc
        except (jwt.InvalidTokenError, OAuthError) as exc:
            self.get_store().delete_auth_record("AUTH_SESSION", sid)
            session.pop("customer_session", None)
            raise LoginRequired() from exc
        g.customer = {"sub": record["sub"], "email": record["email"], "name": record.get("name", "")}
        return g.customer

    def required(self, fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            if not self.current():
                return redirect(url_for("customer_login"))
            return fn(*args, **kwargs)
        return wrapped

    def login(self):
        if not self.enabled:
            return render_template("message.html", title="Customer accounts are being prepared",
                                   message="Please try again shortly. You can still shop and check out as a guest."), 503
        if request.host_url.rstrip("/") != self.config["APP_BASE_URL"]:
            # Fixed configured origin avoids Host-header injection and mismatched cookies.
            return redirect(self.config["APP_BASE_URL"] + request.path)
        kwargs = {"nonce": secrets.token_urlsafe(32)}
        if request.endpoint == "customer_signup":
            kwargs["screen_hint"] = "signup"
        return self.oauth.cognito.authorize_redirect(self.config["APP_BASE_URL"] + "/account/callback", **kwargs)

    def callback(self):
        if not self.enabled:
            abort(503)
        try:
            token = self.oauth.cognito.authorize_access_token(leeway=15)
            identity = token.get("userinfo", {})
            claims = self.validate_access(token["access_token"])
            if (identity.get("email_verified") is not True or not identity.get("email")
                    or identity.get("sub") != claims["sub"] or identity.get("token_use") != "id"):
                raise jwt.InvalidTokenError("A verified email is required")
            old = session.get("customer_session")
            if old:
                self.get_store().delete_auth_record("AUTH_SESSION", old)
            sid = secrets.token_urlsafe(32)
            self.get_store().put_auth_record("AUTH_SESSION", sid, {
                "sub": claims["sub"], "email": identity["email"], "name": identity.get("name", ""),
                "access_token": token["access_token"], "refresh_token": token["refresh_token"],
                "access_expires_at": int(claims["exp"]), "expires_at": int(time.time()) + 30 * 86400})
            # Rotate the browser session and CSRF token; never grant owner permissions.
            session.clear()
            session["customer_session"] = sid
            session.permanent = True
            return redirect(url_for("customer_account"))
        except (OAuthError, JoseError, jwt.InvalidTokenError, jwt.PyJWKClientError, KeyError):
            return render_template("message.html", title="We couldn't complete sign-in",
                                   message="The sign-in link may have expired. Return to the shop and try signing in again."), 400

    def refresh(self, sid, record):
        store = self.get_store()
        collection = "AUTH_SESSION#" + hashlib.sha256(sid.encode()).hexdigest()
        lock = secrets.token_hex(16)
        now = int(time.time())
        try:
            store.table.update_item(Key=key(collection),
                UpdateExpression="SET refresh_lock = :lock, lock_until = :until",
                ExpressionAttributeValues={":lock": lock, ":until": now + 45},
                ConditionExpression=Attr("expires_at").gt(now) & Attr("access_token").eq(record["access_token"]) &
                    (Attr("lock_until").not_exists() | Attr("lock_until").lt(now)))
        except store.client.exceptions.ConditionalCheckFailedException:
            latest = store.auth_record("AUTH_SESSION", sid)
            if latest and latest["access_expires_at"] > now + 30:
                return latest
            raise NotReady("Your login is refreshing. Please retry shortly.")
        try:
            with OAuth2Session(self.config["COGNITO_CLIENT_ID"], self.config["COGNITO_CLIENT_SECRET"],
                               token_endpoint_auth_method="client_secret_basic") as client:
                token = client.refresh_token(self.config["COGNITO_DOMAIN"] + "/oauth2/token",
                                             refresh_token=record["refresh_token"], timeout=10)
            claims = self.validate_access(token["access_token"])
            if claims["sub"] != record["sub"]:
                raise jwt.InvalidTokenError("Subject mismatch")
            updated = {**record, "access_token": token["access_token"],
                       "refresh_token": token.get("refresh_token", record["refresh_token"]),
                       "access_expires_at": int(claims["exp"])}
            updated.pop("refresh_lock", None)
            updated.pop("lock_until", None)
            # If logout deleted the session while the network call ran, never resurrect it.
            store.table.put_item(Item=updated, ConditionExpression=Attr("refresh_lock").eq(lock))
            return updated
        except store.client.exceptions.ConditionalCheckFailedException as exc:
            raise LoginRequired() from exc
        finally:
            try:
                store.table.update_item(Key=key(collection), UpdateExpression="REMOVE refresh_lock, lock_until",
                                        ConditionExpression=Attr("refresh_lock").eq(lock))
            except store.client.exceptions.ConditionalCheckFailedException:
                pass

    def logout(self, check_csrf):
        check_csrf()
        sid = session.get("customer_session")
        if sid:
            record = self.get_store().auth_record("AUTH_SESSION", sid)
            self.get_store().delete_auth_record("AUTH_SESSION", sid)
            if record and self.enabled:
                try:
                    requests.post(self.config["COGNITO_DOMAIN"] + "/oauth2/revoke",
                                  auth=(self.config["COGNITO_CLIENT_ID"], self.config["COGNITO_CLIENT_SECRET"]),
                                  data={"token": record["refresh_token"]}, timeout=10).raise_for_status()
                except requests.RequestException:
                    self.app.logger.warning("Provider revocation unavailable; local customer session deleted")
        session.clear()
        if self.enabled:
            return redirect(self.config["COGNITO_DOMAIN"] + "/logout?" + urlencode({
                "client_id": self.config["COGNITO_CLIENT_ID"], "logout_uri": self.config["APP_BASE_URL"] + "/"}))
        return redirect(url_for("home"))

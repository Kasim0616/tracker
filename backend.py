"""
Lightweight backend for the job application tracker.

Usage:
    python backend.py

This starts a simple HTTP server with JSON endpoints:
    POST   /api/auth/login          -> login (body: JSON name, pin, optional location)
    GET    /api/applications        -> list applications (requires X-User-Token)
    POST   /api/applications        -> create application (requires X-User-Token)
    PUT    /api/applications/<id>   -> update application (requires X-User-Token)
    DELETE /api/applications/<id>   -> remove application (requires X-User-Token)
    POST   /api/seed                -> seed sample data (requires X-User-Token)
    GET    /api/admin/users         -> admin list of users (requires X-Admin-Token)
    POST   /api/admin/users         -> admin create/update user (requires X-Admin-Token)
    GET    /api/admin/events        -> admin event log (requires X-Admin-Token)

Data is persisted in `data/applications.json`.
No external dependencies are required (standard library only).
"""

from __future__ import annotations

import json
import os
import re
import time
import hashlib
import secrets

from urllib.parse import parse_qs, urlparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict, List, Optional, Tuple
from pymongo import MongoClient, ASCENDING, ReturnDocument
from pymongo.errors import PyMongoError

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
MONGO_DB = os.environ.get("MONGO_DB", "tracker")
# Single admin credential; defaults to the trackeradmin password if env not provided.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "9087700234")
PIN_SALT = os.environ.get("PIN_SALT", "tracker-salt")

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=2000)
db = mongo_client[MONGO_DB]
users_col = db["users"]
apps_col = db["applications"]
events_col = db["events"]
counters_col = db["counters"]

# Indexes for quick lookups and uniqueness
users_col.create_index([("name", ASCENDING)], unique=True)
# Refresh token index to allow multiple null/missing values but enforce uniqueness when set
try:
    users_col.drop_index("token_1")
except PyMongoError:
    pass
users_col.create_index(
    [("token", ASCENDING)],
    unique=True,
    partialFilterExpression={"token": {"$exists": True}},
)
apps_col.create_index([("id", ASCENDING)], unique=True)
apps_col.create_index([("owner", ASCENDING)])
events_col.create_index([("timestamp", ASCENDING)])

APPLICATIONS_ROUTE = re.compile(r"^/api/applications/?$")
APPLICATION_ROUTE_WITH_ID = re.compile(r"^/api/applications/(?P<id>\\d+)/?$")
SEED_ROUTE = re.compile(r"^/api/seed/?$")
AUTH_LOGIN_ROUTE = re.compile(r"^/api/auth/login/?$")
ADMIN_USERS_ROUTE = re.compile(r"^/api/admin/users/?$")
ADMIN_EVENTS_ROUTE = re.compile(r"^/api/admin/events/?$")
ADMIN_CLEAR_EVENTS_ROUTE = re.compile(r"^/api/admin/events/clear/?$")


def parse_path(path: str) -> Tuple[str, Dict[str, str]]:
    parsed = urlparse(path)
    params = {key: values[0] for key, values in parse_qs(parsed.query).items() if values}
    return parsed.path, params


def clean_doc(doc: Optional[Dict]) -> Optional[Dict]:
    if not doc:
        return None
    sanitized = dict(doc)
    sanitized.pop("_id", None)
    return sanitized


def next_app_id() -> int:
    doc = counters_col.find_one_and_update(
        {"_id": "applications"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(doc["seq"])


def hash_pin(pin: str) -> str:
    return hashlib.sha256(f"{PIN_SALT}{pin}".encode("utf-8")).hexdigest()


def user_payload(user: Dict, include_token: bool = False) -> Dict:
    payload = {
        "name": user.get("name", ""),
        "location": user.get("location", ""),
        "createdAt": user.get("createdAt"),
        "lastLogin": user.get("lastLogin"),
        "lastSeen": user.get("lastSeen"),
        "pinSet": bool(user.get("pinHash")),
    }
    if include_token:
        payload["token"] = user.get("token")
    return payload


def respond_db_error(handler: BaseHTTPRequestHandler, err: Exception) -> None:
    print("Database error:", err)
    json_response(handler, 503, {"error": "Database unavailable", "details": str(err)})


def find_user_by_name(name: str) -> Optional[Dict]:
    return users_col.find_one({"name": name})


def find_user_by_token(token: str) -> Optional[Dict]:
    return users_col.find_one({"token": token})


def record_event(event: Dict) -> None:
    events_col.insert_one({**event, "timestamp": int(time.time() * 1000)})
    # Keep only the most recent 2000 events
    count = events_col.count_documents({})
    if count > 2000:
        oldest_to_keep = list(
            events_col.find({}, {"timestamp": 1}).sort("timestamp", -1).skip(2000).limit(1)
        )
        if oldest_to_keep:
            cutoff = oldest_to_keep[0]["timestamp"]
            events_col.delete_many({"timestamp": {"$lt": cutoff}})


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: Dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, X-User-Token")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_json(handler: BaseHTTPRequestHandler) -> Tuple[Optional[Dict], Optional[str]]:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        return None, "Invalid Content-Length"

    raw = handler.rfile.read(length) if length > 0 else b""
    if not raw:
        return {}, None
    try:
        return json.loads(raw.decode("utf-8")), None
    except json.JSONDecodeError as exc:
        return None, f"Invalid JSON: {exc}"


class AppHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        # Quieter logs; override to reduce noise.
        return

    def is_admin(self) -> bool:
        token = self.headers.get("X-Admin-Token", "")
        return bool(ADMIN_TOKEN) and token == ADMIN_TOKEN

    def require_admin(self) -> bool:
        if not self.is_admin():
            json_response(self, 401, {"error": "Admin token invalid"})
            return False
        return True

    def require_user(self) -> Optional[Dict]:
        token = (self.headers.get("X-User-Token") or "").strip()
        if not token:
            json_response(self, 401, {"error": "User token required"})
            return None
        try:
            user = find_user_by_token(token)
        except PyMongoError as err:
            respond_db_error(self, err)
            return None
        if not user:
            json_response(self, 401, {"error": "User token invalid"})
            return None
        now = int(time.time() * 1000)
        users_col.update_one({"_id": user["_id"]}, {"$set": {"lastSeen": now}})
        user["lastSeen"] = now
        return user

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, X-User-Token")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        try:
            path, params = parse_path(self.path)
            if APPLICATIONS_ROUTE.match(path):
                user = self.require_user()
                if not user:
                    return
                owner = user.get("name")
                items = [clean_doc(item) for item in apps_col.find({"owner": owner}).sort("id", -1)]
                json_response(self, 200, {"items": items})
                return

            if ADMIN_USERS_ROUTE.match(path):
                if not self.require_admin():
                    return
                try:
                    counts: Dict[str, int] = {}
                    for doc in apps_col.aggregate(
                        [{"$group": {"_id": {"$ifNull": ["$owner", ""]}, "total": {"$sum": 1}}}]
                    ):
                        counts[doc["_id"]] = doc["total"]
                    users_payload = []
                    for user in users_col.find({}):
                        payload = user_payload(user, include_token=False)
                        payload["totalApplications"] = counts.get(user.get("name", ""), 0)
                        users_payload.append(payload)
                    json_response(
                        self,
                        200,
                        {
                            "users": users_payload,
                            "unassignedApplications": counts.get("", 0),
                            "totalApplications": sum(counts.values()),
                        },
                    )
                except PyMongoError as err:
                    respond_db_error(self, err)
                return

            if ADMIN_EVENTS_ROUTE.match(path):
                if not self.require_admin():
                    return
                try:
                    limit = int(params.get("limit", "1000"))
                except ValueError:
                    limit = 1000
                try:
                    events = [clean_doc(evt) for evt in events_col.find({}).sort("timestamp", -1).limit(limit)]
                    json_response(self, 200, {"events": events})
                except PyMongoError as err:
                    respond_db_error(self, err)
                return

            if ADMIN_CLEAR_EVENTS_ROUTE.match(path):
                if not self.require_admin():
                    return
                json_response(self, 404, {"error": "Use DELETE to clear events"})
                return

            self.not_found()
        except Exception as err:  # noqa: BLE001
            print("Unexpected GET error:", err)
            json_response(self, 500, {"error": "Unexpected server error", "details": str(err)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            path, params = parse_path(self.path)
            if ADMIN_USERS_ROUTE.match(path):
                if not self.require_admin():
                    return
                payload, err = parse_json(self)
                if payload is None:
                    json_response(self, 400, {"error": err or "Invalid payload"})
                    return
                name = (payload.get("name") or "").strip()
                location = (payload.get("location") or "").strip()
                pin = (payload.get("pin") or "").strip()
                if not name:
                    json_response(self, 400, {"error": "name is required"})
                    return
                now = int(time.time() * 1000)
                try:
                    user = find_user_by_name(name)
                    if user:
                        updates: Dict[str, Optional[str]] = {}
                        unset_fields: Dict[str, int] = {}
                        if location:
                            updates["location"] = location
                        if pin:
                            updates["pinHash"] = hash_pin(pin)
                            unset_fields["token"] = 1
                            unset_fields["tokenIssuedAt"] = 1
                        action = "admin_user_update"
                        update_doc: Dict[str, Dict] = {}
                        if updates:
                            update_doc["$set"] = updates
                        if unset_fields:
                            update_doc["$unset"] = unset_fields
                        if update_doc:
                            users_col.update_one({"_id": user["_id"]}, update_doc)
                        user = users_col.find_one({"_id": user["_id"]})
                    else:
                        if not pin:
                            json_response(self, 400, {"error": "pin is required for new users"})
                            return
                        user = {
                            "name": name,
                            "location": location,
                            "pinHash": hash_pin(pin),
                            "createdAt": now,
                            "lastLogin": None,
                            "lastSeen": None,
                        }
                        users_col.insert_one(user)
                        action = "admin_user_create"
                    record_event({"type": action, "owner": name, "ip": self.client_address[0]})
                    json_response(self, 200, user_payload(user, include_token=False))
                except PyMongoError as db_err:
                    respond_db_error(self, db_err)
                return

            if AUTH_LOGIN_ROUTE.match(path):
                payload, err = parse_json(self)
                if payload is None:
                    json_response(self, 400, {"error": err or "Invalid payload"})
                    return
                name = (payload.get("name") or "").strip()
                location = (payload.get("location") or "").strip()
                pin = (payload.get("pin") or "").strip()
                if not name or not pin:
                    json_response(self, 400, {"error": "name and pin are required"})
                    return
                now = int(time.time() * 1000)
                try:
                    user = find_user_by_name(name)
                    if not user:
                        json_response(self, 403, {"error": "User not found. Ask admin to create your account."})
                        return
                    if not user.get("pinHash"):
                        json_response(self, 403, {"error": "User not configured. Admin must set a PIN."})
                        return
                    if hash_pin(pin) != user.get("pinHash"):
                        json_response(self, 403, {"error": "Invalid credentials"})
                        return
                    if location:
                        users_col.update_one({"_id": user["_id"]}, {"$set": {"location": location}})
                    token = secrets.token_hex(24)
                    users_col.update_one(
                        {"_id": user["_id"]},
                        {
                            "$set": {
                                "token": token,
                                "tokenIssuedAt": now,
                                "lastLogin": now,
                                "lastSeen": now,
                            }
                        },
                    )
                    user = users_col.find_one({"_id": user["_id"]})
                    record_event({"type": "login", "owner": name, "ip": self.client_address[0]})
                    json_response(self, 200, user_payload(user, include_token=True))
                except PyMongoError as db_err:
                    respond_db_error(self, db_err)
                return

            if APPLICATIONS_ROUTE.match(path):
                user = self.require_user()
                if not user:
                    return
                payload, err = parse_json(self)
                if payload is None:
                    json_response(self, 400, {"error": err or "Invalid payload"})
                    return
                owner = user.get("name")
                item_id = next_app_id()
                item = {
                    "id": item_id,
                    "company": payload.get("company", "").strip(),
                    "role": payload.get("role", "").strip(),
                    "link": payload.get("link", "").strip(),
                    "date": payload.get("date", "").strip(),
                    "status": payload.get("status", "applied"),
                    "location": payload.get("location", "").strip(),
                    "notes": payload.get("notes", "").strip(),
                    "owner": owner,
                    "createdAt": payload.get("createdAt") or int(time.time() * 1000),
                }
                apps_col.insert_one(item)
                record_event({"type": "create", "owner": owner, "id": item_id, "ip": self.client_address[0]})
                json_response(self, 201, clean_doc(item))
                return

            if SEED_ROUTE.match(path):
                user = self.require_user()
                if not user:
                    return
                owner = user.get("name")
                existing_for_owner = apps_col.count_documents({"owner": owner})
                if existing_for_owner:
                    json_response(self, 400, {"error": "Seed denied: data already exists for this owner"})
                    return
                seeded = seed_examples(owner)
                if seeded:
                    apps_col.insert_many(seeded)
                record_event({"type": "seed", "owner": owner, "count": len(seeded), "ip": self.client_address[0]})
                json_response(self, 201, {"items": [clean_doc(item) for item in seeded]})
                return

            self.not_found()
        except Exception as err:  # noqa: BLE001
            print("Unexpected POST error:", err)
            json_response(self, 500, {"error": "Unexpected server error", "details": str(err)})

    def do_PUT(self) -> None:  # noqa: N802
        try:
            path, params = parse_path(self.path)
            match = APPLICATION_ROUTE_WITH_ID.match(path)
            if not match:
                return self.not_found()

            user = self.require_user()
            if not user:
                return
            payload, err = parse_json(self)
            if payload is None:
                json_response(self, 400, {"error": err or "Invalid payload"})
                return

            owner = user.get("name")
            item_id = int(match.group("id"))
            updated = apps_col.find_one_and_update(
                {"id": item_id, "owner": owner},
                {"$set": {**payload, "id": item_id, "owner": owner}},
                return_document=ReturnDocument.AFTER,
            )

            if not updated:
                json_response(self, 404, {"error": "Application not found"})
                return

            record_event({"type": "update", "owner": owner, "id": item_id, "ip": self.client_address[0]})
            json_response(self, 200, clean_doc(updated))
        except Exception as err:  # noqa: BLE001
            print("Unexpected PUT error:", err)
            json_response(self, 500, {"error": "Unexpected server error", "details": str(err)})

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            path, params = parse_path(self.path)
            match = APPLICATION_ROUTE_WITH_ID.match(path)
            if not match and not ADMIN_USERS_ROUTE.match(path) and not ADMIN_CLEAR_EVENTS_ROUTE.match(path):
                return self.not_found()

            if ADMIN_USERS_ROUTE.match(path):
                if not self.require_admin():
                    return
                name = (params.get("name") or "").strip()
                if not name:
                    json_response(self, 400, {"error": "name query param is required"})
                    return
                try:
                    user = find_user_by_name(name)
                    if not user:
                        json_response(self, 404, {"error": "User not found"})
                        return
                    users_col.delete_one({"_id": user["_id"]})
                    apps_col.delete_many({"owner": name})
                    record_event({"type": "admin_user_delete", "owner": name, "ip": self.client_address[0]})
                    json_response(self, 204, {})
                except PyMongoError as db_err:
                    respond_db_error(self, db_err)
                return

            if ADMIN_CLEAR_EVENTS_ROUTE.match(path):
                if not self.require_admin():
                    return
                try:
                    events_col.delete_many({})
                    json_response(self, 200, {"status": "cleared"})
                except PyMongoError as db_err:
                    respond_db_error(self, db_err)
                return

            user = self.require_user()
            if not user:
                return
            owner = user.get("name")
            item_id = int(match.group("id"))
            result = apps_col.delete_one({"id": item_id, "owner": owner})
            if result.deleted_count == 0:
                json_response(self, 404, {"error": "Application not found"})
                return

            record_event({"type": "delete", "owner": owner, "id": item_id, "ip": self.client_address[0]})
            json_response(self, 204, {})
        except Exception as err:  # noqa: BLE001
            print("Unexpected DELETE error:", err)
            json_response(self, 500, {"error": "Unexpected server error", "details": str(err)})

    def not_found(self) -> None:
        json_response(self, 404, {"error": "Not found"})


def seed_examples(owner: str) -> List[Dict]:
    examples = [
        {
            "company": "Codex Labs",
            "role": "Frontend Engineer",
            "link": "https://jobs.codex.dev/frontend-engineer",
            "date": "2025-02-18",
            "status": "interview",
            "location": "Remote - Europe",
            "notes": "Portfolio review scheduled. Brush up on accessibility stories.",
        },
        {
            "company": "Atlas Biotech",
            "role": "Product Designer",
            "link": "https://careers.atlas.bio/design",
            "date": "2025-02-05",
            "status": "applied",
            "location": "Boston, MA",
            "notes": "Waiting for response. Referred by Olivia.",
        },
        {
            "company": "Northwind Studios",
            "role": "Gameplay Engineer",
            "link": "",
            "date": "2025-01-12",
            "status": "offer",
            "location": "Los Angeles, CA",
            "notes": "Offer in hand. Need to decide by March 1st.",
        },
    ]
    items: List[Dict] = []
    now = int(time.time() * 1000)
    for index, entry in enumerate(examples):
        item_id = next_app_id()
        items.append({**entry, "id": item_id, "owner": owner, "createdAt": now - index * 3600 * 1000})
    return items


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    server = HTTPServer((host, port), AppHandler)
    print(f"Backend running at http://{host}:{port}")
    print("Endpoints: POST /api/auth/login, GET/POST /api/applications, PUT/DELETE /api/applications/<id>, POST /api/seed")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    host = os.environ.get("BACKEND_HOST", "0.0.0.0")
    # Prefer Render/Heroku PORT, then BACKEND_PORT, then default
    port_env = os.environ.get("PORT") or os.environ.get("BACKEND_PORT") or "8000"
    try:
        port = int(port_env)
    except ValueError:
        port = 8000
    run(host, port)

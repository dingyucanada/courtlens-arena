import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timezone


ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
SHA = re.compile(r"^[a-f0-9]{64}$")


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def uid():
    return uuid.uuid4().hex


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def hash_json(value):
    return digest(canonical(value))


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value) is not None


def bounded_text(value, label, maximum=1200, required=False):
    if not isinstance(value, str) or len(value) > maximum or (required and not value.strip()) or any(ord(c) < 32 and c not in "\n\t" for c in value):
        raise BroadcastError("invalid_request", f"{label} 无效或过长。", 400, fields=[{"path": label, "message": "需要符合长度的文本"}])
    return value


class BroadcastError(Exception):
    def __init__(self, code, message, status=400, retryable=False, fields=None, job_id=None):
        super().__init__(message)
        self.code, self.status, self.retryable, self.fields, self.job_id = code, status, retryable, fields or [], job_id

    def body(self):
        return {"code": self.code, "message": str(self), "retryable": self.retryable, "fields": self.fields, "jobId": self.job_id}


def require(condition, code, message, status=400):
    if not condition:
        raise BroadcastError(code, message, status)


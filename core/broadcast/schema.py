"""The published Broadcast contract is the runtime shape validator."""
import json
from functools import lru_cache
from pathlib import Path

from jsonschema import Draft202012Validator

from .common import BroadcastError


CONTRACT = Path(__file__).resolve().parents[2] / "contracts" / "broadcast-v1.json"


@lru_cache(maxsize=1)
def _contract():
    document = json.loads(CONTRACT.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(document)
    return document


@lru_cache(maxsize=32)
def _validator(name):
    document = _contract()
    if name not in document["$defs"]:
        raise ValueError("Unknown Broadcast contract definition: " + name)
    return Draft202012Validator({
        "$schema": document["$schema"],
        "$defs": document["$defs"],
        "$ref": "#/$defs/" + name,
    })


def validate(value, name):
    """Reject malformed external data with a useful JSON path and HTTP 422."""
    errors = sorted(_validator(name).iter_errors(value), key=lambda item: list(map(str, item.absolute_path)))
    if errors:
        error = errors[0]
        path = "/" + "/".join(map(str, error.absolute_path))
        raise BroadcastError("schema_invalid", "Broadcast 合同字段无效。", 422,
                             fields=[{"path": path, "message": error.message[:300]}])
    return value

"""Portable documents: native JSON where available, UTF-8 text BLOB on Firebird."""

import json
from sqlalchemy import JSON, Text
from sqlalchemy.types import TypeDecorator


class JSONDocument(TypeDecorator):
    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        return dialect.type_descriptor(
            Text() if dialect.name.startswith("firebird") else JSON()
        )

    def process_bind_param(self, value, dialect):
        if dialect.name.startswith("firebird") and value is not None:
            return json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
        return value

    def process_result_value(self, value, dialect):
        if dialect.name.startswith("firebird") and value is not None:
            if hasattr(value, "read"):
                value = value.read()
            return json.loads(value)
        return value

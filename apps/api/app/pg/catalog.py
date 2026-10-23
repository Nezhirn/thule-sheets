"""Introspection, paging, editing and ad-hoc queries against user PostgreSQL databases.

Safety rules:
- identifiers are never taken from the request as-is: every schema, table and
  column name is checked against the catalog and quoted;
- values are always bound parameters, sent as text and cast to the column type
  reported by the catalog (`format_type`);
- ad-hoc queries run in a READ ONLY transaction through a prepared statement,
  which rejects multiple statements.
"""

import json
import math
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any, Literal

import asyncpg
from pydantic import BaseModel, Field

SYSTEM_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast")
FilterOp = Literal[
    "eq",
    "neq",
    "lt",
    "lte",
    "gt",
    "gte",
    "contains",
    "not_contains",
    "starts_with",
    "is_null",
    "not_null",
]
COMPARISONS = {"eq": "=", "neq": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
COUNT_TIMEOUT_MS = 3000


class CatalogError(ValueError):
    pass


class EditConflict(Exception):
    pass


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


# ------------------------------------------------------------------ metadata


@dataclass
class Column:
    name: str
    type: str
    base_type: str
    category: str
    not_null: bool
    has_default: bool
    is_identity: bool
    is_generated: bool
    enum_values: list[str] | None
    comment: str | None
    references: dict[str, str] | None = None


@dataclass
class TableInfo:
    schema: str
    name: str
    kind: str
    oid: int
    columns: list[Column]
    primary_key: list[str]
    can_update: bool
    can_insert: bool
    can_delete: bool
    estimated_rows: int
    columns_by_name: dict[str, Column] = field(init=False)

    def __post_init__(self) -> None:
        self.columns_by_name = {c.name: c for c in self.columns}

    @property
    def qualified(self) -> str:
        return f"{quote_ident(self.schema)}.{quote_ident(self.name)}"

    @property
    def editable(self) -> bool:
        return self.kind in ("table", "partitioned") and bool(self.primary_key)

    def column(self, name: str) -> Column:
        try:
            return self.columns_by_name[name]
        except KeyError:
            raise CatalogError(f"Unknown column {name!r}") from None


KIND_NAMES = {
    "r": "table",
    "p": "partitioned",
    "v": "view",
    "m": "materialized_view",
    "f": "foreign",
}


async def list_schemas(conn: asyncpg.Connection) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT nspname FROM pg_namespace
        WHERE nspname <> ALL($1::text[])
          AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
          AND has_schema_privilege(oid, 'USAGE')
        ORDER BY nspname = 'public' DESC, nspname
        """,
        list(SYSTEM_SCHEMAS),
    )
    return [r["nspname"] for r in rows]


async def list_tables(conn: asyncpg.Connection, schema: str) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT c.relname, c.relkind::text AS relkind, GREATEST(c.reltuples, 0)::bigint AS estimate,
               obj_description(c.oid, 'pg_class') AS comment
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND NOT c.relispartition
          AND has_table_privilege(c.oid, 'SELECT')
        ORDER BY c.relname
        """,
        schema,
    )
    return [
        {
            "name": r["relname"],
            "kind": KIND_NAMES[r["relkind"]],
            "estimated_rows": r["estimate"],
            "comment": r["comment"],
        }
        for r in rows
    ]


async def table_info(conn: asyncpg.Connection, schema: str, table: str) -> TableInfo:
    rel = await conn.fetchrow(
        """
        SELECT c.oid, c.relkind::text AS relkind, GREATEST(c.reltuples, 0)::bigint AS estimate,
               has_table_privilege(c.oid, 'UPDATE') AS can_update,
               has_table_privilege(c.oid, 'INSERT') AS can_insert,
               has_table_privilege(c.oid, 'DELETE') AS can_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(c.oid, 'SELECT')
        """,
        schema,
        table,
    )
    if rel is None:
        raise CatalogError(f"Table {schema}.{table} not found")
    cols = await conn.fetch(
        """
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
               t.typname AS base_type, t.typcategory::text AS category,
               a.attnotnull AS not_null, a.atthasdef AS has_default,
               a.attidentity <> '' AS is_identity, a.attgenerated <> '' AS is_generated,
               (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
                  FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_values,
               col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
        """,
        rel["oid"],
    )
    pk = await conn.fetch(
        """
        SELECT a.attname FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1 AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
        """,
        rel["oid"],
    )
    fks = await conn.fetch(
        """
        SELECT a.attname AS column, rn.nspname AS ref_schema, rc.relname AS ref_table,
               ra.attname AS ref_column
        FROM pg_constraint con
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
        WHERE con.conrelid = $1 AND con.contype = 'f' AND array_length(con.conkey, 1) = 1
        """,
        rel["oid"],
    )
    refs = {
        r["column"]: {"schema": r["ref_schema"], "table": r["ref_table"], "column": r["ref_column"]}
        for r in fks
    }
    columns = [
        Column(
            name=c["name"],
            type=c["type"],
            base_type=c["base_type"],
            category=c["category"],
            not_null=c["not_null"],
            has_default=c["has_default"],
            is_identity=c["is_identity"],
            is_generated=c["is_generated"],
            enum_values=c["enum_values"],
            comment=c["comment"],
            references=refs.get(c["name"]),
        )
        for c in cols
    ]
    return TableInfo(
        schema=schema,
        name=table,
        kind=KIND_NAMES[rel["relkind"]],
        oid=rel["oid"],
        columns=columns,
        primary_key=[r["attname"] for r in pk],
        can_update=rel["can_update"],
        can_insert=rel["can_insert"],
        can_delete=rel["can_delete"],
        estimated_rows=rel["estimate"],
    )


# ------------------------------------------------------------------ reading


class FilterIn(BaseModel):
    column: str
    op: FilterOp
    value: str | None = None


class SortIn(BaseModel):
    column: str
    desc: bool = False


class _Params:
    def __init__(self) -> None:
        self.values: list[Any] = []

    def add(self, value: Any) -> str:
        self.values.append(value)
        return f"${len(self.values)}"


def _cast(placeholder: str, column: Column) -> str:
    return f"{placeholder}::text::{column.type}"


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _where(info: TableInfo, filters: list[FilterIn], params: _Params) -> str:
    clauses = []
    for f in filters:
        col = info.column(f.column)
        ident = quote_ident(col.name)
        if f.op == "is_null":
            clauses.append(f"{ident} IS NULL")
        elif f.op == "not_null":
            clauses.append(f"{ident} IS NOT NULL")
        elif f.value is None:
            raise CatalogError(f"Filter {f.op} on {col.name!r} needs a value")
        elif f.op in ("contains", "not_contains"):
            p = params.add(f"%{_escape_like(f.value)}%")
            neg = "NOT " if f.op == "not_contains" else ""
            clauses.append(f"{ident}::text {neg}ILIKE {p}")
        elif f.op == "starts_with":
            p = params.add(f"{_escape_like(f.value)}%")
            clauses.append(f"{ident}::text ILIKE {p}")
        else:
            p = params.add(f.value)
            clauses.append(f"{ident} {COMPARISONS[f.op]} {_cast(p, col)}")
    return f" WHERE {' AND '.join(clauses)}" if clauses else ""


def _select_list(info: TableInfo) -> str:
    return ", ".join(f"{quote_ident(c.name)}::text" for c in info.columns)


async def fetch_rows(
    conn: asyncpg.Connection,
    info: TableInfo,
    *,
    offset: int,
    limit: int,
    filters: list[FilterIn],
    sort: list[SortIn],
) -> dict[str, Any]:
    params = _Params()
    where = _where(info, filters, params)
    order_parts = []
    for s in sort:
        col = info.column(s.column)
        order_parts.append(f"t.{quote_ident(col.name)} {'DESC' if s.desc else 'ASC'} NULLS LAST")
    # A stable order is required for offset paging.
    # The select list casts columns to text under the same names, so ORDER BY must
    # reference the table columns explicitly (t.col) to keep typed ordering.
    order_parts += [
        f"t.{quote_ident(k)}" for k in info.primary_key if k not in {s.column for s in sort}
    ]
    order = f" ORDER BY {', '.join(order_parts)}" if order_parts else ""
    limit_p, offset_p = params.add(limit), params.add(offset)
    sql = (
        f"SELECT {_select_list(info)} FROM {info.qualified} AS t{where}{order}"
        f" LIMIT {limit_p}::int OFFSET {offset_p}::int"
    )
    rows = await conn.fetch(sql, *params.values)
    total, exact = await _count(conn, info, filters)
    return {
        "rows": [list(r.values()) for r in rows],
        "total": total,
        "total_exact": exact,
    }


async def _count(
    conn: asyncpg.Connection, info: TableInfo, filters: list[FilterIn]
) -> tuple[int, bool]:
    params = _Params()
    where = _where(info, filters, params)
    try:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL statement_timeout = {COUNT_TIMEOUT_MS}")
            total = await conn.fetchval(
                f"SELECT count(*) FROM {info.qualified}{where}", *params.values
            )
            return int(total), True
    except asyncpg.QueryCanceledError:
        return info.estimated_rows, False


# ------------------------------------------------------------------ editing


class RowChange(BaseModel):
    pk: dict[str, str | None]
    values: dict[str, str | None] = Field(min_length=1)
    # Values the client saw before editing (text form); used to detect lost updates.
    expected: dict[str, str | None] | None = None


class RowInsert(BaseModel):
    values: dict[str, str | None]


def _require_editable(info: TableInfo, action: Literal["update", "insert", "delete"]) -> None:
    if not info.editable:
        raise CatalogError("Only tables with a primary key can be edited")
    allowed = {"update": info.can_update, "insert": info.can_insert, "delete": info.can_delete}
    if not allowed[action]:
        raise CatalogError(f"The database role has no {action.upper()} privilege on this table")


def _pk_clause(info: TableInfo, pk: dict[str, str | None], params: _Params) -> str:
    if set(pk) != set(info.primary_key):
        raise CatalogError("Row key must contain exactly the primary key columns")
    parts = []
    for name in info.primary_key:
        value = pk[name]
        if value is None:
            raise CatalogError("Primary key values cannot be NULL")
        col = info.column(name)
        parts.append(f"{quote_ident(name)} = {_cast(params.add(value), col)}")
    return " AND ".join(parts)


def _assignable(info: TableInfo, name: str) -> Column:
    col = info.column(name)
    if col.is_generated:
        raise CatalogError(f"Column {name!r} is generated and cannot be written")
    return col


async def update_rows(
    conn: asyncpg.Connection, info: TableInfo, changes: list[RowChange]
) -> list[list[str | None]]:
    _require_editable(info, "update")
    result = []
    async with conn.transaction():
        for change in changes:
            params = _Params()
            sets = []
            for name, value in change.values.items():
                col = _assignable(info, name)
                rhs = "NULL" if value is None else _cast(params.add(value), col)
                sets.append(f"{quote_ident(name)} = {rhs}")
            where = _pk_clause(info, change.pk, params)
            for name, value in (change.expected or {}).items():
                col = info.column(name)
                p = params.add(value)
                where += f" AND {quote_ident(col.name)}::text IS NOT DISTINCT FROM {p}::text"
            row = await conn.fetchrow(
                f"UPDATE {info.qualified} SET {', '.join(sets)} WHERE {where}"
                f" RETURNING {_select_list(info)}",
                *params.values,
            )
            if row is None:
                raise EditConflict("Row was changed or deleted by someone else")
            result.append(list(row.values()))
    return result


async def insert_row(
    conn: asyncpg.Connection, info: TableInfo, data: RowInsert
) -> list[str | None]:
    _require_editable(info, "insert")
    params = _Params()
    names, values = [], []
    for name, value in data.values.items():
        col = _assignable(info, name)
        names.append(quote_ident(col.name))
        values.append("NULL" if value is None else _cast(params.add(value), col))
    if names:
        sql = f"INSERT INTO {info.qualified} ({', '.join(names)}) VALUES ({', '.join(values)})"
    else:
        sql = f"INSERT INTO {info.qualified} DEFAULT VALUES"
    row = await conn.fetchrow(f"{sql} RETURNING {_select_list(info)}", *params.values)
    assert row is not None
    return list(row.values())


async def delete_rows(
    conn: asyncpg.Connection, info: TableInfo, keys: list[dict[str, str | None]]
) -> int:
    _require_editable(info, "delete")
    deleted = 0
    async with conn.transaction():
        for pk in keys:
            params = _Params()
            status = await conn.execute(
                f"DELETE FROM {info.qualified} WHERE {_pk_clause(info, pk, params)}",
                *params.values,
            )
            deleted += int(status.split()[-1])
    return deleted


# ------------------------------------------------------------------ ad-hoc queries


MAX_SAFE_INTEGER = 2**53 - 1


def to_json_value(value: Any) -> Any:
    """Convert database values to JSON values that keep numbers numeric where safe."""
    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, int):
        return value if abs(value) <= MAX_SAFE_INTEGER else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Decimal):
        if value.is_finite() and len(value.as_tuple().digits) <= 15:
            return float(value)
        return str(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    if isinstance(value, timedelta | uuid.UUID):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        return "\\x" + bytes(value).hex()
    if isinstance(value, list | tuple | dict):
        return json.dumps(value, default=str, ensure_ascii=False)
    return str(value)


async def run_query(conn: asyncpg.Connection, sql: str, row_limit: int) -> dict[str, Any]:
    async with conn.transaction(readonly=True):
        stmt = await conn.prepare(sql)
        columns = [{"name": a.name, "type": a.type.name} for a in stmt.get_attributes()]
        if not columns:
            raise CatalogError("The statement returns no rows; only queries are allowed here")
        cursor = await stmt.cursor()
        records = await cursor.fetch(row_limit + 1)
    truncated = len(records) > row_limit
    rows = [[to_json_value(v) for v in r.values()] for r in records[:row_limit]]
    return {"columns": columns, "rows": rows, "truncated": truncated}

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from datetime import datetime
from typing import Any, Literal

import asyncpg
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.config import get_settings
from app.deps import CurrentUser, SessionDep, require_workspace_role
from app.models import AuditLog, DbConnection, Role, User, WorkspaceMember
from app.pg import catalog
from app.pg.pools import (
    SSL_MODES,
    ConnectionConfigError,
    ConnParams,
    open_connection,
    params_from_model,
    pools,
)
from app.security import encrypt_secret

router = APIRouter(prefix="/connections", tags=["connections"])

SslMode = Literal["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]
assert set(SslMode.__args__) == set(SSL_MODES)  # type: ignore[attr-defined]


class ConnectionIn(BaseModel):
    workspace_id: uuid.UUID
    name: str = Field(min_length=1, max_length=120)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(default="", max_length=500)
    sslmode: SslMode = "prefer"
    read_only: bool = True


class ConnectionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    host: str | None = Field(default=None, min_length=1, max_length=255)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str | None = Field(default=None, min_length=1, max_length=120)
    username: str | None = Field(default=None, min_length=1, max_length=120)
    # None keeps the stored password.
    password: str | None = Field(default=None, max_length=500)
    sslmode: SslMode | None = None
    read_only: bool | None = None


class ConnectionOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    host: str
    port: int
    database: str
    username: str
    sslmode: str
    read_only: bool
    created_at: datetime


class TestResult(BaseModel):
    ok: bool
    server_version: str | None = None
    error: str | None = None


class RowsQuery(BaseModel):
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=200, ge=1)
    filters: list[catalog.FilterIn] = Field(default_factory=list, max_length=20)
    sort: list[catalog.SortIn] = Field(default_factory=list, max_length=5)


class UpdateRowsIn(BaseModel):
    changes: list[catalog.RowChange] = Field(min_length=1, max_length=500)


class DeleteRowsIn(BaseModel):
    keys: list[dict[str, str | None]] = Field(min_length=1, max_length=500)


class ApplyChangesIn(BaseModel):
    updates: list[catalog.RowChange] = Field(default_factory=list, max_length=5000)
    inserts: list[catalog.RowInsert] = Field(default_factory=list, max_length=5000)
    deletes: list[catalog.RowDelete] = Field(default_factory=list, max_length=5000)


class QueryIn(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    limit: int | None = Field(default=None, ge=1)


def _out(conn: DbConnection) -> ConnectionOut:
    return ConnectionOut(
        id=conn.id,
        workspace_id=conn.workspace_id,
        name=conn.name,
        host=conn.host,
        port=conn.port,
        database=conn.database,
        username=conn.username,
        sslmode=conn.sslmode,
        read_only=conn.read_only,
        created_at=conn.created_at,
    )


def _db_error(exc: Exception) -> HTTPException:
    if isinstance(exc, catalog.ChangeFailed):
        inner = _db_error(exc.cause)
        detail = inner.detail if isinstance(inner.detail, dict) else {"message": inner.detail}
        return HTTPException(inner.status_code, {**detail, "op": exc.op, "index": exc.index})
    if isinstance(exc, catalog.EditConflict):
        return HTTPException(status.HTTP_409_CONFLICT, {"message": str(exc), "pk": exc.pk})
    if isinstance(exc, catalog.CatalogError | ConnectionConfigError):
        return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if isinstance(exc, asyncpg.QueryCanceledError):
        return HTTPException(status.HTTP_408_REQUEST_TIMEOUT, "Query timed out")
    if isinstance(exc, asyncpg.InsufficientPrivilegeError | asyncpg.ReadOnlySQLTransactionError):
        return HTTPException(status.HTTP_403_FORBIDDEN, str(exc))
    if isinstance(exc, asyncpg.PostgresError):
        detail = {"message": str(exc), "sqlstate": exc.sqlstate}
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)
    if isinstance(exc, OSError | asyncpg.InterfaceError | TimeoutError):
        return HTTPException(status.HTTP_502_BAD_GATEWAY, f"Cannot connect: {exc}")
    raise exc


async def _get_connection(
    session: SessionDep, connection_id: uuid.UUID, user: User, minimum: Role
) -> DbConnection:
    conn = await session.get(DbConnection, connection_id)
    if conn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
    try:
        await require_workspace_role(session, conn.workspace_id, user, minimum)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found") from exc
        raise
    return conn


@asynccontextmanager
async def _acquire(conn: DbConnection) -> AsyncIterator[asyncpg.Connection]:
    try:
        pool = await pools.get(conn.id, params_from_model(conn))
        async with pool.acquire() as connection:
            yield connection
    except HTTPException:
        raise
    except Exception as exc:
        raise _db_error(exc) from exc


async def _audit(
    session: SessionDep, user: User, action: str, conn: DbConnection, details: dict[str, Any]
) -> None:
    session.add(
        AuditLog(
            user_id=user.id,
            action=action,
            target_type="db_connection",
            target_id=str(conn.id),
            details=details,
        )
    )
    await session.commit()


# ------------------------------------------------------------------ CRUD


@router.get("")
async def list_connections(
    user: CurrentUser, session: SessionDep, workspace_id: uuid.UUID | None = None
) -> list[ConnectionOut]:
    stmt = (
        select(DbConnection)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == DbConnection.workspace_id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(DbConnection.name)
    )
    if workspace_id:
        stmt = stmt.where(DbConnection.workspace_id == workspace_id)
    return [_out(c) for c in await session.scalars(stmt)]


@router.post("/test")
async def test_connection(data: ConnectionIn, user: CurrentUser, session: SessionDep) -> TestResult:
    await require_workspace_role(session, data.workspace_id, user, Role.editor)
    params = ConnParams(
        host=data.host,
        port=data.port,
        database=data.database,
        username=data.username,
        password=data.password,
        sslmode=data.sslmode,
        read_only=data.read_only,
    )
    return await _test(params)


async def _test(params: ConnParams) -> TestResult:
    try:
        connection = await open_connection(params)
    except ConnectionConfigError as exc:
        return TestResult(ok=False, error=str(exc))
    except (OSError, TimeoutError, asyncpg.PostgresError, asyncpg.InterfaceError) as exc:
        return TestResult(ok=False, error=str(exc) or exc.__class__.__name__)
    try:
        version = await connection.fetchval("SHOW server_version")
    finally:
        await connection.close()
    return TestResult(ok=True, server_version=version)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_connection(
    data: ConnectionIn, user: CurrentUser, session: SessionDep
) -> ConnectionOut:
    await require_workspace_role(session, data.workspace_id, user, Role.owner)
    conn = DbConnection(
        workspace_id=data.workspace_id,
        name=data.name.strip(),
        host=data.host.strip(),
        port=data.port,
        database=data.database,
        username=data.username,
        password_enc=encrypt_secret(data.password),
        sslmode=data.sslmode,
        read_only=data.read_only,
        created_by=user.id,
    )
    session.add(conn)
    await session.commit()
    return _out(conn)


@router.patch("/{connection_id}")
async def update_connection(
    connection_id: uuid.UUID, data: ConnectionPatch, user: CurrentUser, session: SessionDep
) -> ConnectionOut:
    conn = await _get_connection(session, connection_id, user, Role.owner)
    for field in ("name", "host", "port", "database", "username", "sslmode", "read_only"):
        value = getattr(data, field)
        if value is not None:
            setattr(conn, field, value.strip() if isinstance(value, str) else value)
    if data.password is not None:
        conn.password_enc = encrypt_secret(data.password)
    await session.commit()
    await pools.drop(conn.id)
    return _out(conn)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> None:
    conn = await _get_connection(session, connection_id, user, Role.owner)
    await session.delete(conn)
    await session.commit()
    await pools.drop(connection_id)


@router.post("/{connection_id}/test")
async def test_saved_connection(
    connection_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> TestResult:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    return await _test(params_from_model(conn))


# ------------------------------------------------------------------ browsing


@router.get("/{connection_id}/schemas")
async def get_schemas(
    connection_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> list[str]:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    async with _acquire(conn) as db:
        return await catalog.list_schemas(db)


@router.get("/{connection_id}/schemas/{schema}/tables")
async def get_tables(
    connection_id: uuid.UUID, schema: str, user: CurrentUser, session: SessionDep
) -> list[dict[str, Any]]:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    async with _acquire(conn) as db:
        return await catalog.list_tables(db, schema)


@router.get("/{connection_id}/schemas/{schema}/tables/{table}")
async def get_table(
    connection_id: uuid.UUID, schema: str, table: str, user: CurrentUser, session: SessionDep
) -> dict[str, Any]:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
        except Exception as exc:
            raise _db_error(exc) from exc
    editable = info.editable and not conn.read_only
    return {
        "schema": info.schema,
        "name": info.name,
        "kind": info.kind,
        "columns": [asdict(c) for c in info.columns],
        "primary_key": info.primary_key,
        "estimated_rows": info.estimated_rows,
        "editable": editable,
        "can_update": editable and info.can_update,
        "can_insert": editable and info.can_insert,
        "can_delete": editable and info.can_delete,
        "read_only_reason": _read_only_reason(conn, info),
    }


def _read_only_reason(conn: DbConnection, info: catalog.TableInfo) -> str | None:
    if conn.read_only:
        return "connection"
    if info.kind not in ("table", "partitioned"):
        return "not_a_table"
    if not info.primary_key:
        return "no_primary_key"
    return None


@router.post("/{connection_id}/schemas/{schema}/tables/{table}/rows")
async def get_rows(
    connection_id: uuid.UUID,
    schema: str,
    table: str,
    query: RowsQuery,
    user: CurrentUser,
    session: SessionDep,
) -> dict[str, Any]:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    limit = min(query.limit, get_settings().db_page_size_max)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
            return await catalog.fetch_rows(
                db, info, offset=query.offset, limit=limit, filters=query.filters, sort=query.sort
            )
        except Exception as exc:
            raise _db_error(exc) from exc


# ------------------------------------------------------------------ editing


async def _writable(session: SessionDep, connection_id: uuid.UUID, user: User) -> DbConnection:
    conn = await _get_connection(session, connection_id, user, Role.editor)
    if conn.read_only:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Connection is read-only")
    return conn


@router.patch("/{connection_id}/schemas/{schema}/tables/{table}/rows")
async def update_rows(
    connection_id: uuid.UUID,
    schema: str,
    table: str,
    data: UpdateRowsIn,
    user: CurrentUser,
    session: SessionDep,
) -> dict[str, Any]:
    conn = await _writable(session, connection_id, user)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
            rows = await catalog.update_rows(db, info, data.changes)
        except Exception as exc:
            raise _db_error(exc) from exc
    await _audit(
        session,
        user,
        "db.update",
        conn,
        {
            "schema": schema,
            "table": table,
            "count": len(data.changes),
            "keys": [c.pk for c in data.changes][:50],
            "columns": sorted({k for c in data.changes for k in c.values}),
        },
    )
    return {"rows": rows}


@router.post("/{connection_id}/schemas/{schema}/tables/{table}/rows/insert")
async def insert_row(
    connection_id: uuid.UUID,
    schema: str,
    table: str,
    data: catalog.RowInsert,
    user: CurrentUser,
    session: SessionDep,
) -> dict[str, Any]:
    conn = await _writable(session, connection_id, user)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
            row = await catalog.insert_row(db, info, data)
        except Exception as exc:
            raise _db_error(exc) from exc
    await _audit(
        session,
        user,
        "db.insert",
        conn,
        {"schema": schema, "table": table, "columns": sorted(data.values)},
    )
    return {"row": row}


@router.post("/{connection_id}/schemas/{schema}/tables/{table}/rows/apply")
async def apply_changes(
    connection_id: uuid.UUID,
    schema: str,
    table: str,
    data: ApplyChangesIn,
    user: CurrentUser,
    session: SessionDep,
) -> dict[str, Any]:
    """Save edits made in the table editor: updates, deletes and inserts in one transaction."""
    if not (data.updates or data.inserts or data.deletes):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "No changes")
    conn = await _writable(session, connection_id, user)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
            result = await catalog.apply_changes(db, info, data.updates, data.inserts, data.deletes)
        except Exception as exc:
            raise _db_error(exc) from exc
    await _audit(
        session,
        user,
        "db.apply",
        conn,
        {
            "schema": schema,
            "table": table,
            "updated": len(data.updates),
            "inserted": len(data.inserts),
            "deleted": result["deleted"],
            "update_keys": [c.pk for c in data.updates][:50],
            "delete_keys": [d.pk for d in data.deletes[:50]],
            "columns": sorted({k for c in data.updates for k in c.values}),
        },
    )
    return result


@router.post("/{connection_id}/schemas/{schema}/tables/{table}/rows/delete")
async def delete_rows(
    connection_id: uuid.UUID,
    schema: str,
    table: str,
    data: DeleteRowsIn,
    user: CurrentUser,
    session: SessionDep,
) -> dict[str, Any]:
    conn = await _writable(session, connection_id, user)
    async with _acquire(conn) as db:
        try:
            info = await catalog.table_info(db, schema, table)
            deleted = await catalog.delete_rows(db, info, data.keys)
        except Exception as exc:
            raise _db_error(exc) from exc
    await _audit(
        session,
        user,
        "db.delete",
        conn,
        {"schema": schema, "table": table, "count": deleted, "keys": data.keys[:50]},
    )
    return {"deleted": deleted}


# ------------------------------------------------------------------ queries


@router.post("/{connection_id}/query")
async def run_query(
    connection_id: uuid.UUID,
    data: QueryIn,
    user: CurrentUser,
    session: SessionDep,
    limit: int | None = Query(default=None, ge=1),
) -> dict[str, Any]:
    conn = await _get_connection(session, connection_id, user, Role.viewer)
    max_rows = get_settings().db_query_row_limit
    row_limit = min(data.limit or limit or max_rows, max_rows)
    async with _acquire(conn) as db:
        try:
            result = await catalog.run_query(db, data.sql, row_limit)
        except Exception as exc:
            raise _db_error(exc) from exc
    await _audit(
        session,
        user,
        "db.query",
        conn,
        {"sql": data.sql[:2000], "rows": len(result["rows"]), "truncated": result["truncated"]},
    )
    return result

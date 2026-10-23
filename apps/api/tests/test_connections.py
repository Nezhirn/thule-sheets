import asyncpg
import httpx
import pytest

from app.config import get_settings
from tests.conftest import RAW_DSN, personal_workspace, register

DEMO_SQL = """
DROP SCHEMA IF EXISTS demo CASCADE;
CREATE SCHEMA demo;
CREATE TYPE demo.status AS ENUM ('new', 'paid', 'void');
CREATE TABLE demo.customers (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE demo.orders (
    id serial PRIMARY KEY,
    customer_id int REFERENCES demo.customers(id),
    amount numeric(12, 2) NOT NULL,
    status demo.status NOT NULL DEFAULT 'new',
    created_at timestamptz NOT NULL DEFAULT '2026-10-01 10:00:00+03',
    note text
);
CREATE TABLE demo.log (message text);
CREATE VIEW demo.paid AS SELECT * FROM demo.orders WHERE status = 'paid';
INSERT INTO demo.customers (name) VALUES ('Анна'), ('Борис');
INSERT INTO demo.orders (customer_id, amount, status, note)
SELECT 1 + (g % 2), g * 10.5, (ARRAY['new', 'paid', 'void'])[1 + g % 3]::demo.status,
       CASE WHEN g % 5 = 0 THEN NULL ELSE 'заказ ' || g END
FROM generate_series(1, 25) g;
"""


@pytest.fixture
async def demo_db() -> None:
    conn = await asyncpg.connect(RAW_DSN)
    await conn.execute(DEMO_SQL)
    await conn.close()


async def _connection(client: httpx.AsyncClient, read_only: bool = False) -> str:
    await register(client, "db@example.com")
    ws = await personal_workspace(client)
    body = {
        "workspace_id": ws,
        "name": "Тестовая",
        "host": "127.0.0.1",
        "port": 55432,
        "database": "thule_sheets_test",
        "username": "thule",
        "password": "thule",
        "sslmode": "disable",
        "read_only": read_only,
    }
    test = await client.post("/api/connections/test", json=body)
    assert test.json()["ok"] is True, test.text
    r = await client.post("/api/connections", json=body)
    assert r.status_code == 201, r.text
    assert "password" not in r.json()
    return r.json()["id"]


async def test_browse_and_page(client: httpx.AsyncClient, demo_db: None) -> None:
    cid = await _connection(client)
    schemas = (await client.get(f"/api/connections/{cid}/schemas")).json()
    assert "demo" in schemas and "pg_catalog" not in schemas

    tables = (await client.get(f"/api/connections/{cid}/schemas/demo/tables")).json()
    assert {t["name"]: t["kind"] for t in tables} == {
        "customers": "table",
        "log": "table",
        "orders": "table",
        "paid": "view",
    }

    info = (await client.get(f"/api/connections/{cid}/schemas/demo/tables/orders")).json()
    assert info["primary_key"] == ["id"] and info["editable"] is True
    status_col = next(c for c in info["columns"] if c["name"] == "status")
    assert status_col["enum_values"] == ["new", "paid", "void"]
    fk = next(c for c in info["columns"] if c["name"] == "customer_id")
    assert fk["references"] == {"schema": "demo", "table": "customers", "column": "id"}

    no_pk = (await client.get(f"/api/connections/{cid}/schemas/demo/tables/log")).json()
    assert no_pk["editable"] is False and no_pk["read_only_reason"] == "no_primary_key"

    url = f"/api/connections/{cid}/schemas/demo/tables/orders/rows"
    page = (await client.post(url, json={"offset": 0, "limit": 12})).json()
    # Values are returned as text, but ordering must use the column type (1, 2, …, 10).
    assert [row[0] for row in page["rows"]] == [str(i) for i in range(1, 13)]
    assert page["total"] == 25 and page["total_exact"] is True
    assert page["rows"][0][:3] == ["1", "2", "10.50"]

    r = await client.post(
        url,
        json={
            "filters": [
                {"column": "status", "op": "eq", "value": "paid"},
                {"column": "amount", "op": "gt", "value": "100"},
            ],
            "sort": [{"column": "amount", "desc": True}],
        },
    )
    rows = r.json()["rows"]
    assert all(row[3] == "paid" for row in rows)
    assert [float(row[2]) for row in rows] == sorted((float(row[2]) for row in rows), reverse=True)

    r = await client.post(url, json={"filters": [{"column": "note", "op": "is_null"}]})
    assert r.json()["total"] == 5
    r = await client.post(
        url, json={"filters": [{"column": "note", "op": "contains", "value": "%"}]}
    )
    assert r.json()["total"] == 0  # LIKE wildcards are escaped

    r = await client.post(url, json={"sort": [{"column": "id; DROP TABLE demo.orders"}]})
    assert r.status_code == 400
    r = await client.get(f"/api/connections/{cid}/schemas/demo/tables/orders%22%3B")
    assert r.status_code == 400


async def test_edit_rows(client: httpx.AsyncClient, demo_db: None) -> None:
    cid = await _connection(client)
    url = f"/api/connections/{cid}/schemas/demo/tables/orders/rows"

    r = await client.patch(
        url,
        json={
            "changes": [
                {
                    "pk": {"id": "1"},
                    "values": {"amount": "99.90", "note": None},
                    "expected": {"amount": "10.50"},
                }
            ]
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["rows"][0][2] == "99.90" and r.json()["rows"][0][5] is None

    # The row changed since the client loaded it: the update is rejected.
    r = await client.patch(
        url,
        json={
            "changes": [
                {"pk": {"id": "1"}, "values": {"amount": "1"}, "expected": {"amount": "10.50"}}
            ]
        },
    )
    assert r.status_code == 409

    r = await client.patch(
        url, json={"changes": [{"pk": {"id": "2"}, "values": {"status": "bad"}}]}
    )
    assert r.status_code == 422 and r.json()["detail"]["sqlstate"] == "22P02"

    r = await client.post(f"{url}/insert", json={"values": {"customer_id": "1", "amount": "5"}})
    assert r.status_code == 200, r.text
    new_id = r.json()["row"][0]
    assert r.json()["row"][3] == "new"

    r = await client.post(f"{url}/delete", json={"keys": [{"id": new_id}]})
    assert r.json() == {"deleted": 1}

    r = await client.post(
        f"/api/connections/{cid}/schemas/demo/tables/log/rows/insert",
        json={"values": {"message": "x"}},
    )
    assert r.status_code == 400


async def test_read_only_connection_and_queries(client: httpx.AsyncClient, demo_db: None) -> None:
    cid = await _connection(client, read_only=True)
    url = f"/api/connections/{cid}/schemas/demo/tables/orders/rows"
    r = await client.patch(url, json={"changes": [{"pk": {"id": "1"}, "values": {"note": "x"}}]})
    assert r.status_code == 403

    q = f"/api/connections/{cid}/query"
    r = await client.post(
        q, json={"sql": "SELECT id, amount, created_at FROM demo.orders ORDER BY id"}
    )
    body = r.json()
    assert body["columns"][1] == {"name": "amount", "type": "numeric"}
    assert body["rows"][0][1] == 10.5 and body["rows"][0][2].startswith("2026-10-01")

    r = await client.post(q, json={"sql": "SELECT g FROM generate_series(1, 50) g", "limit": 10})
    assert len(r.json()["rows"]) == 10 and r.json()["truncated"] is True

    r = await client.post(q, json={"sql": "DELETE FROM demo.orders RETURNING id"})
    assert r.status_code == 403
    r = await client.post(q, json={"sql": "SELECT 1; DROP TABLE demo.orders"})
    assert r.status_code == 422
    r = await client.post(q, json={"sql": "SELECT * FROM missing_table"})
    assert r.status_code == 422 and r.json()["detail"]["sqlstate"] == "42P01"

    conn = await asyncpg.connect(RAW_DSN)
    assert await conn.fetchval("SELECT count(*) FROM demo.orders") == 25
    await conn.close()


async def test_private_hosts_blocked_when_disabled(client: httpx.AsyncClient) -> None:
    settings = get_settings()
    settings.allow_private_db_hosts = False
    try:
        await register(client, "ssrf@example.com")
        ws = await personal_workspace(client)
        r = await client.post(
            "/api/connections/test",
            json={
                "workspace_id": ws,
                "name": "x",
                "host": "169.254.169.254",
                "port": 5432,
                "database": "x",
                "username": "x",
                "password": "x",
            },
        )
        assert r.json()["ok"] is False and "private" in r.json()["error"]
    finally:
        settings.allow_private_db_hosts = True

import asyncio
import json

import asyncpg
import httpx

from tests.conftest import RAW_DSN, personal_workspace, register


async def test_register_login_me_logout(client: httpx.AsyncClient) -> None:
    await register(client, "Anna@Example.com", "Анна")
    me = (await client.get("/api/auth/me")).json()
    assert me["email"] == "anna@example.com"

    dup = await client.post(
        "/api/auth/register",
        json={"email": "anna@example.com", "name": "x", "password": "password123"},
    )
    assert dup.status_code == 409

    await client.post("/api/auth/logout")
    client.cookies.clear()
    assert (await client.get("/api/auth/me")).status_code == 401

    bad = await client.post(
        "/api/auth/login", json={"email": "anna@example.com", "password": "wrong-password"}
    )
    assert bad.status_code == 401
    ok = await client.post(
        "/api/auth/login", json={"email": "anna@example.com", "password": "password123"}
    )
    assert ok.status_code == 200
    workspaces = (await client.get("/api/workspaces")).json()
    assert [w["name"] for w in workspaces] == ["Личные", "Работа"]


async def test_workbook_lifecycle(client: httpx.AsyncClient) -> None:
    await register(client, "owner@example.com")
    ws = await personal_workspace(client)
    r = await client.post(
        "/api/workbooks", json={"workspace_id": ws, "title": "Финансы 2026", "template": "finance"}
    )
    assert r.status_code == 201, r.text
    wb = r.json()
    sheets = wb["snapshot"]["sheets"]
    assert [sheets[s]["name"] for s in wb["snapshot"]["sheetOrder"]] == [
        "Обзор",
        "Октябрь",
        "Категории",
    ]

    assert (await client.get(f"/api/workbooks/{wb['id']}")).status_code == 200
    recent = (await client.get("/api/workbooks", params={"view": "recent"})).json()
    assert [i["id"] for i in recent] == [wb["id"]]

    assert (await client.put(f"/api/workbooks/{wb['id']}/favorite")).status_code == 204
    favs = (await client.get("/api/workbooks", params={"view": "favorites"})).json()
    assert favs[0]["favorite"] is True

    found = (await client.get("/api/workbooks", params={"q": "финансы"})).json()
    assert len(found) == 1
    none = (await client.get("/api/workbooks", params={"q": "100%"})).json()
    assert none == []

    r = await client.patch(f"/api/workbooks/{wb['id']}", json={"title": "Бюджет"})
    assert r.json()["title"] == "Бюджет"

    r = await client.put(
        f"/api/workbooks/{wb['id']}/snapshot", json={"base_rev": 0, "snapshot": wb["snapshot"]}
    )
    assert r.status_code == 200 and r.json()["rev"] == 1
    versions = (await client.get(f"/api/workbooks/{wb['id']}/versions")).json()
    assert len(versions) == 1

    assert (await client.delete(f"/api/workbooks/{wb['id']}")).status_code == 204
    assert (await client.get(f"/api/workbooks/{wb['id']}")).status_code == 404


async def test_sharing_and_permissions(client: httpx.AsyncClient) -> None:
    await register(client, "viewer@example.com", "Viewer")
    client.cookies.clear()
    await register(client, "owner@example.com", "Owner")
    ws = await personal_workspace(client)
    wb = (await client.post("/api/workbooks", json={"workspace_id": ws})).json()

    r = await client.put(
        f"/api/workbooks/{wb['id']}/shares", json={"email": "viewer@example.com", "role": "viewer"}
    )
    assert r.status_code == 200
    owner_cookies = dict(client.cookies)

    client.cookies.clear()
    await client.post(
        "/api/auth/login", json={"email": "viewer@example.com", "password": "password123"}
    )
    shared = (await client.get("/api/workbooks", params={"view": "shared"})).json()
    assert [i["id"] for i in shared] == [wb["id"]]
    assert shared[0]["role"] == "viewer"
    r = await client.patch(f"/api/workbooks/{wb['id']}", json={"title": "hack"})
    assert r.status_code == 403
    r = await client.put(
        f"/api/workbooks/{wb['id']}/snapshot", json={"base_rev": 0, "snapshot": wb["snapshot"]}
    )
    assert r.status_code == 403

    client.cookies.clear()
    client.cookies.update(owner_cookies)
    other_ws = (await client.post("/api/workspaces", json={"name": "Проекты"})).json()
    assert other_ws["role"] == "owner"


def _snapshot(value: str) -> dict:
    return {"id": "u", "sheets": {"s": {"id": "s", "cellData": {"0": {"0": {"v": value}}}}}}


async def test_save_conflict_and_force(client: httpx.AsyncClient) -> None:
    await register(client, "a@example.com", "Alice")
    ws = await personal_workspace(client)
    wb = (await client.post("/api/workbooks", json={"workspace_id": ws})).json()
    url = f"/api/workbooks/{wb['id']}/snapshot"
    assert wb["rev"] == 0 and wb["saved_by"] == "Alice" and wb["saved_by_id"]

    # Two copies loaded at revision 0: the first save wins, the second gets a conflict.
    first = await client.put(url, json={"base_rev": 0, "snapshot": _snapshot("first")})
    assert first.json()["rev"] == 1
    stale = await client.put(url, json={"base_rev": 0, "snapshot": _snapshot("second")})
    assert stale.status_code == 409
    detail = stale.json()["detail"]
    assert detail["rev"] == 1 and detail["saved_by"] == "Alice"
    assert detail["saved_by_id"] == wb["saved_by_id"]
    meta = (await client.get(f"/api/workbooks/{wb['id']}")).json()
    assert meta["snapshot"] == _snapshot("first")

    forced = await client.put(
        url, json={"base_rev": 0, "snapshot": _snapshot("second"), "force": True}
    )
    assert forced.json()["rev"] == 2
    meta = (await client.get(f"/api/workbooks/{wb['id']}")).json()
    assert meta["rev"] == 2 and meta["snapshot"] == _snapshot("second")


async def test_save_waiting_for_lock_sees_concurrent_save(client: httpx.AsyncClient) -> None:
    """A save blocked on the row lock must compare base_rev with the committed revision."""
    await register(client, "a@example.com", "Alice")
    ws = await personal_workspace(client)
    wb = (await client.post("/api/workbooks", json={"workspace_id": ws})).json()
    url = f"/api/workbooks/{wb['id']}/snapshot"

    other = await asyncpg.connect(RAW_DSN)
    # pg_stat_activity is snapshotted per transaction, so poll from a separate connection.
    watcher = await asyncpg.connect(RAW_DSN)
    try:
        lock = other.transaction()
        await lock.start()
        await other.execute("SELECT 1 FROM workbooks WHERE id = $1 FOR UPDATE", wb["id"])
        request = asyncio.create_task(
            client.put(url, json={"base_rev": 0, "snapshot": _snapshot("late")})
        )
        # Wait until the request is blocked on the row lock.
        waiting = 0
        for _ in range(100):
            waiting = await watcher.fetchval(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'"
            )
            if waiting:
                break
            await asyncio.sleep(0.05)
        assert waiting, "the save request never waited for the row lock"
        # Meanwhile another editor's save commits revision 1.
        await other.execute(
            "UPDATE workbooks SET rev = 1, snapshot = $2::jsonb WHERE id = $1",
            wb["id"],
            json.dumps(_snapshot("concurrent")),
        )
        await lock.commit()
        response = await asyncio.wait_for(request, timeout=10)
    finally:
        await other.close()
        await watcher.close()

    assert response.status_code == 409, response.text
    meta = (await client.get(f"/api/workbooks/{wb['id']}")).json()
    assert meta["rev"] == 1 and meta["snapshot"] == _snapshot("concurrent")


async def test_restore_version_bumps_revision(client: httpx.AsyncClient) -> None:
    await register(client, "a@example.com", "Alice")
    ws = await personal_workspace(client)
    wb = (await client.post("/api/workbooks", json={"workspace_id": ws})).json()
    url = f"/api/workbooks/{wb['id']}/snapshot"
    await client.put(url, json={"base_rev": 0, "snapshot": _snapshot("v1")})
    version = (
        await client.post(f"/api/workbooks/{wb['id']}/versions", json={"label": "v1"})
    ).json()
    await client.put(url, json={"base_rev": 1, "snapshot": _snapshot("v2")})

    r = await client.post(f"/api/workbooks/{wb['id']}/versions/{version['id']}/restore")
    assert r.status_code == 200 and r.json()["rev"] == 3
    meta = (await client.get(f"/api/workbooks/{wb['id']}")).json()
    assert meta["snapshot"] == _snapshot("v1")
    labels = [v["label"] for v in (await client.get(f"/api/workbooks/{wb['id']}/versions")).json()]
    assert "Перед восстановлением" in labels

    # A copy opened before the restore can no longer overwrite it silently.
    stale = await client.put(url, json={"base_rev": 2, "snapshot": _snapshot("old")})
    assert stale.status_code == 409

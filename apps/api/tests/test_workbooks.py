import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.conftest import personal_workspace, register


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

    # Snapshot revision must not be ahead of the operation log.
    r = await client.put(
        f"/api/workbooks/{wb['id']}/snapshot", json={"rev": 5, "snapshot": wb["snapshot"]}
    )
    assert r.status_code == 409
    r = await client.put(
        f"/api/workbooks/{wb['id']}/snapshot", json={"rev": 0, "snapshot": wb["snapshot"]}
    )
    assert r.status_code == 200
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
        f"/api/workbooks/{wb['id']}/snapshot", json={"rev": 0, "snapshot": wb["snapshot"]}
    )
    assert r.status_code == 403

    client.cookies.clear()
    client.cookies.update(owner_cookies)
    other_ws = (await client.post("/api/workspaces", json={"name": "Проекты"})).json()
    assert other_ws["role"] == "owner"


def _login(client: TestClient, email: str, name: str) -> None:
    r = client.post(
        "/api/auth/register", json={"email": email, "name": name, "password": "password123"}
    )
    assert r.status_code == 201, r.text


def test_realtime_ops_and_presence(sync_client: TestClient) -> None:
    _login(sync_client, "a@example.com", "Alice")
    ws_id = next(w["id"] for w in sync_client.get("/api/workspaces").json() if w["is_personal"])
    wb = sync_client.post("/api/workbooks", json={"workspace_id": ws_id}).json()
    url = f"/api/workbooks/{wb['id']}/ws"
    op = {
        "id": "sheet.mutation.set-range-values",
        "params": {"unitId": "u", "subUnitId": "s", "cellValue": {"0": {"0": {"v": 1}}}},
    }

    with sync_client.websocket_connect(url) as a, sync_client.websocket_connect(url) as b:
        hello_a = a.receive_json()
        assert hello_a["type"] == "hello" and hello_a["rev"] == 0
        assert b.receive_json()["type"] == "hello"
        joined = a.receive_json()
        assert joined["type"] == "presence" and joined["name"] == "Alice"

        a.send_json({"type": "ops", "opId": "op-1", "baseRev": 0, "ops": [op]})
        assert a.receive_json() == {"type": "ack", "opId": "op-1", "rev": 1}
        relayed = b.receive_json()
        assert relayed["type"] == "ops" and relayed["rev"] == 1 and relayed["ops"] == [op]

        # A batch resent after a reconnect is acknowledged but not stored or relayed twice.
        a.send_json({"type": "ops", "opId": "op-1", "baseRev": 0, "ops": [op]})
        assert a.receive_json() == {"type": "ack", "opId": "op-1", "rev": 1}

        a.send_json({"type": "ops", "opId": "op-2", "ops": [{"id": "sheet.command.x"}]})
        assert a.receive_json()["type"] == "error"

        b.send_json({"type": "presence", "selection": {"range": "A1"}})
        moved = a.receive_json()
        assert moved["type"] == "presence" and moved["selection"] == {"range": "A1"}

    ops = sync_client.get(f"/api/workbooks/{wb['id']}/ops", params={"since": 0}).json()
    assert [o["rev"] for o in ops] == [1]
    meta = sync_client.get(f"/api/workbooks/{wb['id']}").json()
    assert meta["head_rev"] == 1

    # Restoring a version resets every client to a new revision.
    sync_client.put(
        f"/api/workbooks/{wb['id']}/snapshot", json={"rev": 1, "snapshot": meta["snapshot"]}
    )
    version = sync_client.post(f"/api/workbooks/{wb['id']}/versions", json={"label": "v1"}).json()
    with sync_client.websocket_connect(url) as a:
        a.receive_json()
        r = sync_client.post(f"/api/workbooks/{wb['id']}/versions/{version['id']}/restore")
        assert r.status_code == 200
        assert a.receive_json() == {"type": "reset", "rev": 2}


def test_realtime_rejects_viewers_and_strangers(sync_client: TestClient) -> None:
    _login(sync_client, "owner@example.com", "Owner")
    ws_id = next(w["id"] for w in sync_client.get("/api/workspaces").json() if w["is_personal"])
    wb = sync_client.post("/api/workbooks", json={"workspace_id": ws_id}).json()
    url = f"/api/workbooks/{wb['id']}/ws"

    evil = {"origin": "https://evil.example"}
    with pytest.raises(WebSocketDisconnect), sync_client.websocket_connect(url, headers=evil) as s:
        s.receive_json()

    sync_client.cookies.clear()
    _login(sync_client, "stranger@example.com", "Stranger")
    with pytest.raises(WebSocketDisconnect), sync_client.websocket_connect(url) as s:
        s.receive_json()

    sync_client.cookies.clear()
    sync_client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "password123"}
    )
    sync_client.put(
        f"/api/workbooks/{wb['id']}/shares",
        json={"email": "stranger@example.com", "role": "viewer"},
    )
    sync_client.cookies.clear()
    sync_client.post(
        "/api/auth/login", json={"email": "stranger@example.com", "password": "password123"}
    )
    with sync_client.websocket_connect(url) as s:
        assert s.receive_json()["role"] == "viewer"
        s.send_json(
            {
                "type": "ops",
                "opId": "x",
                "ops": [{"id": "sheet.mutation.set-range-values", "params": {}}],
            }
        )
        assert s.receive_json() == {"type": "error", "message": "Read-only access"}

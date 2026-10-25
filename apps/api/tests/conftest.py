import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

TEST_DB = os.environ.get(
    "THULE_TEST_DATABASE_URL",
    "postgresql+asyncpg://thule:thule@127.0.0.1:55432/thule_sheets_test",
)
os.environ["THULE_DATABASE_URL"] = TEST_DB
os.environ["THULE_DB_POOL"] = "false"
os.environ["THULE_ALLOW_PRIVATE_DB_HOSTS"] = "true"

import asyncpg  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402

from app.main import app  # noqa: E402
from app.pg.pools import pools  # noqa: E402

API_DIR = Path(__file__).resolve().parents[1]
RAW_DSN = TEST_DB.replace("postgresql+asyncpg://", "postgresql://")
TABLES = (
    "audit_log, db_connections, recent_views, favorites, workbook_shares, workbook_versions, "
    "workbooks, workspace_members, workspaces, users"
)


@pytest.fixture(scope="session", autouse=True)
def migrate() -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_DIR,
        check=True,
        env={**os.environ},
    )


@pytest.fixture(autouse=True)
async def clean_db() -> AsyncIterator[None]:
    conn = await asyncpg.connect(RAW_DSN)
    await conn.execute(f"TRUNCATE {TABLES} CASCADE")
    await conn.close()
    yield
    # Pools are bound to the event loop of the test that created them.
    await pools.close_all()


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


async def register(client: httpx.AsyncClient, email: str, name: str = "Test") -> dict:
    r = await client.post(
        "/api/auth/register", json={"email": email, "name": name, "password": "password123"}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def personal_workspace(client: httpx.AsyncClient) -> str:
    r = await client.get("/api/workspaces")
    return next(w["id"] for w in r.json() if w["is_personal"])

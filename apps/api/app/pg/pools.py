"""Connection pools for user-defined PostgreSQL connections."""

import asyncio
import ipaddress
import socket
import ssl
import uuid
from dataclasses import dataclass

import asyncpg

from app.config import get_settings
from app.models import DbConnection
from app.security import decrypt_secret

SSL_MODES = ("disable", "allow", "prefer", "require", "verify-ca", "verify-full")


class ConnectionConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ConnParams:
    host: str
    port: int
    database: str
    username: str
    password: str
    sslmode: str
    read_only: bool


def params_from_model(conn: DbConnection) -> ConnParams:
    return ConnParams(
        host=conn.host,
        port=conn.port,
        database=conn.database,
        username=conn.username,
        password=decrypt_secret(conn.password_enc),
        sslmode=conn.sslmode,
        read_only=conn.read_only,
    )


async def check_host_allowed(host: str, port: int) -> None:
    """Block private, loopback and link-local targets unless explicitly allowed (SSRF)."""
    if get_settings().allow_private_db_hosts:
        return
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ConnectionConfigError(f"Cannot resolve host {host!r}") from exc
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if not address.is_global:
            raise ConnectionConfigError("Connections to private network addresses are disabled")


def _ssl_arg(sslmode: str) -> ssl.SSLContext | str | bool:
    if sslmode == "verify-full":
        return ssl.create_default_context()
    if sslmode == "verify-ca":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        return ctx
    if sslmode == "disable":
        return False
    return sslmode  # allow / prefer / require are handled by asyncpg


def _server_settings(params: ConnParams) -> dict[str, str]:
    settings = {
        "application_name": "thule-sheets",
        "statement_timeout": str(get_settings().db_statement_timeout_ms),
        "idle_in_transaction_session_timeout": "60000",
    }
    if params.read_only:
        settings["default_transaction_read_only"] = "on"
    return settings


async def open_connection(params: ConnParams) -> asyncpg.Connection:
    await check_host_allowed(params.host, params.port)
    return await asyncpg.connect(
        host=params.host,
        port=params.port,
        database=params.database,
        user=params.username,
        password=params.password,
        ssl=_ssl_arg(params.sslmode),
        timeout=10,
        server_settings=_server_settings(params),
    )


class PoolManager:
    def __init__(self) -> None:
        self._pools: dict[uuid.UUID, tuple[ConnParams, asyncpg.Pool]] = {}
        self._lock = asyncio.Lock()

    async def get(self, connection_id: uuid.UUID, params: ConnParams) -> asyncpg.Pool:
        async with self._lock:
            cached = self._pools.get(connection_id)
            if cached and cached[0] == params:
                return cached[1]
            if cached:
                await cached[1].close()
            await check_host_allowed(params.host, params.port)
            pool = await asyncpg.create_pool(
                host=params.host,
                port=params.port,
                database=params.database,
                user=params.username,
                password=params.password,
                ssl=_ssl_arg(params.sslmode),
                timeout=10,
                min_size=0,
                max_size=5,
                max_inactive_connection_lifetime=300,
                server_settings=_server_settings(params),
            )
            self._pools[connection_id] = (params, pool)
            return pool

    async def drop(self, connection_id: uuid.UUID) -> None:
        async with self._lock:
            cached = self._pools.pop(connection_id, None)
        if cached:
            await cached[1].close()

    async def close_all(self) -> None:
        async with self._lock:
            pools = list(self._pools.values())
            self._pools.clear()
        for _, pool in pools:
            await pool.close()


pools = PoolManager()

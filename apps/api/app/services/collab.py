"""Real-time fan-out for workbook rooms.

Every API instance keeps its own WebSocket peers. With Redis configured, messages
are published to a channel per workbook so peers connected to other instances
receive them too; presence is kept in a Redis hash with a TTL. Without Redis the
hub works in-process (single instance, tests, local development).
"""

import asyncio
import contextlib
import json
import logging
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis

log = logging.getLogger(__name__)

CHANNEL_PREFIX = "thule:wb:"
PRESENCE_PREFIX = "thule:presence:"
PRESENCE_TTL_SECONDS = 90

PEER_COLORS = ["#8B5CF6", "#F472B6", "#22D3EE", "#F59E0B", "#34D399", "#60A5FA", "#F87171"]


@dataclass
class Peer:
    websocket: WebSocket
    client_id: str
    user_id: uuid.UUID
    name: str
    color: str
    role: str
    selection: Any = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def info(self) -> dict[str, Any]:
        return {
            "clientId": self.client_id,
            "userId": str(self.user_id),
            "name": self.name,
            "color": self.color,
            "selection": self.selection,
        }

    async def send(self, message: dict[str, Any]) -> None:
        async with self.lock:
            with contextlib.suppress(Exception):
                await self.websocket.send_json(message)


class CollabHub:
    def __init__(self) -> None:
        self.instance_id = secrets.token_hex(8)
        self.rooms: dict[uuid.UUID, dict[str, Peer]] = {}
        self.redis: Redis | None = None
        self._listener: asyncio.Task[None] | None = None

    async def start(self, redis_url: str | None) -> None:
        if not redis_url:
            return
        self.redis = Redis.from_url(redis_url, decode_responses=True)
        self._listener = asyncio.create_task(self._listen())

    async def stop(self) -> None:
        if self._listener:
            self._listener.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._listener
        if self.redis:
            await self.redis.aclose()

    @staticmethod
    def color_for(user_id: uuid.UUID) -> str:
        return PEER_COLORS[user_id.int % len(PEER_COLORS)]

    async def join(self, workbook_id: uuid.UUID, peer: Peer) -> list[dict[str, Any]]:
        self.rooms.setdefault(workbook_id, {})[peer.client_id] = peer
        await self._store_presence(workbook_id, peer)
        peers = await self.peers(workbook_id)
        await self.publish(workbook_id, {"type": "presence", **peer.info()}, exclude=peer.client_id)
        return [p for p in peers if p["clientId"] != peer.client_id]

    async def leave(self, workbook_id: uuid.UUID, peer: Peer) -> None:
        room = self.rooms.get(workbook_id, {})
        room.pop(peer.client_id, None)
        if not room:
            self.rooms.pop(workbook_id, None)
        if self.redis:
            await self.redis.hdel(f"{PRESENCE_PREFIX}{workbook_id}", peer.client_id)
        await self.publish(workbook_id, {"type": "leave", "clientId": peer.client_id})

    async def update_presence(self, workbook_id: uuid.UUID, peer: Peer, selection: Any) -> None:
        peer.selection = selection
        await self._store_presence(workbook_id, peer)
        await self.publish(workbook_id, {"type": "presence", **peer.info()}, exclude=peer.client_id)

    async def touch(self, workbook_id: uuid.UUID, peer: Peer) -> None:
        """Refresh the presence TTL without notifying other peers."""
        await self._store_presence(workbook_id, peer)

    async def peers(self, workbook_id: uuid.UUID) -> list[dict[str, Any]]:
        if self.redis:
            raw = await self.redis.hgetall(f"{PRESENCE_PREFIX}{workbook_id}")
            return [json.loads(v) for v in raw.values()]
        return [p.info() for p in self.rooms.get(workbook_id, {}).values()]

    async def publish(
        self, workbook_id: uuid.UUID, message: dict[str, Any], *, exclude: str | None = None
    ) -> None:
        await self._deliver(workbook_id, message, exclude)
        if self.redis:
            envelope = {"origin": self.instance_id, "exclude": exclude, "message": message}
            await self.redis.publish(f"{CHANNEL_PREFIX}{workbook_id}", json.dumps(envelope))

    async def _deliver(
        self, workbook_id: uuid.UUID, message: dict[str, Any], exclude: str | None
    ) -> None:
        peers = [p for p in self.rooms.get(workbook_id, {}).values() if p.client_id != exclude]
        await asyncio.gather(*(p.send(message) for p in peers))

    async def _store_presence(self, workbook_id: uuid.UUID, peer: Peer) -> None:
        if not self.redis:
            return
        key = f"{PRESENCE_PREFIX}{workbook_id}"
        await self.redis.hset(key, peer.client_id, json.dumps(peer.info()))
        await self.redis.expire(key, PRESENCE_TTL_SECONDS)

    async def _listen(self) -> None:
        assert self.redis is not None
        while True:
            try:
                pubsub = self.redis.pubsub()
                await pubsub.psubscribe(f"{CHANNEL_PREFIX}*")
                async for item in pubsub.listen():
                    if item.get("type") != "pmessage":
                        continue
                    envelope = json.loads(item["data"])
                    if envelope.get("origin") == self.instance_id:
                        continue
                    workbook_id = uuid.UUID(item["channel"].removeprefix(CHANNEL_PREFIX))
                    await self._deliver(workbook_id, envelope["message"], envelope.get("exclude"))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Redis listener failed, reconnecting")
                await asyncio.sleep(1)


hub = CollabHub()

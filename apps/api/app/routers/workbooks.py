import json
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, TypeGuard

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import get_settings
from app.db import SessionLocal
from app.deps import (
    CurrentUser,
    SessionDep,
    load_workbook,
    require_workspace_role,
    user_from_token,
    workbook_role,
)
from app.models import (
    ROLE_RANK,
    Favorite,
    RecentView,
    Role,
    User,
    Workbook,
    WorkbookOp,
    WorkbookShare,
    WorkbookVersion,
    Workspace,
    WorkspaceMember,
)
from app.services.collab import Peer, hub
from app.services.templates import TEMPLATES

router = APIRouter(prefix="/workbooks", tags=["workbooks"])

AUTO_VERSION_INTERVAL = timedelta(minutes=30)
MAX_OPS_MESSAGE_BYTES = 4 * 1024 * 1024
# Univer mutation ids look like "sheet.mutation.set-range-values" or
# "data-validation.mutation.updateRule". Only mutations are relayed to peers.
MUTATION_ID = re.compile(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.mutation\.[A-Za-z0-9_.-]+$")


class WorkbookItem(BaseModel):
    id: uuid.UUID
    title: str
    workspace_id: uuid.UUID
    workspace_name: str
    owner_name: str
    updated_at: datetime
    role: Role
    favorite: bool
    viewed_at: datetime | None


class WorkbookCreate(BaseModel):
    workspace_id: uuid.UUID
    title: str = Field(default="Новая таблица", min_length=1, max_length=200)
    template: Literal["blank", "finance"] = "blank"


class WorkbookPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    workspace_id: uuid.UUID | None = None


class WorkbookOut(BaseModel):
    id: uuid.UUID
    title: str
    workspace_id: uuid.UUID
    workspace_name: str
    role: Role
    favorite: bool
    head_rev: int
    snapshot_rev: int
    snapshot: dict[str, Any]
    updated_at: datetime


class SnapshotIn(BaseModel):
    rev: int = Field(ge=0)
    snapshot: dict[str, Any]


class SnapshotOut(BaseModel):
    snapshot_rev: int
    head_rev: int


class OpsOut(BaseModel):
    rev: int
    client_id: str
    op_id: str | None
    ops: list[Any]


class ShareIn(BaseModel):
    email: EmailStr
    role: Literal[Role.viewer, Role.editor]


class ShareOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: Role
    source: Literal["workspace", "share"]


class VersionIn(BaseModel):
    label: str | None = Field(default=None, max_length=200)


class VersionOut(BaseModel):
    id: uuid.UUID
    rev: int
    label: str | None
    author: str | None
    created_at: datetime


# ---------------------------------------------------------------- listing


@router.get("")
async def list_workbooks(
    user: CurrentUser,
    session: SessionDep,
    view: Literal["all", "recent", "favorites", "shared"] = "all",
    workspace_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=200),
) -> list[WorkbookItem]:
    member = (
        select(WorkspaceMember.role)
        .where(
            WorkspaceMember.workspace_id == Workbook.workspace_id,
            WorkspaceMember.user_id == user.id,
        )
        .scalar_subquery()
    )
    shared = (
        select(WorkbookShare.role)
        .where(WorkbookShare.workbook_id == Workbook.id, WorkbookShare.user_id == user.id)
        .scalar_subquery()
    )
    fav = (
        select(func.count())
        .where(Favorite.workbook_id == Workbook.id, Favorite.user_id == user.id)
        .scalar_subquery()
    )
    viewed = (
        select(RecentView.viewed_at)
        .where(RecentView.workbook_id == Workbook.id, RecentView.user_id == user.id)
        .scalar_subquery()
    )
    owner = select(User.name).where(User.id == Workbook.created_by).scalar_subquery()

    stmt = select(
        Workbook.id,
        Workbook.title,
        Workbook.workspace_id,
        Workspace.name.label("workspace_name"),
        owner.label("owner_name"),
        Workbook.updated_at,
        member.label("member_role"),
        shared.label("share_role"),
        fav.label("fav"),
        viewed.label("viewed_at"),
    ).join(Workspace, Workspace.id == Workbook.workspace_id)

    if view == "shared":
        stmt = stmt.where(shared.is_not(None), member.is_(None))
    else:
        stmt = stmt.where(or_(member.is_not(None), shared.is_not(None)))
    if view == "favorites":
        stmt = stmt.where(fav > 0)
    if view == "recent":
        stmt = stmt.where(viewed.is_not(None)).order_by(viewed.desc()).limit(50)
    else:
        stmt = stmt.order_by(Workbook.updated_at.desc())
    if workspace_id:
        stmt = stmt.where(Workbook.workspace_id == workspace_id)
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        stmt = stmt.where(Workbook.title.ilike(f"%{escaped}%", escape="\\"))

    items = []
    for row in await session.execute(stmt):
        roles = [r for r in (row.member_role, row.share_role) if r is not None]
        items.append(
            WorkbookItem(
                id=row.id,
                title=row.title,
                workspace_id=row.workspace_id,
                workspace_name=row.workspace_name,
                owner_name=row.owner_name,
                updated_at=row.updated_at,
                role=max(roles, key=lambda r: ROLE_RANK[r]),
                favorite=row.fav > 0,
                viewed_at=row.viewed_at,
            )
        )
    return items


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_workbook(
    data: WorkbookCreate, user: CurrentUser, session: SessionDep
) -> WorkbookOut:
    await require_workspace_role(session, data.workspace_id, user, Role.editor)
    make_snapshot = TEMPLATES[data.template]
    title = data.title.strip()
    workbook = Workbook(
        workspace_id=data.workspace_id,
        title=title,
        created_by=user.id,
        snapshot=make_snapshot(title),
        head_rev=0,
        snapshot_rev=0,
    )
    session.add(workbook)
    await session.commit()
    return await _workbook_out(session, workbook, Role.owner, user)


async def _workbook_out(
    session: SessionDep, workbook: Workbook, role: Role, user: User
) -> WorkbookOut:
    workspace = await session.get_one(Workspace, workbook.workspace_id)
    favorite = await session.get(Favorite, (user.id, workbook.id)) is not None
    return WorkbookOut(
        id=workbook.id,
        title=workbook.title,
        workspace_id=workbook.workspace_id,
        workspace_name=workspace.name,
        role=role,
        favorite=favorite,
        head_rev=workbook.head_rev,
        snapshot_rev=workbook.snapshot_rev,
        snapshot=workbook.snapshot,
        updated_at=workbook.updated_at,
    )


@router.get("/{workbook_id}")
async def get_workbook(
    workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> WorkbookOut:
    workbook, role = await load_workbook(session, workbook_id, user, Role.viewer)
    await session.execute(
        pg_insert(RecentView)
        .values(user_id=user.id, workbook_id=workbook.id)
        .on_conflict_do_update(
            index_elements=[RecentView.user_id, RecentView.workbook_id],
            set_={"viewed_at": func.now()},
        )
    )
    await session.commit()
    return await _workbook_out(session, workbook, role, user)


@router.patch("/{workbook_id}")
async def update_workbook(
    workbook_id: uuid.UUID, data: WorkbookPatch, user: CurrentUser, session: SessionDep
) -> WorkbookOut:
    workbook, role = await load_workbook(session, workbook_id, user, Role.editor)
    if data.title is not None:
        workbook.title = data.title.strip()
    workbook.updated_at = datetime.now(UTC)
    if data.workspace_id is not None and data.workspace_id != workbook.workspace_id:
        await require_workspace_role(session, workbook.workspace_id, user, Role.owner)
        await require_workspace_role(session, data.workspace_id, user, Role.editor)
        workbook.workspace_id = data.workspace_id
    await session.commit()
    await hub.publish(workbook.id, {"type": "meta", "title": workbook.title})
    return await _workbook_out(session, workbook, role, user)


@router.delete("/{workbook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workbook(workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> None:
    workbook, _ = await load_workbook(session, workbook_id, user, Role.viewer)
    await require_workspace_role(session, workbook.workspace_id, user, Role.editor)
    await session.delete(workbook)
    await session.commit()


@router.put("/{workbook_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def add_favorite(workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> None:
    await load_workbook(session, workbook_id, user, Role.viewer)
    await session.execute(
        pg_insert(Favorite)
        .values(user_id=user.id, workbook_id=workbook_id)
        .on_conflict_do_nothing()
    )
    await session.commit()


@router.delete("/{workbook_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def remove_favorite(workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> None:
    await session.execute(
        delete(Favorite).where(Favorite.user_id == user.id, Favorite.workbook_id == workbook_id)
    )
    await session.commit()


# ---------------------------------------------------------------- content


@router.get("/{workbook_id}/ops")
async def get_ops(
    workbook_id: uuid.UUID,
    user: CurrentUser,
    session: SessionDep,
    since: int = Query(ge=0),
) -> list[OpsOut]:
    await load_workbook(session, workbook_id, user, Role.viewer)
    rows = await session.scalars(
        select(WorkbookOp)
        .where(WorkbookOp.workbook_id == workbook_id, WorkbookOp.rev > since)
        .order_by(WorkbookOp.rev)
    )
    return [OpsOut(rev=r.rev, client_id=r.client_id, op_id=r.op_id, ops=r.ops) for r in rows]


@router.put("/{workbook_id}/snapshot")
async def save_snapshot(
    workbook_id: uuid.UUID, data: SnapshotIn, user: CurrentUser, session: SessionDep
) -> SnapshotOut:
    """Store a full snapshot produced by a client whose state reflects revision `rev`."""
    await load_workbook(session, workbook_id, user, Role.editor)
    workbook = await session.scalar(
        select(Workbook).where(Workbook.id == workbook_id).with_for_update()
    )
    assert workbook is not None
    if data.rev > workbook.head_rev:
        raise HTTPException(status.HTTP_409_CONFLICT, "Revision is ahead of the server")
    if data.rev >= workbook.snapshot_rev:
        workbook.snapshot = data.snapshot
        workbook.snapshot_rev = data.rev
        workbook.updated_at = datetime.now(UTC)
        last_version = await session.scalar(
            select(func.max(WorkbookVersion.created_at)).where(
                WorkbookVersion.workbook_id == workbook_id
            )
        )
        if last_version is None or datetime.now(UTC) - last_version > AUTO_VERSION_INTERVAL:
            session.add(
                WorkbookVersion(
                    workbook_id=workbook_id,
                    rev=data.rev,
                    snapshot=data.snapshot,
                    created_by=user.id,
                )
            )
    await session.commit()
    return SnapshotOut(snapshot_rev=workbook.snapshot_rev, head_rev=workbook.head_rev)


# ---------------------------------------------------------------- versions


@router.get("/{workbook_id}/versions")
async def list_versions(
    workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> list[VersionOut]:
    await load_workbook(session, workbook_id, user, Role.viewer)
    rows = await session.execute(
        select(WorkbookVersion, User.name)
        .outerjoin(User, User.id == WorkbookVersion.created_by)
        .where(WorkbookVersion.workbook_id == workbook_id)
        .order_by(WorkbookVersion.created_at.desc())
        .limit(200)
    )
    return [
        VersionOut(id=v.id, rev=v.rev, label=v.label, author=name, created_at=v.created_at)
        for v, name in rows
    ]


@router.post("/{workbook_id}/versions", status_code=status.HTTP_201_CREATED)
async def create_version(
    workbook_id: uuid.UUID, data: VersionIn, user: CurrentUser, session: SessionDep
) -> VersionOut:
    workbook, _ = await load_workbook(session, workbook_id, user, Role.editor)
    version = WorkbookVersion(
        workbook_id=workbook_id,
        rev=workbook.snapshot_rev,
        label=data.label,
        snapshot=workbook.snapshot,
        created_by=user.id,
    )
    session.add(version)
    await session.commit()
    return VersionOut(
        id=version.id,
        rev=version.rev,
        label=version.label,
        author=user.name,
        created_at=version.created_at,
    )


@router.post("/{workbook_id}/versions/{version_id}/restore")
async def restore_version(
    workbook_id: uuid.UUID, version_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> SnapshotOut:
    await load_workbook(session, workbook_id, user, Role.editor)
    version = await session.get(WorkbookVersion, version_id)
    if version is None or version.workbook_id != workbook_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    workbook = await session.scalar(
        select(Workbook).where(Workbook.id == workbook_id).with_for_update()
    )
    assert workbook is not None
    # Keep the current state as a version, then reset to the selected one.
    session.add(
        WorkbookVersion(
            workbook_id=workbook_id,
            rev=workbook.snapshot_rev,
            snapshot=workbook.snapshot,
            label="Перед восстановлением",
            created_by=user.id,
        )
    )
    workbook.head_rev += 1
    workbook.snapshot = version.snapshot
    workbook.snapshot_rev = workbook.head_rev
    session.add(
        WorkbookOp(
            workbook_id=workbook_id,
            rev=workbook.head_rev,
            user_id=user.id,
            client_id="server",
            ops=[{"reset": True}],
        )
    )
    await session.commit()
    await hub.publish(workbook_id, {"type": "reset", "rev": workbook.head_rev})
    return SnapshotOut(snapshot_rev=workbook.snapshot_rev, head_rev=workbook.head_rev)


# ---------------------------------------------------------------- sharing


@router.get("/{workbook_id}/shares")
async def list_shares(
    workbook_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> list[ShareOut]:
    workbook, _ = await load_workbook(session, workbook_id, user, Role.viewer)
    members = await session.execute(
        select(User, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workbook.workspace_id)
    )
    shares = await session.execute(
        select(User, WorkbookShare.role)
        .join(WorkbookShare, WorkbookShare.user_id == User.id)
        .where(WorkbookShare.workbook_id == workbook_id)
    )
    result = [
        ShareOut(user_id=u.id, email=u.email, name=u.name, role=r, source="workspace")
        for u, r in members
    ]
    result += [
        ShareOut(user_id=u.id, email=u.email, name=u.name, role=r, source="share")
        for u, r in shares
    ]
    return result


@router.put("/{workbook_id}/shares")
async def upsert_share(
    workbook_id: uuid.UUID, data: ShareIn, user: CurrentUser, session: SessionDep
) -> ShareOut:
    await load_workbook(session, workbook_id, user, Role.editor)
    target = await session.scalar(select(User).where(User.email == data.email.lower()))
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if target.id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot share with yourself")
    await session.execute(
        pg_insert(WorkbookShare)
        .values(workbook_id=workbook_id, user_id=target.id, role=data.role)
        .on_conflict_do_update(
            index_elements=[WorkbookShare.workbook_id, WorkbookShare.user_id],
            set_={"role": data.role},
        )
    )
    await session.commit()
    return ShareOut(
        user_id=target.id, email=target.email, name=target.name, role=data.role, source="share"
    )


@router.delete("/{workbook_id}/shares/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_share(
    workbook_id: uuid.UUID, user_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> None:
    await load_workbook(session, workbook_id, user, Role.editor)
    await session.execute(
        delete(WorkbookShare).where(
            WorkbookShare.workbook_id == workbook_id, WorkbookShare.user_id == user_id
        )
    )
    await session.commit()


# ---------------------------------------------------------------- realtime


def _origin_allowed(websocket: WebSocket) -> bool:
    """Reject cross-site WebSocket hijacking: cookies are sent with any origin."""
    origin = websocket.headers.get("origin")
    if origin is None:
        return True  # non-browser clients
    host = websocket.headers.get("host", "")
    return origin.split("://", 1)[-1] == host


def _valid_ops(ops: Any) -> TypeGuard[list[Any]]:
    return (
        isinstance(ops, list)
        and 0 < len(ops) <= 500
        and all(
            isinstance(op, dict)
            and isinstance(op.get("id"), str)
            and MUTATION_ID.match(op["id"])
            # doc.* mutations come from the in-cell editor document, not the workbook
            and not op["id"].startswith("doc.")
            and isinstance(op.get("params"), dict | None)
            for op in ops
        )
    )


async def _append_ops(
    workbook_id: uuid.UUID, user_id: uuid.UUID, client_id: str, op_id: str, ops: list[Any]
) -> tuple[int, bool]:
    """Append a batch and return (revision, created). A repeated op_id returns its revision."""
    async with SessionLocal() as session:
        workbook = await session.scalar(
            select(Workbook).where(Workbook.id == workbook_id).with_for_update()
        )
        assert workbook is not None
        existing = await session.scalar(
            select(WorkbookOp.rev).where(
                WorkbookOp.workbook_id == workbook_id, WorkbookOp.op_id == op_id
            )
        )
        if existing is not None:
            return existing, False
        workbook.head_rev += 1
        workbook.updated_at = datetime.now(UTC)
        session.add(
            WorkbookOp(
                workbook_id=workbook_id,
                rev=workbook.head_rev,
                user_id=user_id,
                client_id=client_id,
                op_id=op_id,
                ops=ops,
            )
        )
        await session.commit()
        return workbook.head_rev, True


@router.websocket("/{workbook_id}/ws")
async def workbook_socket(websocket: WebSocket, workbook_id: uuid.UUID) -> None:
    if not _origin_allowed(websocket):
        await websocket.close(code=4403)
        return
    async with SessionLocal() as session:
        user = await user_from_token(session, websocket.cookies.get(get_settings().cookie_name))
        workbook = await session.get(Workbook, workbook_id) if user else None
        role = await workbook_role(session, workbook, user.id) if workbook and user else None
        head_rev = workbook.head_rev if workbook else 0
    if user is None or role is None:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    peer = Peer(
        websocket=websocket,
        client_id=secrets.token_hex(8),
        user_id=user.id,
        name=user.name,
        color=hub.color_for(user.id),
        role=role.value,
    )
    peers = await hub.join(workbook_id, peer)
    await peer.send(
        {
            "type": "hello",
            "clientId": peer.client_id,
            "rev": head_rev,
            "role": role.value,
            "peers": peers,
        }
    )
    can_edit = ROLE_RANK[role] >= ROLE_RANK[Role.editor]
    try:
        while True:
            text = await websocket.receive_text()
            if len(text) > MAX_OPS_MESSAGE_BYTES:
                await peer.send({"type": "error", "message": "Message too large"})
                continue
            message = _parse(text)
            kind = message.get("type")
            if kind == "ops":
                if not can_edit:
                    await peer.send({"type": "error", "message": "Read-only access"})
                    continue
                ops = message.get("ops")
                op_id = message.get("opId")
                if not _valid_ops(ops) or not isinstance(op_id, str) or not 0 < len(op_id) <= 64:
                    await peer.send({"type": "error", "message": "Invalid operations"})
                    continue
                rev, created = await _append_ops(workbook_id, user.id, peer.client_id, op_id, ops)
                await peer.send({"type": "ack", "opId": op_id, "rev": rev})
                if not created:
                    continue
                await hub.publish(
                    workbook_id,
                    {
                        "type": "ops",
                        "rev": rev,
                        "ops": ops,
                        "clientId": peer.client_id,
                        "userId": str(user.id),
                    },
                    exclude=peer.client_id,
                )
            elif kind == "presence":
                await hub.update_presence(workbook_id, peer, message.get("selection"))
            elif kind == "ping":
                await hub.touch(workbook_id, peer)
                await peer.send({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(workbook_id, peer)


def _parse(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}

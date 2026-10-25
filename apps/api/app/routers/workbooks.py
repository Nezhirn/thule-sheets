import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import CurrentUser, SessionDep, load_workbook, require_workspace_role
from app.models import (
    ROLE_RANK,
    Favorite,
    RecentView,
    Role,
    User,
    Workbook,
    WorkbookShare,
    WorkbookVersion,
    Workspace,
    WorkspaceMember,
)
from app.services.templates import TEMPLATES

router = APIRouter(prefix="/workbooks", tags=["workbooks"])

AUTO_VERSION_INTERVAL = timedelta(minutes=30)


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
    rev: int
    saved_at: datetime
    saved_by: str | None
    saved_by_id: uuid.UUID | None
    snapshot: dict[str, Any]
    updated_at: datetime


class SaveIn(BaseModel):
    # Revision the client's copy was loaded from. A mismatch means someone saved in between.
    base_rev: int = Field(ge=0)
    snapshot: dict[str, Any]
    # Overwrite a newer revision after the user confirmed it.
    force: bool = False


class SaveOut(BaseModel):
    rev: int
    saved_at: datetime


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
        rev=0,
        saved_by=user.id,
    )
    session.add(workbook)
    await session.commit()
    return await _workbook_out(session, workbook, Role.owner, user)


async def _workbook_out(
    session: SessionDep, workbook: Workbook, role: Role, user: User
) -> WorkbookOut:
    workspace = await session.get_one(Workspace, workbook.workspace_id)
    favorite = await session.get(Favorite, (user.id, workbook.id)) is not None
    saved_by = await session.get(User, workbook.saved_by) if workbook.saved_by else None
    return WorkbookOut(
        id=workbook.id,
        title=workbook.title,
        workspace_id=workbook.workspace_id,
        workspace_name=workspace.name,
        role=role,
        favorite=favorite,
        rev=workbook.rev,
        saved_at=workbook.saved_at,
        saved_by=saved_by.name if saved_by else None,
        saved_by_id=workbook.saved_by,
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


async def _lock_workbook(session: AsyncSession, workbook_id: uuid.UUID) -> Workbook:
    """Lock the workbook row and return it with the committed values.

    populate_existing: the object may already be in the session (loaded by the access
    check), and the ORM would otherwise keep its pre-lock attributes, including `rev`.
    """
    workbook = await session.scalar(
        select(Workbook)
        .where(Workbook.id == workbook_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    assert workbook is not None
    return workbook


@router.put("/{workbook_id}/snapshot")
async def save_snapshot(
    workbook_id: uuid.UUID, data: SaveIn, user: CurrentUser, session: SessionDep
) -> SaveOut:
    """Store the client's workbook. Content on the server changes only through this call."""
    await load_workbook(session, workbook_id, user, Role.editor)
    workbook = await _lock_workbook(session, workbook_id)
    if data.base_rev != workbook.rev and not data.force:
        saved_by = await session.get(User, workbook.saved_by) if workbook.saved_by else None
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "The workbook was saved by someone else",
                "rev": workbook.rev,
                "saved_at": workbook.saved_at.isoformat(),
                "saved_by": saved_by.name if saved_by else None,
                "saved_by_id": str(workbook.saved_by) if workbook.saved_by else None,
            },
        )
    now = datetime.now(UTC)
    workbook.snapshot = data.snapshot
    workbook.rev += 1
    workbook.saved_at = now
    workbook.saved_by = user.id
    workbook.updated_at = now
    last_version = await session.scalar(
        select(func.max(WorkbookVersion.created_at)).where(
            WorkbookVersion.workbook_id == workbook_id
        )
    )
    if last_version is None or now - last_version > AUTO_VERSION_INTERVAL:
        session.add(
            WorkbookVersion(
                workbook_id=workbook_id,
                rev=workbook.rev,
                snapshot=data.snapshot,
                created_by=user.id,
            )
        )
    await session.commit()
    return SaveOut(rev=workbook.rev, saved_at=workbook.saved_at)


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
        rev=workbook.rev,
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
) -> SaveOut:
    await load_workbook(session, workbook_id, user, Role.editor)
    version = await session.get(WorkbookVersion, version_id)
    if version is None or version.workbook_id != workbook_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    workbook = await _lock_workbook(session, workbook_id)
    # Keep the current state as a version, then replace it with the selected one.
    session.add(
        WorkbookVersion(
            workbook_id=workbook_id,
            rev=workbook.rev,
            snapshot=workbook.snapshot,
            label="Перед восстановлением",
            created_by=user.id,
        )
    )
    now = datetime.now(UTC)
    workbook.snapshot = version.snapshot
    workbook.rev += 1
    workbook.saved_at = now
    workbook.saved_by = user.id
    workbook.updated_at = now
    await session.commit()
    return SaveOut(rev=workbook.rev, saved_at=workbook.saved_at)


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

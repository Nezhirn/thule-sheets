import uuid

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, select

from app.deps import CurrentUser, SessionDep, require_workspace_role
from app.models import Role, User, Workspace, WorkspaceMember

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    icon: str = Field(default="folder", max_length=40)


class WorkspacePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    icon: str | None = Field(default=None, max_length=40)


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    icon: str
    is_personal: bool
    role: Role


class MemberIn(BaseModel):
    email: EmailStr
    role: Role = Role.editor


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: Role


@router.get("")
async def list_workspaces(user: CurrentUser, session: SessionDep) -> list[WorkspaceOut]:
    rows = await session.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == user.id)
        .order_by(Workspace.is_personal.desc(), Workspace.created_at)
    )
    return [
        WorkspaceOut(id=w.id, name=w.name, icon=w.icon, is_personal=w.is_personal, role=role)
        for w, role in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_workspace(
    data: WorkspaceIn, user: CurrentUser, session: SessionDep
) -> WorkspaceOut:
    workspace = Workspace(name=data.name.strip(), icon=data.icon, created_by=user.id)
    session.add(workspace)
    await session.flush()
    session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.owner))
    await session.commit()
    return WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        icon=workspace.icon,
        is_personal=False,
        role=Role.owner,
    )


@router.patch("/{workspace_id}")
async def update_workspace(
    workspace_id: uuid.UUID, data: WorkspacePatch, user: CurrentUser, session: SessionDep
) -> WorkspaceOut:
    role = await require_workspace_role(session, workspace_id, user, Role.owner)
    workspace = await session.get_one(Workspace, workspace_id)
    if data.name is not None:
        workspace.name = data.name.strip()
    if data.icon is not None:
        workspace.icon = data.icon
    await session.commit()
    return WorkspaceOut(
        id=workspace.id,
        name=workspace.name,
        icon=workspace.icon,
        is_personal=workspace.is_personal,
        role=role,
    )


@router.delete("/{workspace_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(workspace_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> None:
    await require_workspace_role(session, workspace_id, user, Role.owner)
    workspace = await session.get_one(Workspace, workspace_id)
    if workspace.is_personal:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Personal workspace cannot be deleted")
    await session.delete(workspace)
    await session.commit()


@router.get("/{workspace_id}/members")
async def list_members(
    workspace_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> list[MemberOut]:
    await require_workspace_role(session, workspace_id, user, Role.viewer)
    rows = await session.execute(
        select(User, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(WorkspaceMember.workspace_id == workspace_id)
        .order_by(User.name)
    )
    return [MemberOut(user_id=u.id, email=u.email, name=u.name, role=r) for u, r in rows]


@router.put("/{workspace_id}/members")
async def upsert_member(
    workspace_id: uuid.UUID, data: MemberIn, user: CurrentUser, session: SessionDep
) -> MemberOut:
    await require_workspace_role(session, workspace_id, user, Role.owner)
    workspace = await session.get_one(Workspace, workspace_id)
    if workspace.is_personal:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Personal workspace cannot be shared")
    member = await session.scalar(select(User).where(User.email == data.email.lower()))
    if member is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if member.id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot change your own role")
    existing = await session.get(WorkspaceMember, (workspace_id, member.id))
    if existing:
        existing.role = data.role
    else:
        session.add(WorkspaceMember(workspace_id=workspace_id, user_id=member.id, role=data.role))
    await session.commit()
    return MemberOut(user_id=member.id, email=member.email, name=member.name, role=data.role)


@router.delete("/{workspace_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    workspace_id: uuid.UUID, user_id: uuid.UUID, user: CurrentUser, session: SessionDep
) -> None:
    await require_workspace_role(session, workspace_id, user, Role.owner)
    if user_id == user.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot remove yourself")
    await session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    await session.commit()

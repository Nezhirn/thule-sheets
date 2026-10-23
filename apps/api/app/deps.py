import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.models import ROLE_RANK, Role, User, Workbook, WorkbookShare, WorkspaceMember
from app.security import decode_access_token

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def user_from_token(session: AsyncSession, token: str | None) -> User | None:
    if not token:
        return None
    user_id = decode_access_token(token)
    if user_id is None:
        return None
    return await session.get(User, user_id)


async def get_current_user(request: Request, session: SessionDep) -> User:
    user = await user_from_token(session, request.cookies.get(get_settings().cookie_name))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def workspace_role(
    session: AsyncSession, workspace_id: uuid.UUID, user_id: uuid.UUID
) -> Role | None:
    return await session.scalar(
        select(WorkspaceMember.role).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )


async def require_workspace_role(
    session: AsyncSession, workspace_id: uuid.UUID, user: User, minimum: Role
) -> Role:
    role = await workspace_role(session, workspace_id, user.id)
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workspace not found")
    if ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
    return role


async def workbook_role(
    session: AsyncSession, workbook: Workbook, user_id: uuid.UUID
) -> Role | None:
    roles = [
        await workspace_role(session, workbook.workspace_id, user_id),
        await session.scalar(
            select(WorkbookShare.role).where(
                WorkbookShare.workbook_id == workbook.id, WorkbookShare.user_id == user_id
            )
        ),
    ]
    present = [r for r in roles if r is not None]
    return max(present, key=lambda r: ROLE_RANK[r]) if present else None


async def load_workbook(
    session: AsyncSession, workbook_id: uuid.UUID, user: User, minimum: Role
) -> tuple[Workbook, Role]:
    workbook = await session.get(Workbook, workbook_id)
    role = await workbook_role(session, workbook, user.id) if workbook else None
    if workbook is None or role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Workbook not found")
    if ROLE_RANK[role] < ROLE_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
    return workbook, role

import uuid

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select

from app.config import get_settings
from app.deps import CurrentUser, SessionDep
from app.models import Role, User, Workspace, WorkspaceMember
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

DEFAULT_WORKSPACES = [("Личные", "home", True), ("Работа", "briefcase", False)]


class RegisterIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=200)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    name: str


def _set_session_cookie(response: Response, user_id: uuid.UUID) -> None:
    settings = get_settings()
    response.set_cookie(
        settings.cookie_name,
        create_access_token(user_id),
        max_age=settings.access_token_ttl_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(data: RegisterIn, response: Response, session: SessionDep) -> UserOut:
    email = data.email.lower()
    exists = await session.scalar(select(func.count()).where(User.email == email))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    user = User(email=email, name=data.name.strip(), password_hash=hash_password(data.password))
    session.add(user)
    await session.flush()
    for name, icon, personal in DEFAULT_WORKSPACES:
        workspace = Workspace(name=name, icon=icon, is_personal=personal, created_by=user.id)
        session.add(workspace)
        await session.flush()
        session.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=Role.owner))
    await session.commit()
    _set_session_cookie(response, user.id)
    return UserOut(id=user.id, email=user.email, name=user.name)


@router.post("/login")
async def login(data: LoginIn, response: Response, session: SessionDep) -> UserOut:
    user = await session.scalar(select(User).where(User.email == data.email.lower()))
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    _set_session_cookie(response, user.id)
    return UserOut(id=user.id, email=user.email, name=user.name)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response) -> None:
    response.delete_cookie(get_settings().cookie_name, path="/")


@router.get("/me")
async def me(user: CurrentUser) -> UserOut:
    return UserOut(id=user.id, email=user.email, name=user.name)

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JSON = dict[str, Any]


class Base(DeclarativeBase):
    type_annotation_map = {JSON: JSONB, uuid.UUID: UUID(as_uuid=True)}


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(primary_key=True, default=uuid.uuid4)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Role(enum.StrEnum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


ROLE_RANK = {Role.viewer: 1, Role.editor: 2, Role.owner: 3}

role_enum = Enum(Role, name="role", values_callable=lambda e: [m.value for m in e])


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = _created_at()


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(120))
    icon: Mapped[str] = mapped_column(String(40), default="folder")
    is_personal: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _created_at()


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[Role] = mapped_column(role_enum)


class Workbook(Base):
    __tablename__ = "workbooks"

    id: Mapped[uuid.UUID] = _uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = _created_at()
    # Set explicitly on content and metadata changes.
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Revision of the last accepted operation batch.
    head_rev: Mapped[int] = mapped_column(Integer, default=0)
    # Latest full snapshot (Univer IWorkbookData) and the revision it reflects.
    snapshot: Mapped[JSON] = mapped_column(JSONB)
    snapshot_rev: Mapped[int] = mapped_column(Integer, default=0)


class WorkbookOp(Base):
    __tablename__ = "workbook_ops"
    # Clients resend a batch after reconnecting; op_id makes the append idempotent.
    __table_args__ = (UniqueConstraint("workbook_id", "op_id"),)

    workbook_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workbooks.id", ondelete="CASCADE"), primary_key=True
    )
    rev: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    client_id: Mapped[str] = mapped_column(String(64))
    op_id: Mapped[str | None] = mapped_column(String(64))
    ops: Mapped[list[Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = _created_at()


class WorkbookVersion(Base):
    __tablename__ = "workbook_versions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    workbook_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workbooks.id", ondelete="CASCADE"), index=True
    )
    rev: Mapped[int] = mapped_column(Integer)
    label: Mapped[str | None] = mapped_column(String(200))
    snapshot: Mapped[JSON] = mapped_column(JSONB)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _created_at()


class WorkbookShare(Base):
    __tablename__ = "workbook_shares"

    workbook_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workbooks.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[Role] = mapped_column(role_enum)
    created_at: Mapped[datetime] = _created_at()


class Favorite(Base):
    __tablename__ = "favorites"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    workbook_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workbooks.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = _created_at()


class RecentView(Base):
    __tablename__ = "recent_views"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    workbook_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workbooks.id", ondelete="CASCADE"), primary_key=True
    )
    viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DbConnection(Base):
    __tablename__ = "db_connections"
    __table_args__ = (UniqueConstraint("workspace_id", "name"),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    host: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=5432)
    database: Mapped[str] = mapped_column(String(120))
    username: Mapped[str] = mapped_column(String(120))
    password_enc: Mapped[bytes] = mapped_column(LargeBinary)
    sslmode: Mapped[str] = mapped_column(String(20), default="prefer")
    read_only: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _created_at()


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_log_target", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(80))
    target_type: Mapped[str] = mapped_column(String(40))
    target_id: Mapped[str] = mapped_column(String(80))
    details: Mapped[JSON] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _created_at()


__all__ = [
    "AuditLog",
    "Base",
    "DbConnection",
    "Favorite",
    "RecentView",
    "Role",
    "ROLE_RANK",
    "User",
    "Workbook",
    "WorkbookOp",
    "WorkbookShare",
    "WorkbookVersion",
    "Workspace",
    "WorkspaceMember",
]

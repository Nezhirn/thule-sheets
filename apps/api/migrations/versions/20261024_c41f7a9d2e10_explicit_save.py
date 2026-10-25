"""explicit save: drop the operation log, keep a single content revision

Revision ID: c41f7a9d2e10
Revises: b2e525df9c2d
Create Date: 2026-10-24 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c41f7a9d2e10"
down_revision: str | None = "b2e525df9c2d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Under realtime sync the stored snapshot could lag behind the operation log; clients
    # replayed the newer operations on load. Dropping the log would lose those edits.
    lagging = (
        op.get_bind()
        .execute(sa.text("SELECT count(*) FROM workbooks WHERE head_rev > snapshot_rev"))
        .scalar_one()
    )
    if lagging:
        raise RuntimeError(
            f"{lagging} workbook(s) have operations newer than their snapshot. Open and save "
            "them with the previous release (or drop the operations deliberately) before "
            "upgrading."
        )
    op.drop_table("workbook_ops")
    op.drop_column("workbooks", "head_rev")
    op.alter_column("workbooks", "snapshot_rev", new_column_name="rev")
    op.add_column(
        "workbooks",
        sa.Column(
            "saved_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.add_column("workbooks", sa.Column("saved_by", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "workbooks_saved_by_fkey", "workbooks", "users", ["saved_by"], ["id"], ondelete="SET NULL"
    )
    op.execute("UPDATE workbooks SET saved_at = updated_at")


def downgrade() -> None:
    op.drop_constraint("workbooks_saved_by_fkey", "workbooks", type_="foreignkey")
    op.drop_column("workbooks", "saved_by")
    op.drop_column("workbooks", "saved_at")
    op.alter_column("workbooks", "rev", new_column_name="snapshot_rev")
    op.add_column(
        "workbooks",
        sa.Column("head_rev", sa.Integer(), server_default="0", nullable=False),
    )
    op.execute("UPDATE workbooks SET head_rev = snapshot_rev")
    op.alter_column("workbooks", "head_rev", server_default=None)
    op.create_table(
        "workbook_ops",
        sa.Column("workbook_id", sa.UUID(), nullable=False),
        sa.Column("rev", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=True),
        sa.Column("client_id", sa.String(length=64), nullable=False),
        sa.Column("op_id", sa.String(length=64), nullable=True),
        sa.Column("ops", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["workbook_id"], ["workbooks.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("workbook_id", "rev"),
        sa.UniqueConstraint("workbook_id", "op_id"),
    )

"""Remember the Open Notebook notebook name for an export.

Revision ID: 20260930_12
Revises: 20260930_11
Create Date: 2026-09-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "20260930_12"
down_revision: Union[str, Sequence[str], None] = "20260930_11"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("meeting_exports")}
    if "open_notebook_notebook_name" not in columns:
        with op.batch_alter_table("meeting_exports") as batch:
            batch.add_column(sa.Column("open_notebook_notebook_name", sa.String(length=200), nullable=True))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("meeting_exports")}
    if "open_notebook_notebook_name" in columns:
        with op.batch_alter_table("meeting_exports") as batch:
            batch.drop_column("open_notebook_notebook_name")

"""город продажи (Китай) и страховая история (Корея)

Revision ID: c3f1a9d2e7b4
Revises: adcec81ea85a
Create Date: 2026-10-18 12:00:00
"""
from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = 'c3f1a9d2e7b4'
down_revision: Union[str, None] = 'adcec81ea85a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('cars', sa.Column('sale_city', sa.String(length=96), nullable=True))
    op.add_column('cars', sa.Column('insurance_cases', sa.SmallInteger(), nullable=True))
    op.add_column('cars', sa.Column('insurance_paid_krw', sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column('cars', 'insurance_paid_krw')
    op.drop_column('cars', 'insurance_cases')
    op.drop_column('cars', 'sale_city')

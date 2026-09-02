"""database.py — движок и сессия SQLAlchemy (по образцу poster_saas/database/db.py)."""
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from config import DATABASE_URL

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=5)
SessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False)


async def get_session():
    """Зависимость FastAPI: сессия на запрос."""
    async with SessionLocal() as session:
        yield session

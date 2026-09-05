"""deps.py — зависимости FastAPI: текущий владелец из JWT."""
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import OWNER_PRIMARY_TELEGRAM_ID, OWNER_TELEGRAM_IDS
from database import get_session
from models import Owner
from security import decode_jwt


def check_allowed(telegram_id: int) -> None:
    """Белый список. Пустой = режим одного пользователя, пускаем всех подписанных."""
    if OWNER_TELEGRAM_IDS and telegram_id not in OWNER_TELEGRAM_IDS:
        raise HTTPException(status_code=403, detail="not allowed")


async def get_or_create_owner(
    session: AsyncSession, telegram_id: int, user: dict | None = None
) -> Owner:
    # Общая база: второй аккаунт того же человека (рабочий Telegram) работает от
    # имени основного владельца — иначе он получил бы свою пустую базу и не увидел
    # бы ни карточек, ни фото. Отдельной строки в owners для него не заводим.
    if OWNER_PRIMARY_TELEGRAM_ID and telegram_id != OWNER_PRIMARY_TELEGRAM_ID:
        telegram_id = OWNER_PRIMARY_TELEGRAM_ID
        user = None            # имя и username остаются от основного аккаунта

    owner = (
        await session.execute(select(Owner).where(Owner.telegram_id == telegram_id))
    ).scalar_one_or_none()
    if owner:
        return owner
    owner = Owner(
        telegram_id=telegram_id,
        username=(user or {}).get("username"),
        first_name=(user or {}).get("first_name"),
    )
    session.add(owner)
    await session.flush()
    return owner


async def get_current_owner(
    authorization: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
) -> Owner:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="not authenticated")
    telegram_id = decode_jwt(authorization.split(" ", 1)[1].strip())
    if telegram_id is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    check_allowed(telegram_id)

    owner = (
        await session.execute(select(Owner).where(Owner.telegram_id == telegram_id))
    ).scalar_one_or_none()
    if not owner:
        raise HTTPException(status_code=401, detail="not authenticated")
    return owner

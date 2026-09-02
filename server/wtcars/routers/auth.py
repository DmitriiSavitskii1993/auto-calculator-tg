"""auth.py — вход из Mini App по подписи initData."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from deps import check_allowed, get_or_create_owner
from schemas import AuthIn, AuthOut
from security import create_jwt, verify_webapp_initdata

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/miniapp", response_model=AuthOut)
async def auth_miniapp(body: AuthIn, session: AsyncSession = Depends(get_session)):
    user = verify_webapp_initdata(body.init_data)
    if not user:
        raise HTTPException(status_code=403, detail="bad initData")
    check_allowed(user["id"])

    owner = await get_or_create_owner(session, user["id"], user)
    await session.commit()
    return AuthOut(
        token=create_jwt(owner.telegram_id),
        owner_id=owner.id,
        telegram_id=owner.telegram_id,
        username=owner.username,
        first_name=owner.first_name,
    )

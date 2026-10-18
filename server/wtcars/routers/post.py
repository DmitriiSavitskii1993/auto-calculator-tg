"""
post.py — готовый пост по карточке: бот присылает альбом в чат с вошедшим.

Telegram не даёт Mini App отправить альбом в чужой чат, поэтому пост приходит
в личку с ботом, а оттуда пересылается клиенту — при пересылке альбом
остаётся альбомом, а подпись — под ним.
"""
import json
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import WT_BOT_TOKEN
from database import get_session
from deps import get_actor_telegram_id, get_current_owner
from models import Car, Owner
from services import storage

log = logging.getLogger("wtcars.post")
router = APIRouter(tags=["post"])

ALBUM_MAX = 10
CAPTION_LIMIT = 1024
MESSAGE_LIMIT = 4096
CALC_IMAGE_MAX_BYTES = 5 * 1024 * 1024
# 1600 px — потолок миниатюр; Telegram всё равно пережимает фото, а оригиналы
# по 2 МБ десятком тормозили бы отправку.
PHOTO_EDGE = 1600


def _tg_len(text: str) -> int:
    # Telegram меряет длину в UTF-16: эмодзи вроде 🚗 занимают две единицы
    return len(text.encode("utf-16-le")) // 2


async def _tg_call(client: httpx.AsyncClient, method: str, data: dict, files=None) -> dict:
    r = await client.post(f"https://api.telegram.org/bot{WT_BOT_TOKEN}/{method}",
                          data=data, files=files)
    try:
        body = r.json()
    except ValueError:
        body = {}
    if body.get("ok"):
        return body
    desc = body.get("description") or f"HTTP {r.status_code}"
    log.warning("telegram %s: %s", method, desc)
    if body.get("error_code") == 403 or "chat not found" in desc:
        raise HTTPException(
            status_code=409,
            detail="Бот не может вам написать: откройте чат с ботом и нажмите «Старт»",
        )
    raise HTTPException(status_code=502, detail=f"Telegram: {desc}")


@router.post("/cars/{car_id}/send")
async def send_post(
    car_id: int,
    text: str = Form(...),
    calc_image: UploadFile | None = File(default=None),
    owner: Owner = Depends(get_current_owner),
    actor_id: int = Depends(get_actor_telegram_id),
    session: AsyncSession = Depends(get_session),
):
    if not WT_BOT_TOKEN:
        raise HTTPException(status_code=503, detail="токен бота не настроен")
    text = text.strip()
    if not text or _tg_len(text) > MESSAGE_LIMIT:
        raise HTTPException(status_code=400, detail="пустой или слишком длинный текст")

    car = (
        await session.execute(select(Car).where(Car.id == car_id, Car.owner_id == owner.id))
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="car not found")

    # (имя вложения, байты, mime) — в порядке показа: фото машины, расчёт последним
    items: list[tuple[str, bytes, str]] = []
    for p in car.photos:
        path = Path(p.storage_path)
        if not path.is_file():
            continue
        small = storage.thumb_for(path, PHOTO_EDGE)
        mime = "image/jpeg" if small != path else (p.mime or "image/jpeg")
        items.append((f"p{p.id}", small.read_bytes(), mime))

    if calc_image is not None:
        data = await calc_image.read(CALC_IMAGE_MAX_BYTES + 1)
        if len(data) > CALC_IMAGE_MAX_BYTES:
            raise HTTPException(status_code=400, detail="картинка расчёта слишком большая")
        if data:
            try:
                mime, _, _ = storage.probe(data)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            items.append(("calc", data, mime))

    caption_fits = _tg_len(text) <= CAPTION_LIMIT
    sent = 0
    async with httpx.AsyncClient(timeout=60) as client:
        for start in range(0, len(items), ALBUM_MAX):
            chunk = items[start:start + ALBUM_MAX]
            media, files = [], {}
            for i, (name, data, mime) in enumerate(chunk):
                m = {"type": "photo", "media": f"attach://{name}"}
                if start == 0 and i == 0 and caption_fits:
                    m["caption"] = text
                media.append(m)
                files[name] = (f"{name}.jpg" if mime == "image/jpeg" else f"{name}.png", data, mime)

            if len(chunk) == 1:
                # альбом из одного фото Telegram не принимает — это обычная фотография
                m = media[0]
                payload = {"chat_id": str(actor_id)}
                if "caption" in m:
                    payload["caption"] = m["caption"]
                name = chunk[0][0]
                await _tg_call(client, "sendPhoto", payload, {"photo": files[name]})
            else:
                await _tg_call(client, "sendMediaGroup",
                               {"chat_id": str(actor_id), "media": json.dumps(media, ensure_ascii=False)},
                               files)
            sent += len(chunk)

        if not items or not caption_fits:
            await _tg_call(client, "sendMessage", {"chat_id": str(actor_id), "text": text})

    return {"ok": True, "photos": sent, "caption_separate": bool(items) and not caption_fits}

"""
post.py — готовый пост по карточке: альбом (фото + расчёт) с текстом «Клиенту».

Альбом в чужой чат Mini App отправить не может. Два пути:
  • бот подключён к Telegram Business аккаунта — пост откладывается, бот
    присылает кнопку выбора клиента и по выбору шлёт альбом ОТ ИМЕНИ аккаунта;
  • не подключён — альбом приходит в чат с ботом, оттуда его пересылают.

Обновления Telegram принимает bot/bot.js (webhook один на бота), сюда он
передаёт только нужные события через /internal/tg.
"""
import hashlib
import hmac
import json
import logging
import random
import shutil
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import STORAGE_DIR, WT_BOT_TOKEN
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
PENDING_TTL = 3600

# Надписи кнопок: бот узнаёт их по тексту и передаёт сюда как события
SELF_LABEL = "📥 Прислать мне"
CANCEL_LABEL = "✖️ Отмена"

BUSINESS_FILE = STORAGE_DIR / "business.json"


class TelegramError(Exception):
    def __init__(self, code: int | None, desc: str):
        super().__init__(desc)
        self.code, self.desc = code, desc


def _tg_len(text: str) -> int:
    # Telegram меряет длину в UTF-16: эмодзи вроде 🚗 занимают две единицы
    return len(text.encode("utf-16-le")) // 2


def internal_token() -> str:
    # Выводится из токена бота: он и так есть у обоих сервисов, отдельный
    # секрет пришлось бы заводить в двух .env и держать в согласии.
    return hmac.new(WT_BOT_TOKEN.encode(), b"wtcars-internal", hashlib.sha256).hexdigest()


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
    raise TelegramError(body.get("error_code"), desc)


def _http_error(e: TelegramError) -> HTTPException:
    if e.code == 403 or "chat not found" in e.desc:
        return HTTPException(
            status_code=409,
            detail="Бот не может вам написать: откройте чат с ботом и нажмите «Старт»",
        )
    return HTTPException(status_code=502, detail=f"Telegram: {e.desc}")


async def _send_album(client, chat_id: int, items, text: str, bc_id: str | None = None) -> None:
    """items — [(имя, байты, mime)]. bc_id — отправить от имени бизнес-аккаунта."""
    caption_fits = _tg_len(text) <= CAPTION_LIMIT
    base = {"chat_id": str(chat_id)}
    if bc_id:
        base["business_connection_id"] = bc_id

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
            payload = dict(base)
            if "caption" in media[0]:
                payload["caption"] = media[0]["caption"]
            await _tg_call(client, "sendPhoto", payload, {"photo": files[chunk[0][0]]})
        else:
            await _tg_call(client, "sendMediaGroup",
                           {**base, "media": json.dumps(media, ensure_ascii=False)}, files)

    if not items or not caption_fits:
        await _tg_call(client, "sendMessage", {**base, "text": text})


def _car_items(car: Car, calc_png: bytes | None):
    items = []
    for p in car.photos:
        path = Path(p.storage_path)
        if not path.is_file():
            continue
        small = storage.thumb_for(path, PHOTO_EDGE)
        mime = "image/jpeg" if small != path else (p.mime or "image/jpeg")
        items.append((f"p{p.id}", small.read_bytes(), mime))
    if calc_png:
        items.append(("calc", calc_png, "image/png"))
    return items


# --- бизнес-подключения ----------------------------------------------------

def _load_business() -> dict:
    try:
        return json.loads(BUSINESS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def business_for(user_id: int) -> str | None:
    """id подключения, если бот вправе отвечать от имени этого аккаунта."""
    c = _load_business().get(str(user_id))
    return c["id"] if c and c.get("enabled") and c.get("can_reply") else None


def _save_business_connection(conn: dict) -> None:
    rights = conn.get("rights") or {}
    data = _load_business()
    data[str(conn["user"]["id"])] = {
        "id": conn["id"],
        "enabled": bool(conn.get("is_enabled")),
        # can_reply переехал в rights в Bot API 9.0 — читаем оба места
        "can_reply": bool(rights.get("can_reply", conn.get("can_reply"))),
        "updated": int(time.time()),
    }
    BUSINESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = BUSINESS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(BUSINESS_FILE)


# --- отложенный пост: ждёт, пока выберут клиента -----------------------------

def _pending_dir(actor_id: int) -> Path:
    return storage.TMP_DIR / f"post-{int(actor_id)}"


def _save_pending(actor_id: int, car: Car, text: str, calc_png: bytes | None) -> int:
    d = _pending_dir(actor_id)
    shutil.rmtree(d, ignore_errors=True)       # новый пост заменяет недоотправленный
    d.mkdir(parents=True)
    request_id = random.randint(1, 2_000_000_000)
    meta = {"car_id": car.id, "owner_id": car.owner_id, "text": text,
            "request_id": request_id, "created": int(time.time()), "title": car.title}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    if calc_png:
        (d / "calc.png").write_bytes(calc_png)
    return request_id


def _load_pending(actor_id: int) -> tuple[dict, bytes | None] | None:
    d = _pending_dir(actor_id)
    try:
        meta = json.loads((d / "meta.json").read_text())
    except (OSError, ValueError):
        return None
    if time.time() - meta.get("created", 0) > PENDING_TTL:
        shutil.rmtree(d, ignore_errors=True)
        return None
    calc = d / "calc.png"
    return meta, (calc.read_bytes() if calc.is_file() else None)


def _pick_keyboard(request_id: int) -> str:
    return json.dumps({
        "keyboard": [
            [{"text": "👤 Выбрать клиента", "request_users": {
                "request_id": request_id, "user_is_bot": False,
                "max_quantity": 1, "request_name": True, "request_username": True,
            }}],
            [{"text": SELF_LABEL}, {"text": CANCEL_LABEL}],
        ],
        "resize_keyboard": True,
        "one_time_keyboard": True,
    }, ensure_ascii=False)


_REMOVE_KB = json.dumps({"remove_keyboard": True})


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

    calc_png = None
    if calc_image is not None:
        data = await calc_image.read(CALC_IMAGE_MAX_BYTES + 1)
        if len(data) > CALC_IMAGE_MAX_BYTES:
            raise HTTPException(status_code=400, detail="картинка расчёта слишком большая")
        if data:
            try:
                storage.probe(data)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            calc_png = data

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            if business_for(actor_id):
                request_id = _save_pending(actor_id, car, text, calc_png)
                await _tg_call(client, "sendMessage", {
                    "chat_id": str(actor_id),
                    "text": f"Кому отправить «{car.title or 'авто'}»? "
                            "Пост уйдёт клиенту от вашего имени.",
                    "reply_markup": _pick_keyboard(request_id),
                })
                return {"ok": True, "mode": "pick"}

            items = _car_items(car, calc_png)
            await _send_album(client, actor_id, items, text)
        except TelegramError as e:
            raise _http_error(e) from e

    return {"ok": True, "mode": "self", "photos": len(items),
            "caption_separate": bool(items) and _tg_len(text) > CAPTION_LIMIT}


# --- события от бота -------------------------------------------------------

async def _deliver(session: AsyncSession, actor_id: int, target: dict | None) -> None:
    """target=None — прислать пост самому себе (для пересылки вручную)."""
    pending = _load_pending(actor_id)
    async with httpx.AsyncClient(timeout=60) as client:
        if not pending:
            await _tg_call(client, "sendMessage", {
                "chat_id": str(actor_id), "reply_markup": _REMOVE_KB,
                "text": "Пост устарел — нажмите «📤 Пост» в карточке ещё раз.",
            })
            return
        meta, calc_png = pending
        car = (
            await session.execute(
                select(Car).where(Car.id == meta["car_id"], Car.owner_id == meta["owner_id"])
            )
        ).scalar_one_or_none()
        if not car:
            shutil.rmtree(_pending_dir(actor_id), ignore_errors=True)
            await _tg_call(client, "sendMessage", {
                "chat_id": str(actor_id), "reply_markup": _REMOVE_KB,
                "text": "Карточка удалена — отправлять нечего.",
            })
            return

        items = _car_items(car, calc_png)
        bc_id = business_for(actor_id)
        note = None
        if target and bc_id:
            name = target.get("first_name") or (
                "@" + target["username"] if target.get("username") else "клиенту")
            try:
                await _send_album(client, int(target["user_id"]), items, meta["text"], bc_id)
                note = f"✅ Отправлено: {name}"
            except TelegramError as e:
                # Чаще всего — переписки не было последние сутки, а писать от
                # имени аккаунта бот может только в недавно активные чаты.
                log.info("business send to %s failed: %s", target.get("user_id"), e.desc)
                if "to self" in e.desc or int(target["user_id"]) == actor_id:
                    note = "Себе от своего имени отправить нельзя — пост ниже."
                else:
                    note = (f"Не получилось отправить {name} от вашего имени "
                            f"({e.desc}). Обычно так бывает, если вы не переписывались "
                            "последние сутки. Пост ниже — перешлите его вручную.")
        if note is None or not note.startswith("✅"):
            await _send_album(client, actor_id, items, meta["text"])
        await _tg_call(client, "sendMessage", {
            "chat_id": str(actor_id), "reply_markup": _REMOVE_KB,
            "text": note or "Пост выше — перешлите его клиенту.",
        })
    shutil.rmtree(_pending_dir(actor_id), ignore_errors=True)


@router.post("/internal/tg")
async def internal_tg(
    event: dict,
    x_internal_token: str | None = Header(default=None),
    session: AsyncSession = Depends(get_session),
):
    if not WT_BOT_TOKEN or not hmac.compare_digest(x_internal_token or "", internal_token()):
        raise HTTPException(status_code=403, detail="forbidden")

    kind = event.get("kind")
    try:
        if kind == "business_connection":
            _save_business_connection(event["connection"])
            return {"ok": True}

        actor_id = int(event["actor_id"])
        if kind == "users_shared":
            pending = _load_pending(actor_id)
            if pending and int(event.get("request_id", -1)) != pending[0]["request_id"]:
                return {"ok": True, "ignored": "stale request"}
            users = event.get("users") or []
            await _deliver(session, actor_id, users[0] if users else None)
        elif kind == "send_self":
            await _deliver(session, actor_id, None)
        elif kind == "cancel":
            had = _load_pending(actor_id) is not None
            shutil.rmtree(_pending_dir(actor_id), ignore_errors=True)
            async with httpx.AsyncClient(timeout=30) as client:
                await _tg_call(client, "sendMessage", {
                    "chat_id": str(actor_id), "reply_markup": _REMOVE_KB,
                    "text": "Отправка отменена." if had else "Нечего отменять.",
                })
        else:
            raise HTTPException(status_code=400, detail="unknown event")
    except TelegramError as e:
        log.warning("internal %s: %s", kind, e.desc)
        return {"ok": False, "error": e.desc}
    return {"ok": True}

"""
security.py — проверка подписи Telegram initData + сессионные JWT.

Зеркало poster_saas/api/security.py, с двумя отличиями:
  1) HMAC считается по токену бота калькулятора (WT_BOT_TOKEN), а не PublioSMM;
  2) есть отдельные короткоживущие токены для отдачи картинок — тег <img>
     не умеет слать заголовок Authorization, поэтому доступ к фото идёт
     через подписанный параметр в query.
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

import jwt

from config import AUTH_MAX_AGE, JWT_TTL_DAYS, WT_BOT_TOKEN, WT_JWT_SECRET


def verify_webapp_initdata(init_data: str) -> dict | None:
    """
    Проверяет initData Mini App (сырая query-строка).
    Возвращает объект user из Telegram либо None.
    """
    if not WT_BOT_TOKEN or not init_data:
        return None
    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    # Свежесть: отклоняем строку старше суток — защита от повтора, если
    # initData утечёт в лог, HAR или прокси.
    auth_date = pairs.get("auth_date")
    try:
        if auth_date is None or time.time() - int(auth_date) > AUTH_MAX_AGE:
            return None
    except (TypeError, ValueError):
        return None

    data_check_string = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret_key = hmac.new(b"WebAppData", WT_BOT_TOKEN.encode(), hashlib.sha256).digest()
    calc = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc, received_hash):
        return None

    try:
        user = json.loads(pairs.get("user", "{}"))
        if not isinstance(user, dict) or "id" not in user:
            return None
        user["id"] = int(user["id"])
        return user
    except (TypeError, ValueError, json.JSONDecodeError):
        return None


def create_jwt(telegram_id: int) -> str:
    now = int(time.time())
    payload = {"sub": str(telegram_id), "iat": now, "exp": now + JWT_TTL_DAYS * 86400}
    return jwt.encode(payload, WT_JWT_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> int | None:
    try:
        payload = jwt.decode(token, WT_JWT_SECRET, algorithms=["HS256"])
        return int(payload["sub"])
    except Exception:
        return None


# --- подписанные ссылки на картинки ---------------------------------------
# <img src> не может нести заголовок Authorization, поэтому фото отдаётся по
# ссылке с отдельным узким токеном: он привязан к конкретному photo_id.
# Утечка такой ссылки не даёт доступа ни к чему другому.

# 6 часов, а не час: список держит ссылки в памяти, и при перерисовке
# (смена фильтра, отметка карточки) старый токен уже был бы просрочен.
_PHOTO_TTL = 6 * 3600


def photo_token(photo_id: int, telegram_id: int, ttl: int = _PHOTO_TTL) -> str:
    now = int(time.time())
    payload = {
        "sub": str(telegram_id),
        "pid": int(photo_id),
        "scope": "photo",
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, WT_JWT_SECRET, algorithm="HS256")


def verify_photo_token(token: str, photo_id: int) -> int | None:
    """Возвращает telegram_id, если токен валиден и выдан именно на это фото."""
    try:
        payload = jwt.decode(token, WT_JWT_SECRET, algorithms=["HS256"])
        if payload.get("scope") != "photo" or int(payload.get("pid", -1)) != int(photo_id):
            return None
        return int(payload["sub"])
    except Exception:
        return None

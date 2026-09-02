"""
config.py — переменные окружения сервиса wtcars.

Читается из server/wtcars/.env (см. .env.example). Секреты в репозиторий
не попадают: .env в .gitignore, как и в остальных проектах.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def _list(name: str) -> list[str]:
    return [x.strip() for x in (os.getenv(name, "") or "").split(",") if x.strip()]


# --- база ---
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./wtcars.db")

# --- Telegram: бот калькулятора (@wt_car_calc_bot) ---
# По его токену проверяется подпись initData из Mini App.
WT_BOT_TOKEN = os.getenv("WT_BOT_TOKEN", "")

# --- JWT сессии Mini App ---
WT_JWT_SECRET = os.getenv("WT_JWT_SECRET", "")
JWT_TTL_DAYS = _int("JWT_TTL_DAYS", 30)

# Максимальный возраст initData, сек. Telegram рекомендует сутки —
# защита от повторного использования утёкшей строки.
AUTH_MAX_AGE = _int("AUTH_MAX_AGE", 86400)

# --- кто вообще имеет доступ ---
# Пустой список = пускаем любого прошедшего проверку подписи (режим одного
# пользователя на старте). Заполненный — белый список telegram_id.
OWNER_TELEGRAM_IDS = [int(x) for x in _list("OWNER_TELEGRAM_IDS")]

# --- CORS: откуда открывается Mini App ---
ALLOWED_ORIGINS = _list("ALLOWED_ORIGINS") or [
    "https://dmitriisavitskii1993.github.io",
]

# --- файловое хранилище ---
STORAGE_DIR = Path(os.getenv("STORAGE_DIR", "/var/lib/wtcars"))
PHOTOS_DIR = STORAGE_DIR / "photos"
KP_DIR = STORAGE_DIR / "kp"

MAX_PHOTO_BYTES = _int("MAX_PHOTO_BYTES", 15 * 1024 * 1024)
MAX_PHOTOS_PER_CAR = _int("MAX_PHOTOS_PER_CAR", 20)
# Длинная сторона, до которой ужимаем перед отправкой в модель.
# 1568 px — предел, выше которого Anthropic всё равно масштабирует сам.
AI_IMAGE_MAX_EDGE = _int("AI_IMAGE_MAX_EDGE", 1568)

# --- Anthropic ---
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
AI_MODEL = os.getenv("AI_MODEL", "claude-opus-5")
# Обогащение с drom.ru — по умолчанию выключено (см. риск 1 в плане:
# ГК ст. 1334/1335.1 + стоимость $0.075 за авто).
DROM_ENRICH = (os.getenv("DROM_ENRICH", "off") or "off").lower() in ("1", "on", "true", "yes")

# --- PublioSMM (публикация в соцсети) ---
PUBLIO_API_BASE = os.getenv("PUBLIO_API_BASE", "http://127.0.0.1:8081/api")
PUBLIO_SERVICE_TOKEN = os.getenv("PUBLIO_SERVICE_TOKEN", "")

DEBUG = (os.getenv("DEBUG", "off") or "off").lower() in ("1", "on", "true", "yes")

"""
storage.py — фотографии на диске.

Файлы лежат в /var/lib/wtcars/photos/<car_id>/<sha>.<ext>. В базе — путь,
sha256 и размеры. sha256 даёт бесплатную дедупликацию: один и тот же скрин,
залитый дважды, не создаёт вторую строку (UNIQUE (car_id, sha256)).

Pillow используется в двух местах: узнать размеры и ужать копию для модели.
Оригинал не трогаем — он идёт в публикацию и в КП.
"""
import hashlib
import io
import shutil
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from config import AI_IMAGE_MAX_EDGE, PHOTOS_DIR, STORAGE_DIR

TMP_DIR = STORAGE_DIR / "tmp"

_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

# Pillow по умолчанию отказывается открывать «бомбы» (>178 Мпикс). Оставляем
# защиту включённой, но поднимаем порог до разумного для фото с телефона.
Image.MAX_IMAGE_PIXELS = 80_000_000


def ensure_dirs() -> None:
    for d in (PHOTOS_DIR, TMP_DIR, STORAGE_DIR / "kp"):
        d.mkdir(parents=True, exist_ok=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def probe(data: bytes) -> tuple[str, int, int]:
    """(mime, width, height). Кидает ValueError, если это не картинка."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            fmt = (im.format or "").upper()
            mime = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}.get(fmt)
            if not mime:
                raise ValueError(f"неподдерживаемый формат: {fmt or 'unknown'}")
            return mime, im.width, im.height
    except ValueError:
        raise
    except Exception as e:  # повреждённый файл, обрезанный upload и т.п.
        raise ValueError(f"не удалось прочитать изображение: {e}") from e


def save_photo(car_id: int, data: bytes, mime: str) -> Path:
    """Кладёт файл и возвращает путь. Имя = sha256, поэтому повтор идемпотентен."""
    d = PHOTOS_DIR / str(car_id)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sha256_bytes(data)}{_EXT_BY_MIME.get(mime, '.bin')}"
    if not path.exists():
        path.write_bytes(data)
    return path


def delete_car_dir(car_id: int) -> None:
    shutil.rmtree(PHOTOS_DIR / str(car_id), ignore_errors=True)


def to_ai_jpeg(data: bytes, max_edge: int = AI_IMAGE_MAX_EDGE) -> bytes:
    """
    Копия для модели: EXIF-поворот применён, длинная сторона ≤ max_edge, JPEG q85.
    Выше 1568 px Anthropic всё равно масштабирует сам — платить за лишние
    пиксели токенами смысла нет.
    """
    with Image.open(io.BytesIO(data)) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        if max(im.size) > max_edge:
            im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue()


# --- временное хранилище распознавания ----------------------------------
# /wtapi/extract карточку не создаёт, поэтому скрин ждёт в tmp/<id>/ до
# момента сохранения авто. Всё, что старше суток, подчищается.


def tmp_dir(extraction_id: str) -> Path:
    # uuid4 из наших рук, но путь всё равно собираем строго — никакого ../
    safe = uuid.UUID(str(extraction_id))
    d = TMP_DIR / str(safe)
    d.mkdir(parents=True, exist_ok=True)
    return d


def cleanup_tmp(max_age_sec: int = 86400) -> int:
    import time

    if not TMP_DIR.exists():
        return 0
    now = time.time()
    removed = 0
    for d in TMP_DIR.iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > max_age_sec:
                shutil.rmtree(d, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed

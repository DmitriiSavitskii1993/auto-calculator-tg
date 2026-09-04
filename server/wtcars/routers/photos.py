"""
photos.py — загрузка, отдача и удаление фотографий карточки.

Отдача идёт по подписанной ссылке, а не по Bearer: тег <img> не умеет слать
заголовок Authorization. Токен привязан к конкретному photo_id и живёт час.
"""
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import MAX_PHOTO_BYTES, MAX_PHOTOS_PER_CAR
from database import get_session
from deps import get_current_owner
from models import Car, CarPhoto, Owner
from schemas import PhotoOut
from security import photo_token, verify_photo_token
from services import storage

router = APIRouter(tags=["photos"])


@router.post("/cars/{car_id}/photos", response_model=list[PhotoOut])
async def upload_photos(
    car_id: int,
    files: list[UploadFile] = File(...),
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    car = (
        await session.execute(select(Car).where(Car.id == car_id, Car.owner_id == owner.id))
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="car not found")

    existing = (
        await session.execute(
            select(func.count()).select_from(CarPhoto).where(CarPhoto.car_id == car_id)
        )
    ).scalar_one()
    if existing + len(files) > MAX_PHOTOS_PER_CAR:
        raise HTTPException(
            status_code=400,
            detail=f"максимум {MAX_PHOTOS_PER_CAR} фото на авто (сейчас {existing})",
        )

    next_pos = (
        await session.execute(
            select(func.coalesce(func.max(CarPhoto.position), -1)).where(CarPhoto.car_id == car_id)
        )
    ).scalar_one() + 1

    out: list[CarPhoto] = []
    for f in files:
        data = await f.read()
        if not data:
            continue
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"{f.filename}: больше {MAX_PHOTO_BYTES // (1024 * 1024)} МБ",
            )
        try:
            mime, w, h = storage.probe(data)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"{f.filename}: {e}") from e

        sha = storage.sha256_bytes(data)
        dup = (
            await session.execute(
                select(CarPhoto).where(CarPhoto.car_id == car_id, CarPhoto.sha256 == sha)
            )
        ).scalar_one_or_none()
        if dup:                      # тот же файл уже загружен — не плодим строки
            out.append(dup)
            continue

        path = storage.save_photo(car_id, data, mime)
        photo = CarPhoto(
            car_id=car_id, position=next_pos, kind="gallery",
            storage_path=str(path), sha256=sha, mime=mime,
            width=w, height=h, bytes=len(data),
        )
        session.add(photo)
        next_pos += 1
        out.append(photo)

    await session.commit()
    for p in out:
        await session.refresh(p)

    return [
        PhotoOut(
            id=p.id, position=p.position, kind=p.kind,
            width=p.width, height=p.height, bytes=p.bytes,
            url=f"/wtapi/photos/{p.id}?t={photo_token(p.id, owner.telegram_id)}",
        )
        for p in out
    ]


@router.get("/photos/{photo_id}")
async def get_photo(
    photo_id: int,
    t: str = Query(..., description="подписанный токен на это фото"),
    w: int | None = Query(default=None, ge=64, le=1600,
                          description="ширина миниатюры; без него — оригинал"),
    download: int = Query(default=0,
                          description="1 — отдать как файл на скачивание, а не для показа"),
    session: AsyncSession = Depends(get_session),
):
    telegram_id = verify_photo_token(t, photo_id)
    if telegram_id is None:
        raise HTTPException(status_code=403, detail="bad token")

    row = (
        await session.execute(
            select(CarPhoto, Owner.telegram_id)
            .join(Car, Car.id == CarPhoto.car_id)
            .join(Owner, Owner.id == Car.owner_id)
            .where(CarPhoto.id == photo_id)
        )
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="photo not found")

    photo, owner_tg = row
    if owner_tg != telegram_id:          # токен подписан не тем, кому принадлежит фото
        raise HTTPException(status_code=403, detail="forbidden")

    path = Path(photo.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="file is gone")

    media = photo.mime or "application/octet-stream"
    if w:
        thumb = storage.thumb_for(path, w)
        if thumb != path:
            path, media = thumb, "image/jpeg"

    headers = {"Cache-Control": "private, max-age=3600"}
    if download:
        # Осмысленное имя файла: photo_7.png понятнее, чем 64 знака sha256,
        # когда снимок уже лежит в загрузках среди других.
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(media, "bin")
        headers["Content-Disposition"] = f'attachment; filename="wt_photo_{photo.id}.{ext}"'

    return FileResponse(path, media_type=media, headers=headers)


@router.delete("/cars/{car_id}/photos/{photo_id}")
async def delete_photo(
    car_id: int,
    photo_id: int,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    row = (
        await session.execute(
            select(CarPhoto).join(Car, Car.id == CarPhoto.car_id)
            .where(CarPhoto.id == photo_id, CarPhoto.car_id == car_id, Car.owner_id == owner.id)
        )
    ).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="photo not found")

    path = Path(row.storage_path)
    await session.delete(row)
    await session.commit()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
    return {"ok": True}

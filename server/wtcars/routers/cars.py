"""
cars.py — карточки авто: создание из расчёта, фильтр, правка, удаление.

Расчёт приходит с клиента целиком (calculate() живёт в js/calc.js и здесь не
дублируется). Наша работа — разложить его результат по индексируемым колонкам,
чтобы фильтры подборок были обычным SQL, а не пересчётом на лету.
"""
import shutil
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from deps import get_current_owner
from models import Car, CarPhoto, Owner, RateSnapshot
from schemas import (
    CarCreate, CarDetailOut, CarListOut, CarOut, CarRecalc, CarUpdate, PhotoOut, VehicleIn,
)
from security import photo_token
from services import storage

router = APIRouter(prefix="/cars", tags=["cars"])

SORTABLE = {
    "created_at": Car.created_at,
    "price": Car.price_rub_total,
    "year": Car.year,
    "mileage": Car.mileage_km,
    "power": Car.power_hp,
}


def _int_or_none(v) -> int | None:
    """Деньги из JS приходят float — округляем до рубля, None остаётся None."""
    if v is None:
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _build_title(v: VehicleIn) -> str | None:
    parts = [p for p in (v.make, v.model, v.trim) if p]
    if not parts:
        return None
    title = " ".join(parts)
    if v.year:
        title += f" {v.year}"
    return title[:255]


def _apply_calc(car: Car, payload: CarCreate) -> None:
    """Раскладывает calc_input/calc_result по колонкам карточки."""
    ci = payload.calc_input or {}
    cr = payload.calc_result or {}
    # В результате input уже нормализован (кВт↔л.с., объём) — берём оттуда.
    ri = cr.get("input") or ci

    car.calc_input = ci
    car.calc_result = cr

    car.country = (ri.get("country") or ci.get("country") or "jp")[:2]
    car.is_electric = bool(ri.get("isElectric"))
    car.sanctioned = bool(ri.get("sanctioned"))
    car.age_band = (ri.get("age") or None)
    car.volume_cc = _int_or_none(ri.get("volumeCc"))
    car.power_hp = _int_or_none(ri.get("powerHp"))
    car.power_kw = _int_or_none(ri.get("powerKw"))

    car.price_rub_total = _int_or_none(cr.get("grandTotal"))
    car.util_fee = _int_or_none(cr.get("utilFee"))
    car.util_preferential = (
        bool(cr["utilPreferentialApplied"])
        if cr.get("utilPreferentialApplied") is not None else None
    )
    car.util_threshold_hp = _int_or_none(cr.get("utilThresholdHp"))
    car.duty = _int_or_none(cr.get("duty"))
    car.customs_total = _int_or_none(cr.get("customsTotal"))
    car.commission = _int_or_none(cr.get("commission"))
    car.commission_individual = (
        bool(cr["commissionIndividual"])
        if cr.get("commissionIndividual") is not None else None
    )
    car.logistics_rf = _int_or_none(cr.get("logistics"))
    car.logistics_city = (cr.get("logisticsCity") or None)


def _apply_vehicle(car: Car, v: VehicleIn) -> None:
    for field in (
        "make", "model", "trim", "generation", "year", "month", "mileage_km",
        "body", "drive", "transmission", "fuel", "color", "doors", "seats",
        "auction_grade", "interior_grade", "auction_name", "auction_date",
        "lot_number", "vin", "plate_no", "source_type", "source_url",
        "drom_url", "currency", "notes", "description_ru",
    ):
        val = getattr(v, field)
        if val is not None:
            setattr(car, field, val)
    if v.price_foreign is not None:
        car.price_foreign = v.price_foreign
    car.title = v.title or _build_title(v) or car.title


def _photos_out(car: Car, telegram_id: int) -> list[PhotoOut]:
    return [
        PhotoOut(
            id=p.id, position=p.position, kind=p.kind,
            width=p.width, height=p.height, bytes=p.bytes,
            url=f"/wtapi/photos/{p.id}?t={photo_token(p.id, telegram_id)}",
        )
        for p in car.photos
    ]


def _car_out(car: Car, owner: Owner, detailed: bool = False):
    cls = CarDetailOut if detailed else CarOut
    data = {
        c.name: getattr(car, c.name)
        for c in Car.__table__.columns
        if c.name in cls.model_fields
    }
    if car.price_foreign is not None:
        data["price_foreign"] = float(car.price_foreign)
    data["photos"] = _photos_out(car, owner.telegram_id)
    return cls(**data)


@router.post("", response_model=CarDetailOut, status_code=201)
async def create_car(
    payload: CarCreate,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    snap = RateSnapshot(
        cbr=payload.rates.cbr,
        market=payload.rates.market,
        cbr_date=payload.rates.cbr_date,
        calc_version=payload.rates.calc_version,
    )
    session.add(snap)
    await session.flush()

    car = Car(
        owner_id=owner.id,
        status=payload.status or "active",
        rates_snapshot=payload.rates.model_dump(mode="json"),
        rate_snapshot_id=snap.id,
        specs=payload.specs,
        extraction=payload.extraction,
        calc_input={}, calc_result={}, country="jp",
    )
    _apply_calc(car, payload)
    _apply_vehicle(car, payload.vehicle)
    session.add(car)
    await session.flush()

    # Скрин, по которому распознавали, ждал в tmp — переносим в карточку.
    if payload.extraction_id:
        await _adopt_extraction_photo(session, car, payload.extraction_id)

    await session.commit()
    await session.refresh(car)
    return _car_out(car, owner, detailed=True)


async def _adopt_extraction_photo(session: AsyncSession, car: Car, extraction_id: str) -> None:
    try:
        src_dir = storage.tmp_dir(extraction_id)
    except (ValueError, AttributeError):
        return
    for src in sorted(src_dir.glob("source.*")):
        try:
            data = src.read_bytes()
            mime, w, h = storage.probe(data)
        except (OSError, ValueError):
            continue
        path = storage.save_photo(car.id, data, mime)
        session.add(CarPhoto(
            car_id=car.id, position=0, kind="source_screenshot",
            storage_path=str(path), sha256=storage.sha256_bytes(data),
            mime=mime, width=w, height=h, bytes=len(data),
        ))
        break
    shutil.rmtree(src_dir, ignore_errors=True)


@router.get("", response_model=CarListOut)
async def list_cars(
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
    status: str | None = Query(default="active"),
    country: str | None = None,
    price_min: int | None = None,
    price_max: int | None = None,
    util_pref: bool | None = Query(default=None, description="только льготный утильсбор"),
    year_min: int | None = None,
    year_max: int | None = None,
    mileage_max: int | None = None,
    power_max: int | None = None,
    body: str | None = None,
    drive: str | None = None,
    transmission: str | None = None,
    is_electric: bool | None = None,
    q: str | None = None,
    sort: str = Query(default="created_at"),
    order: str = Query(default="desc", pattern="^(asc|desc)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    conds = [Car.owner_id == owner.id]
    if status and status != "all":
        conds.append(Car.status == status)
    if country:
        conds.append(Car.country.in_([c.strip() for c in country.split(",") if c.strip()]))
    if price_min is not None:
        conds.append(Car.price_rub_total >= price_min)
    if price_max is not None:
        conds.append(Car.price_rub_total <= price_max)
    if util_pref is not None:
        conds.append(Car.util_preferential.is_(util_pref))
    if year_min is not None:
        conds.append(Car.year >= year_min)
    if year_max is not None:
        conds.append(Car.year <= year_max)
    if mileage_max is not None:
        conds.append(Car.mileage_km <= mileage_max)
    if power_max is not None:
        conds.append(Car.power_hp <= power_max)
    if body:
        conds.append(Car.body.in_([b.strip() for b in body.split(",") if b.strip()]))
    if drive:
        conds.append(Car.drive.in_([d.strip() for d in drive.split(",") if d.strip()]))
    if transmission:
        conds.append(Car.transmission.in_([t.strip() for t in transmission.split(",") if t.strip()]))
    if is_electric is not None:
        conds.append(Car.is_electric.is_(is_electric))
    if q:
        like = f"%{q.strip()}%"
        conds.append(
            func.coalesce(Car.title, "").ilike(like)
            | func.coalesce(Car.make, "").ilike(like)
            | func.coalesce(Car.model, "").ilike(like)
            | func.coalesce(Car.lot_number, "").ilike(like)
        )

    total = (
        await session.execute(select(func.count()).select_from(Car).where(*conds))
    ).scalar_one()

    col = SORTABLE.get(sort, Car.created_at)
    # NULL по цене/году не должны всплывать наверх и мешать читать список
    ordering = col.desc().nullslast() if order == "desc" else col.asc().nullslast()

    rows = (
        await session.execute(
            select(Car).where(*conds).order_by(ordering, Car.id.desc())
            .limit(limit).offset(offset)
        )
    ).scalars().all()

    return CarListOut(
        items=[_car_out(c, owner) for c in rows],
        total=total, limit=limit, offset=offset,
    )


async def _get_owned_car(session: AsyncSession, owner: Owner, car_id: int) -> Car:
    car = (
        await session.execute(
            select(Car).where(Car.id == car_id, Car.owner_id == owner.id)
        )
    ).scalar_one_or_none()
    if not car:
        raise HTTPException(status_code=404, detail="car not found")
    return car


@router.get("/{car_id}", response_model=CarDetailOut)
async def get_car(
    car_id: int,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    return _car_out(await _get_owned_car(session, owner, car_id), owner, detailed=True)


@router.patch("/{car_id}", response_model=CarDetailOut)
async def update_car(
    car_id: int,
    payload: CarUpdate,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    car = await _get_owned_car(session, owner, car_id)
    if payload.vehicle is not None:
        _apply_vehicle(car, payload.vehicle)
    if payload.status is not None:
        car.status = payload.status
    if payload.description_ru is not None:
        car.description_ru = payload.description_ru
    if payload.notes is not None:
        car.notes = payload.notes
    car.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(car)
    return _car_out(car, owner, detailed=True)


@router.post("/{car_id}/recalc", response_model=CarDetailOut)
async def recalc_car(
    car_id: int,
    payload: CarRecalc,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    """
    Обновляет рублёвые суммы карточки по свежим курсам.

    Цена в валюте (price_foreign/currency) — то, что зафиксировано сделкой,
    и не трогается. Меняются только производные от курса величины и снимок
    курсов, по которому они получены.
    """
    car = await _get_owned_car(session, owner, car_id)

    snap = RateSnapshot(
        cbr=payload.rates.cbr,
        market=payload.rates.market,
        cbr_date=payload.rates.cbr_date,
        calc_version=payload.rates.calc_version,
    )
    session.add(snap)
    await session.flush()

    # _apply_calc ждёт объект с calc_input/calc_result — исходные данные
    # берём из карточки, они не меняются
    _apply_calc(car, CarCreate(
        vehicle=VehicleIn(),
        calc_input=car.calc_input,
        calc_result=payload.calc_result,
        rates=payload.rates,
    ))
    car.rates_snapshot = payload.rates.model_dump(mode="json")
    car.rate_snapshot_id = snap.id
    car.updated_at = datetime.utcnow()

    await session.commit()
    await session.refresh(car)
    return _car_out(car, owner, detailed=True)


@router.delete("/{car_id}")
async def delete_car(
    car_id: int,
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    car = await _get_owned_car(session, owner, car_id)
    await session.delete(car)
    await session.commit()
    storage.delete_car_dir(car_id)
    return {"ok": True}

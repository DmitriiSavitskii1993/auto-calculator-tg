"""
models.py — схема базы wtcars.

Принцип: calculate() из js/calc.js остаётся на клиенте и НЕ переписывается
на Python. Mini App присылает input + весь результат + снимок курсов;
фильтруемые скаляры денормализуются в индексированные колонки, остальное
живёт в JSONB. Так фильтр «до 160 л.с.» — скан булева поля, а не пересчёт.

Все DateTime — наивный UTC (как в poster_saas: tz-aware падали на Postgres).
"""
from datetime import datetime

from sqlalchemy import (
    JSON, BigInteger, Boolean, Date, DateTime, ForeignKey, Index, Integer,
    Numeric, SmallInteger, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# JSONB на Postgres, обычный JSON на SQLite (локальная разработка).
JSONType = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.utcnow()


class Owner(Base):
    """Пользователь базы. Сейчас один — владелец, но ключ арендатора заложен."""
    __tablename__ = "owners"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16), default="owner", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)


class RateSnapshot(Base):
    """
    Курсы на момент расчёта. Без этого старая карточка через полгода
    необъяснима: непонятно, по какому курсу получился её «под ключ».
    """
    __tablename__ = "rate_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
    cbr_date: Mapped[str | None] = mapped_column(String(32))       # data.Date из cbr-xml-daily.ru
    cbr: Mapped[dict] = mapped_column(JSONType, nullable=False)     # {USD,EUR,JPY,KRW,CNY} за 1 ед.
    market: Mapped[dict] = mapped_column(JSONType, nullable=False)  # {JPY100_ATB,CNY,KRW1000,USD}
    calc_version: Mapped[str | None] = mapped_column(String(64))    # sha data.js/calc.js


class Car(Base):
    __tablename__ = "cars"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owners.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now, nullable=False
    )

    # --- источник ---
    source_type: Mapped[str | None] = mapped_column(String(32))  # jp_auction_sheet|kr_listing|manual
    source_url: Mapped[str | None] = mapped_column(Text)
    drom_url: Mapped[str | None] = mapped_column(Text)
    lot_number: Mapped[str | None] = mapped_column(String(64))
    auction_name: Mapped[str | None] = mapped_column(String(128))
    auction_date: Mapped[datetime | None] = mapped_column(Date)

    # --- фильтруемое: техника ---
    country: Mapped[str] = mapped_column(String(2), nullable=False)     # jp|kr|cn
    make: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(96))
    trim: Mapped[str | None] = mapped_column(String(128))
    generation: Mapped[str | None] = mapped_column(String(96))
    title: Mapped[str | None] = mapped_column(String(255))              # «Toyota Prado 2021»
    year: Mapped[int | None] = mapped_column(SmallInteger)
    month: Mapped[int | None] = mapped_column(SmallInteger)
    mileage_km: Mapped[int | None] = mapped_column(Integer)
    body: Mapped[str | None] = mapped_column(String(24))
    drive: Mapped[str | None] = mapped_column(String(8))                # FWD|RWD|AWD|4WD
    transmission: Mapped[str | None] = mapped_column(String(8))         # AT|MT|CVT|DCT|AMT
    volume_cc: Mapped[int | None] = mapped_column(Integer)
    power_hp: Mapped[int | None] = mapped_column(SmallInteger)
    power_kw: Mapped[int | None] = mapped_column(SmallInteger)
    is_electric: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    age_band: Mapped[str | None] = mapped_column(String(8))             # то, что ушло в #age
    sanctioned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # --- хранится, но без UI-фильтра в v1 ---
    fuel: Mapped[str | None] = mapped_column(String(16))
    auction_grade: Mapped[str | None] = mapped_column(String(8))        # 4, 4.5, R, RA, S
    interior_grade: Mapped[str | None] = mapped_column(String(4))       # A|B|C
    color: Mapped[str | None] = mapped_column(String(48))
    doors: Mapped[int | None] = mapped_column(SmallInteger)
    seats: Mapped[int | None] = mapped_column(SmallInteger)
    vin: Mapped[str | None] = mapped_column(String(32))
    plate_no: Mapped[str | None] = mapped_column(String(32))

    # --- фильтруемое: деньги ---
    price_foreign: Mapped[float | None] = mapped_column(Numeric(14, 2))
    currency: Mapped[str | None] = mapped_column(String(3))             # JPY|KRW|CNY
    price_rub_total: Mapped[int | None] = mapped_column(BigInteger)     # = result.grandTotal
    util_fee: Mapped[int | None] = mapped_column(BigInteger)
    util_preferential: Mapped[bool | None] = mapped_column(Boolean)     # ≤160 л.с. / ≤80 кВт
    util_threshold_hp: Mapped[int | None] = mapped_column(SmallInteger)
    duty: Mapped[int | None] = mapped_column(BigInteger)
    customs_total: Mapped[int | None] = mapped_column(BigInteger)
    commission: Mapped[int | None] = mapped_column(BigInteger)
    commission_individual: Mapped[bool | None] = mapped_column(Boolean)
    logistics_rf: Mapped[int | None] = mapped_column(BigInteger)
    logistics_city: Mapped[str | None] = mapped_column(String(96))

    # --- снимки ---
    calc_input: Mapped[dict] = mapped_column(JSONType, nullable=False)   # объект input в calculate()
    calc_result: Mapped[dict] = mapped_column(JSONType, nullable=False)  # весь результат
    rates_snapshot: Mapped[dict] = mapped_column(JSONType, nullable=False)
    rate_snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("rate_snapshots.id"))
    specs: Mapped[dict | None] = mapped_column(JSONType)                 # обогащение с drom
    extraction: Mapped[dict | None] = mapped_column(JSONType)            # сырой вывод ИИ + confidence

    description_ru: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    photos: Mapped[list["CarPhoto"]] = relationship(
        back_populates="car", cascade="all, delete-orphan",
        order_by="CarPhoto.position", lazy="selectin",
    )

    __table_args__ = (
        Index("ix_cars_owner_status", "owner_id", "status"),
        Index("ix_cars_price", "owner_id", "status", "price_rub_total"),
        Index("ix_cars_year", "owner_id", "status", "year"),
        Index("ix_cars_mileage", "owner_id", "status", "mileage_km"),
        Index("ix_cars_power", "owner_id", "status", "power_hp"),
        Index("ix_cars_utilpref", "owner_id", "status", "util_preferential"),
        Index("ix_cars_body_drive_tr", "owner_id", "status", "body", "drive", "transmission"),
        Index("ix_cars_country", "owner_id", "status", "country"),
    )


class CarPhoto(Base):
    __tablename__ = "car_photos"

    id: Mapped[int] = mapped_column(primary_key=True)
    car_id: Mapped[int] = mapped_column(
        ForeignKey("cars.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(SmallInteger, default=0, nullable=False)
    kind: Mapped[str] = mapped_column(String(24), default="gallery", nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    mime: Mapped[str | None] = mapped_column(String(32))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    bytes: Mapped[int | None] = mapped_column(Integer)

    # file_id, ВЫПУЩЕННЫЙ ботом PublioSMM. file_id привязан к боту: строка от
    # бота WT в VK/MAX падает молча (см. §6 плана), поэтому кэшируем именно
    # publio-версию и переиспользуем при повторной публикации.
    publio_file_id: Mapped[str | None] = mapped_column(Text)
    publio_file_id_at: Mapped[datetime | None] = mapped_column(DateTime)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

    car: Mapped["Car"] = relationship(back_populates="photos")

    __table_args__ = (
        UniqueConstraint("car_id", "sha256", name="uq_car_photo_sha"),
        Index("ix_photos_car", "car_id", "position"),
    )


class AiCall(Base):
    """Учёт вызовов модели: сколько стоило и что сломалось."""
    __tablename__ = "ai_calls"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("owners.id"))
    car_id: Mapped[int | None] = mapped_column(ForeignKey("cars.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # extract|enrich|describe|selection_text
    model: Mapped[str] = mapped_column(String(64), nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer)
    cost_usd: Mapped[float | None] = mapped_column(Numeric(10, 6))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    ok: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

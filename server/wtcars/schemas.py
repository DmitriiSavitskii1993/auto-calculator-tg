"""schemas.py — Pydantic-модели запросов и ответов."""
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# --- auth ---------------------------------------------------------------


class AuthIn(BaseModel):
    init_data: str


class AuthOut(BaseModel):
    token: str
    owner_id: int
    telegram_id: int
    username: str | None = None
    first_name: str | None = None


# --- курсы --------------------------------------------------------------


class RatesIn(BaseModel):
    """Снимок курсов с клиента: cfg.rates + дата кэша ЦБ."""
    cbr: dict[str, float]
    market: dict[str, float]
    cbr_date: str | None = None
    calc_version: str | None = None


# --- характеристики авто ------------------------------------------------

Body = Literal[
    "sedan", "suv", "wagon", "hatchback", "coupe",
    "minivan", "pickup", "van", "convertible", "other",
]
Drive = Literal["FWD", "RWD", "AWD", "4WD"]
Transmission = Literal["AT", "MT", "CVT", "DCT", "AMT", "other"]
Fuel = Literal["petrol", "diesel", "hybrid", "phev", "ev", "lpg", "other"]


class VehicleIn(BaseModel):
    """Что описывает саму машину — то, чего нет в input калькулятора."""
    make: str | None = None
    model: str | None = None
    trim: str | None = None
    generation: str | None = None
    title: str | None = None
    year: int | None = Field(default=None, ge=1950, le=2100)
    month: int | None = Field(default=None, ge=1, le=12)
    mileage_km: int | None = Field(default=None, ge=0, le=2_000_000)
    body: Body | None = None
    drive: Drive | None = None
    transmission: Transmission | None = None
    fuel: Fuel | None = None
    color: str | None = None
    doors: int | None = Field(default=None, ge=1, le=8)
    seats: int | None = Field(default=None, ge=1, le=30)
    auction_grade: str | None = None
    interior_grade: str | None = None
    auction_name: str | None = None
    auction_date: date | None = None
    lot_number: str | None = None
    vin: str | None = None
    plate_no: str | None = None
    source_type: str | None = None
    source_url: str | None = None
    drom_url: str | None = None
    price_foreign: float | None = None
    currency: str | None = None
    notes: str | None = None
    description_ru: str | None = None


class CarCreate(BaseModel):
    vehicle: VehicleIn = Field(default_factory=VehicleIn)
    calc_input: dict[str, Any]
    calc_result: dict[str, Any]
    rates: RatesIn
    extraction_id: str | None = None
    specs: dict[str, Any] | None = None
    extraction: dict[str, Any] | None = None
    status: str = "active"


class CarUpdate(BaseModel):
    """Частичное обновление. Пересчёт не трогаем — для него отдельный путь."""
    model_config = ConfigDict(extra="forbid")

    vehicle: VehicleIn | None = None
    status: Literal["draft", "active", "reserved", "sold", "archived"] | None = None
    description_ru: str | None = None
    notes: str | None = None


class CarRecalc(BaseModel):
    """
    Пересчёт карточки по новым курсам. Расчёт делает клиент тем же
    calculate() из calc.js — сюда приходит готовый результат и снимок
    курсов, по которым он получен. calc_input не меняется: это те же
    исходные данные авто, меняются только курсы.
    """
    calc_result: dict[str, Any]
    rates: RatesIn


class PhotoOut(BaseModel):
    id: int
    position: int
    kind: str
    width: int | None = None
    height: int | None = None
    bytes: int | None = None
    url: str


class CarOut(BaseModel):
    id: int
    status: str
    created_at: datetime
    updated_at: datetime

    country: str
    make: str | None = None
    model: str | None = None
    trim: str | None = None
    title: str | None = None
    year: int | None = None
    month: int | None = None
    mileage_km: int | None = None
    body: str | None = None
    drive: str | None = None
    transmission: str | None = None
    fuel: str | None = None
    volume_cc: int | None = None
    power_hp: int | None = None
    power_kw: int | None = None
    is_electric: bool
    age_band: str | None = None
    sanctioned: bool

    auction_grade: str | None = None
    auction_name: str | None = None
    lot_number: str | None = None
    color: str | None = None

    price_foreign: float | None = None
    currency: str | None = None
    # валютные суммы до перевода в рубли — по ним карточка пересчитывается точно
    delivery_foreign: float | None = None
    foreign_total: float | None = None
    duty_eur: float | None = None
    duty_eur_per_cc: float | None = None
    customs_value_eur: float | None = None
    excise_units: float | None = None
    price_rub_total: int | None = None
    util_fee: int | None = None
    util_preferential: bool | None = None
    util_threshold_hp: int | None = None
    duty: int | None = None
    customs_total: int | None = None
    commission: int | None = None
    commission_individual: bool | None = None
    logistics_rf: int | None = None
    logistics_city: str | None = None

    description_ru: str | None = None
    notes: str | None = None
    drom_url: str | None = None
    source_url: str | None = None

    rates_snapshot: dict[str, Any] | None = None
    photos: list[PhotoOut] = Field(default_factory=list)


class CarDetailOut(CarOut):
    calc_input: dict[str, Any]
    calc_result: dict[str, Any]
    specs: dict[str, Any] | None = None
    extraction: dict[str, Any] | None = None


class CarListOut(BaseModel):
    items: list[CarOut]
    total: int
    limit: int
    offset: int


# --- распознавание скрина -------------------------------------------------


class ExtractOut(BaseModel):
    extraction_id: str
    fields: dict[str, Any]
    confidence: dict[str, float]
    warnings: list[str]
    specs: dict[str, Any] | None = None

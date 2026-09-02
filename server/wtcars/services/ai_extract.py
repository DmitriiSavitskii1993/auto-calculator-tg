"""
ai_extract.py — распознавание характеристик авто со скриншота (аукционный
лист / карточка Encar) через Claude.

Один вызов, structured output через client.beta.messages.parse(output_format=
CarExtraction) — SDK сам собирает JSON-схему из модели и валидирует ответ
(anthropic==1.2.0, сигнатура beta.messages.parse проверена интроспекцией).
Системный промпт держим ≥2048 токенов и кэшируем — иначе кэш префикса
молча не включится (см. AI_IMAGE_MAX_EDGE в config.py и §4a плана).
"""
import base64
import logging
import time
from typing import Literal, Optional

from pydantic import BaseModel, Field

from services.ai_client import BETAS, FALLBACKS, MAX_TOKENS, Usage, get_client, model_name, usage_from

log = logging.getLogger("wtcars.ai")

Body = Literal[
    "sedan", "suv", "wagon", "hatchback", "coupe",
    "minivan", "pickup", "van", "convertible", "other",
]
Drive = Literal["FWD", "RWD", "AWD", "4WD"]
Transmission = Literal["AT", "MT", "CVT", "DCT", "AMT", "other"]
Fuel = Literal["petrol", "diesel", "hybrid", "phev", "ev", "lpg", "other"]
Country = Literal["jp", "kr", "cn"]
Currency = Literal["JPY", "KRW", "CNY", "USD"]
PriceKind = Literal["start", "current", "final", "dealer_ask", "recommended"]
SourceType = Literal["jp_auction_sheet", "kr_listing", "other"]


class CarExtraction(BaseModel):
    """
    Каждое поле обязательно присутствует в ответе (SDK требует этого от
    structured output), но может быть null — модель обязана явно признать,
    что не нашла значение, а не выдумывать его. Уверенность и оговорки —
    в confidence/warnings.
    """
    source_type: SourceType
    country: Optional[Country]

    make: Optional[str]
    model: Optional[str]
    trim: Optional[str]
    generation: Optional[str]

    year: Optional[int] = Field(description="год ВЫПУСКА, не регистрации")
    month: Optional[int]
    mileage_km: Optional[int]
    mileage_raw: Optional[str] = Field(description="как написано на скрине, до пересчёта в км")

    volume_cc: Optional[int]
    power_hp: Optional[int]
    power_kw: Optional[int]

    fuel: Optional[Fuel]
    transmission: Optional[Transmission]
    drive: Optional[Drive]
    body: Optional[Body]
    doors: Optional[int]
    seats: Optional[int]

    color: Optional[str] = Field(description="по-русски")
    color_raw: Optional[str] = Field(description="как в оригинале")

    auction_grade: Optional[str] = Field(description='напр. "4.5", "R", "RA", "S"')
    interior_grade: Optional[str] = Field(description='напр. "A", "B", "C"')
    auction_name: Optional[str]
    auction_date: Optional[str] = Field(description="ISO-дата, если указана")
    lot_number: Optional[str]

    price_value: Optional[float]
    price_currency: Optional[Currency]
    price_kind: Optional[PriceKind]

    vin: Optional[str]
    plate_no: Optional[str]

    equipment: list[str] = Field(description="опции/оснащение, если перечислены")
    damage_notes: list[str] = Field(description="расшифровка кодов повреждений (A1/U2/W3/XX и т.п.)")
    inspector_notes_ru: Optional[str] = Field(description="перевод рукописных заметок инспектора")

    confidence: dict[str, float] = Field(description="0..1 по каждому непустому полю")
    warnings: list[str] = Field(description="что не удалось распознать или вызывает сомнение")


WT_EXTRACT_SYSTEM = """Ты — эксперт по распознаванию аукционных листов и карточек подержанных \
автомобилей из Японии и Кореи для брокера автоимпорта во Владивостоке. Тебе присылают скриншот \
(лист японского аукциона — USS, TAA, JU, HAA и аналогичные, либо карточку с корейской площадки \
вроде Encar) и просят извлечь характеристики авто в структурированном виде.

ГЛАВНОЕ ПРАВИЛО: не выдумывай значения. Если поле не видно на скриншоте, не читается или ты не \
уверен — верни null для этого поля и опиши сомнение в warnings. Ложное значение хуже пустого: \
брокер считает таможенные платежи по этим данным, ошибка в объёме двигателя или мощности прямо \
меняет сумму пошлины и утильсбора на сотни тысяч рублей.

## Японский аукционный лист — что на нём есть

Стандартный лист содержит: название аукциона и дату торгов, номер лота (通常番号/Lot No), марку и \
модель (часто катаканой), год выпуска (年式 — ГГГГ или Хэйсэй/Рэйва + год), объём двигателя в см³ \
или литрах, тип КПП (AT/MT/CVT), пробег (走行 — в км, иногда в 万km, где 1万=10000), цвет кузова \
(色), оценку кузова и салона, эскиз кузова с пометками повреждений, иногда рукописные заметки \
инспектора японской иероглификой или сокращениями.

**Оценка кузова (総合評価):** по убыванию состояния — S, 6, 5, 4.5, 4, 3.5, 3, 2, 1, затем R и RA \
(машины после ДТП/восстановленные — RA хуже R). Оценка салона отдельно: A (отличный) → B → C → D \
(худший).

**Коды повреждений на эскизе кузова** (буква = тип, цифра = серьёзность, больше — хуже):
- A1–A3 — вмятины (凹み)
- U1–U2 — вмятины с заломом
- W1–W3 — царапины (キズ)
- S1–S2 — ржавчина (サビ)
- C — коррозия/требует покраски
- P — следы покраски/перекраса
- X — требуется ремонт, XX — серьёзные повреждения, замена панели

Перечисли все закодированные повреждения в damage_notes человеческим языком (напр. "вмятина на \
правой передней двери (A2)"), не только код.

**Единицы:** 走行距離 (пробег) почти всегда в километрах; если указано "万km" — умножь на 10000. \
Если пробег дан в милях (редко, для экспортных листов) — переведи в км (×1.609) и отметь это в \
warnings. Мощность на японских листах обычно в кВт или л.с. (PS) — если написано "kW", переведи \
дополнительно в л.с. (×1.34) только если это не создаёт двусмысленности; в остальном верни то \
значение, что видишь, в соответствующее поле (power_kw или power_hp), оставив второе null, если \
источника для пересчёта нет.

## Корейские карточки (Encar и аналогичные)

Цена почти всегда в 만원 (10 000 вон) — если видишь "3200만원", это 32 000 000 KRW; переведи в \
price_value как число в вонах (32000000), price_currency="KRW".

**Критично: год выпуска ≠ год постановки на учёт.** Корейские карточки часто показывают дату \
первой регистрации (첫등록일), которая может отличаться от года выпуска (제작년월) на несколько \
месяцев или год. Если на карточке подписано именно "생산연월"/"제작년월" (год-месяц ПРОИЗВОДСТВА) — \
используй его для year/month. Если подписано только "연식"/дата регистрации без явного \
уточнения — используй его, но обязательно добавь в warnings: "год мог означать дату регистрации, \
а не выпуска — проверить".

Комплектация/트림 (badge) на Encar часто содержит английские названия трима (Prestige, \
Calligraphy, Le Blanc, The New, Long Range и т.п.) — переноси как есть в trim.

## Общее для обеих стран

- Кузов (body) выводи по силуэту машины на фото и/или названию модели, если явно не подписан.
- Привод (drive) чаще всего не подписан явно на аукционном листе/карточке — оставляй null, если \
не видишь явного текста "4WD"/"AWD"/"2WD" и не выводи из одной лишь марки/модели.
- Для confidence используй ключи ровно как имена полей этой схемы (например "year", "power_hp", \
"price_value"); включай в словарь только поля, для которых значение не null.
- price_kind: "start" — стартовая цена торгов, "current" — текущая ставка, "final" — цена \
продажи/финальная, "dealer_ask" — цена продавца (дилерская карточка), "recommended" — \
рекомендованная/оценочная цена аукциона (推定価格).
"""


async def extract_car(
    image_bytes: bytes,
    mime: str,
    country_hint: str | None = None,
) -> tuple[CarExtraction, Usage]:
    client = get_client()
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")

    hint = (
        f"Подсказка: пользователь указал страну — {country_hint}. "
        "Используй её, только если она не противоречит тому, что видно на скрине."
        if country_hint else
        "Страна не указана пользователем — определи по языку/оформлению листа."
    )

    started = time.monotonic()
    response = await client.beta.messages.parse(
        model=model_name(),
        max_tokens=MAX_TOKENS,
        betas=BETAS,
        fallbacks=FALLBACKS,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=[{
            "type": "text",
            "text": WT_EXTRACT_SYSTEM,
            # час, а не дефолтные 5 минут: распознавания за рабочую сессию идут
            # с паузами (брокер листает лоты), с коротким TTL кэш почти не бьёт
            "cache_control": {"type": "ephemeral", "ttl": "1h"},
        }],
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                {"type": "text", "text": hint + " Извлеки характеристики авто по схеме."},
            ],
        }],
        output_format=CarExtraction,
    )
    usage = usage_from(response, started)

    if response.stop_reason == "refusal":
        log.warning("extract_car: модель отказала (refusal)")
        empty = CarExtraction.model_construct(
            source_type="other", country=None, make=None, model=None, trim=None,
            generation=None, year=None, month=None, mileage_km=None, mileage_raw=None,
            volume_cc=None, power_hp=None, power_kw=None, fuel=None, transmission=None,
            drive=None, body=None, doors=None, seats=None, color=None, color_raw=None,
            auction_grade=None, interior_grade=None, auction_name=None, auction_date=None,
            lot_number=None, price_value=None, price_currency=None, price_kind=None,
            vin=None, plate_no=None, equipment=[], damage_notes=[], inspector_notes_ru=None,
            confidence={},
            warnings=["Модель отказалась обрабатывать это изображение — заполните карточку вручную."],
        )
        return empty, usage

    if response.parsed_output is None:
        # structured output не собрался в валидный JSON — не должно происходить
        # при stop_reason == end_turn, но не доверяем молча пустому результату
        raise RuntimeError(f"extract_car: пустой parsed_output при stop_reason={response.stop_reason}")

    return response.parsed_output, usage

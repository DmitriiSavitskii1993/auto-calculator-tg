"""
ai_enrich.py — обогащение с drom.ru: заводская комплектация по ссылке,
которую пользователь сам вставил в форму.

Выключено по умолчанию (config.DROM_ENRICH) — см. риск 1 плана (ГК ст.
1334/1335.1 + стоимость). Роутер обязан проверить флаг ДО вызова этой
функции; сама функция флаг не читает, чтобы не плодить два места проверки.

web_fetch_20260209 фетчит ТОЛЬКО url, уже присутствующий в сообщении — сама
модель ничего не обходит и не индексирует, краулинга не происходит by design
(так документирует server tool). allowed_domains жёстко ограничивает drom.ru.
"""
import logging
import time
from typing import Literal, Optional

from pydantic import BaseModel, Field

from services.ai_client import BETAS, FALLBACKS, MAX_TOKENS, Usage, get_client, model_name, usage_from

log = logging.getLogger("wtcars.ai")

Drive = Literal["FWD", "RWD", "AWD", "4WD"]
Transmission = Literal["AT", "MT", "CVT", "DCT", "AMT", "other"]
Body = Literal[
    "sedan", "suv", "wagon", "hatchback", "coupe",
    "minivan", "pickup", "van", "convertible", "other",
]


class TrimEnrichment(BaseModel):
    generation: Optional[str]
    restyling: Optional[str] = Field(description='напр. "рестайлинг", "дорестайлинг"')
    trim_name: Optional[str]
    factory_options: list[str] = Field(description="заводские опции комплектации")
    power_hp: Optional[int]
    volume_cc: Optional[int]
    drive: Optional[Drive]
    transmission: Optional[Transmission]
    body: Optional[Body]
    dimensions: Optional[str] = Field(description='"длина×ширина×высота, мм", если указаны')
    curb_weight_kg: Optional[int]
    fuel_consumption: Optional[str] = Field(description="расход, как указан на странице")
    matched_confidence: float = Field(description="0..1 — насколько страница соответствует этому авто")
    notes: list[str]


WT_ENRICH_SYSTEM = """Ты помогаешь брокеру автоимпорта дополнить карточку авто заводскими \
характеристиками комплектации со страницы каталога drom.ru, ссылку на которую он сам вставил.

Тебе доступен инструмент web_fetch — используй его ровно один раз, чтобы получить содержимое \
переданной ссылки, и извлеки из неё паспортные данные комплектации: поколение и рестайлинг модели, \
название комплектации/трима, заводские опции, мощность и объём двигателя по паспорту, привод, \
тип КПП, тип кузова, габариты, снаряжённую массу, расход топлива.

Важно: это данные о МОДЕЛИ/КОМПЛЕКТАЦИИ вообще, а не о конкретном экземпляре авто — на них не \
может быть пробега, конкретной цены или состояния конкретной машины. Если страница описывает не \
ту модель или комплектацию, которую, видимо, имел в виду пользователь (например, ссылка ведёт на \
другое поколение) — не подгоняй данные под ожидание, верни то, что реально на странице, и укажи \
это в notes, а matched_confidence сделай низким.

Если страница не открылась, редиректнула на общий каталог, требует авторизации или показывает не \
карточку модели — верни все поля null/пустыми и объясни это в notes. Не выдумывай технические \
характеристики, которых на странице нет."""


async def enrich_from_drom(url: str) -> tuple[Optional[TrimEnrichment], Optional[Usage]]:
    client = get_client()

    started = time.monotonic()
    response = await client.beta.messages.parse(
        model=model_name(),
        max_tokens=MAX_TOKENS,
        betas=BETAS,
        fallbacks=FALLBACKS,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},  # извлечение с одной страницы, не нужен high
        tools=[{
            "type": "web_fetch_20260209",
            "name": "web_fetch",
            "max_uses": 2,
            "allowed_domains": ["drom.ru", "www.drom.ru"],
            "max_content_tokens": 8000,
            "citations": {"enabled": True},
        }],
        system=WT_ENRICH_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Ссылка на комплектацию: {url}\n\nИзвлеки характеристики по схеме.",
        }],
        output_format=TrimEnrichment,
    )
    usage = usage_from(response, started)

    if response.stop_reason == "refusal":
        log.warning("enrich_from_drom: модель отказала (refusal) для %s", url)
        return None, usage

    # Ошибки серверного инструмента приходят HTTP 200 внутри содержимого
    # ответа, а не исключением — проверяем явно (см. shared/live-sources и
    # skill claude-api § Common Pitfalls: "Server-tool errors don't raise").
    for block in response.content:
        if getattr(block, "type", None) == "web_fetch_tool_result":
            content = block.content
            if getattr(content, "type", None) == "web_fetch_tool_result_error":
                log.info("enrich_from_drom: web_fetch отказал, код=%s url=%s", content.error_code, url)
                return None, usage

    if response.parsed_output is None:
        log.warning("enrich_from_drom: пустой parsed_output, stop_reason=%s", response.stop_reason)
        return None, usage

    return response.parsed_output, usage


def merge_specs(extraction: dict, enrichment: "TrimEnrichment | None") -> dict:
    """
    Аукционный лист побеждает по данным КОНКРЕТНОГО авто (пробег, оценка,
    цена, год) — их drom.ru вообще не поставляет. drom побеждает только по
    заводским ТТХ комплектации, и только там, где распознавание неуверенно
    (confidence < 0.8) — так более надёжный источник не переписывает то, что
    модель уже уверенно прочитала с самого объявления.
    """
    if enrichment is None:
        return {}
    confidence = extraction.get("confidence") or {}
    specs: dict = {"drom": enrichment.model_dump()}
    for field in ("power_hp", "volume_cc", "drive", "transmission", "body"):
        value = getattr(enrichment, field)
        if value is None:
            continue
        if confidence.get(field, 0) >= 0.8:
            continue  # распознавание уже уверено — не перезаписываем
        specs.setdefault("filled_from_drom", []).append(field)
    return specs

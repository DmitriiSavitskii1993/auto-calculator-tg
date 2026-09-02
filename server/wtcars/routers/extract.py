"""
extract.py — POST /wtapi/extract: скрин → характеристики авто.

Карточку не создаёт (в базе на этот момент ещё нет Car — только вернувшийся
extraction_id). Оригинал скрина ждёт в /var/lib/wtcars/photos/tmp/<extraction_id>/
до момента POST /cars: тогда routers.cars._adopt_extraction_photo() заберёт
его в постоянное хранилище и привяжет к карточке.
"""
import logging
import uuid

import anthropic
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

import config
from database import get_session
from deps import get_current_owner
from models import AiCall, Owner
from schemas import ExtractOut
from services import storage
from services.ai_client import AiNotConfigured, Usage
from services.ai_enrich import enrich_from_drom, merge_specs
from services.ai_extract import extract_car

log = logging.getLogger("wtcars.extract")
router = APIRouter(prefix="/extract", tags=["extract"])


async def _log_call(
    session: AsyncSession, owner: Owner, kind: str, usage: Usage | None,
    ok: bool, error: str | None = None,
) -> None:
    session.add(AiCall(
        owner_id=owner.id,
        kind=kind,
        model=config.AI_MODEL,
        input_tokens=usage.input_tokens if usage else None,
        output_tokens=usage.output_tokens if usage else None,
        cache_read_tokens=usage.cache_read_tokens if usage else None,
        cost_usd=usage.cost_usd if usage else None,
        latency_ms=usage.latency_ms if usage else None,
        ok=ok,
        error=error,
    ))
    await session.commit()


@router.post("", response_model=ExtractOut)
async def extract(
    file: UploadFile = File(...),
    country: str | None = Form(default=None),
    drom_url: str | None = Form(default=None),
    owner: Owner = Depends(get_current_owner),
    session: AsyncSession = Depends(get_session),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="пустой файл")
    if len(data) > config.MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"файл больше {config.MAX_PHOTO_BYTES // (1024 * 1024)} МБ",
        )
    try:
        mime, _w, _h = storage.probe(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    ai_bytes = storage.to_ai_jpeg(data)

    try:
        extraction, usage = await extract_car(ai_bytes, "image/jpeg", country_hint=country)
    except AiNotConfigured as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except anthropic.RateLimitError as e:
        await _log_call(session, owner, "extract", None, ok=False, error="rate_limit")
        raise HTTPException(status_code=429, detail="Anthropic: превышен лимит запросов, попробуйте через минуту") from e
    except anthropic.APIConnectionError as e:
        await _log_call(session, owner, "extract", None, ok=False, error="connection")
        raise HTTPException(status_code=502, detail="Не удалось связаться с Anthropic API") from e
    except anthropic.APIStatusError as e:
        await _log_call(session, owner, "extract", None, ok=False, error=f"status_{e.status_code}")
        raise HTTPException(status_code=502, detail=f"Anthropic вернул ошибку {e.status_code}") from e
    except Exception as e:
        log.exception("extract_car упал")
        await _log_call(session, owner, "extract", None, ok=False, error=str(e)[:500])
        raise HTTPException(status_code=500, detail="Не удалось распознать изображение") from e

    await _log_call(session, owner, "extract", usage, ok=True)

    warnings = list(extraction.warnings)
    specs: dict | None = None

    if drom_url:
        if not config.DROM_ENRICH:
            warnings.append("Ссылка на drom.ru указана, но обогащение выключено (DROM_ENRICH=off).")
        else:
            try:
                enrichment, enrich_usage = await enrich_from_drom(drom_url)
                await _log_call(session, owner, "enrich", enrich_usage, ok=enrichment is not None)
                if enrichment is None:
                    warnings.append("Не удалось прочитать страницу drom.ru — заполните комплектацию вручную.")
                else:
                    specs = merge_specs(extraction.model_dump(), enrichment)
            except AiNotConfigured:
                pass  # уже отражено выше на этапе extract — не дублируем предупреждение
            except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.APIStatusError) as e:
                await _log_call(session, owner, "enrich", None, ok=False, error=str(e)[:200])
                warnings.append("drom.ru временно недоступен — попробуйте позже.")
            except Exception as e:
                log.exception("enrich_from_drom упал")
                await _log_call(session, owner, "enrich", None, ok=False, error=str(e)[:500])
                warnings.append("Не удалось обогатить данные с drom.ru.")

    extraction_id = str(uuid.uuid4())
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(mime, ".bin")
    (storage.tmp_dir(extraction_id) / f"source{ext}").write_bytes(data)

    fields = extraction.model_dump(exclude={"confidence", "warnings"})
    return ExtractOut(
        extraction_id=extraction_id,
        fields=fields,
        confidence=extraction.confidence,
        warnings=warnings,
        specs=specs,
    )

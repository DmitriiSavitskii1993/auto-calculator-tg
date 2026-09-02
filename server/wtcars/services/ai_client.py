"""
ai_client.py — общий клиент Anthropic и учёт стоимости вызовов.

Модель, thinking и refusal-fallback вынесены сюда одним местом: если модель
или ставки поменяются, править нужно только здесь.

Сверено с фактически установленным SDK (anthropic==1.2.0), а не по памяти:
`client.beta.messages.parse(...)` существует и принимает betas/fallbacks/
output_format/output_config/thinking одновременно (интроспекция сигнатуры),
`fallbacks` принимает литерал "default" (BetaFallbacksParam =
Union[Iterable[BetaFallbackParam], Literal["default"]]), `cache_control`
поддерживает `ttl: "5m"|"1h"`.
"""
import time
from dataclasses import dataclass

import anthropic

from config import AI_MODEL, ANTHROPIC_API_KEY

# Рефузл-фоллбэк — по умолчанию включаем на всех вызовах Opus 5, как требует
# skill: при отказе модели по безопасности запрос молча повторяется на
# резервной модели в рамках того же вызова.
BETAS = ["server-side-fallback-2026-07-01"]
FALLBACKS = "default"

MAX_TOKENS = 16000  # выше не нужно: SDK не выставляет счёт за неиспользованный лимит

# $ за 1M токенов (Opus 5). Кэш: запись ×1.25, чтение ×0.1 от цены входа —
# так документирует prompt caching для всех моделей.
_PRICE_IN = 5.00
_PRICE_OUT = 25.00
_CACHE_WRITE_MULT = 1.25
_CACHE_READ_MULT = 0.1


@dataclass
class Usage:
    input_tokens: int
    output_tokens: int
    cache_creation_tokens: int
    cache_read_tokens: int
    latency_ms: int
    cost_usd: float


def _cost(usage) -> float:
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    created = getattr(usage, "cache_creation_input_tokens", 0) or 0
    read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cost = (
        inp * _PRICE_IN
        + created * _PRICE_IN * _CACHE_WRITE_MULT
        + read * _PRICE_IN * _CACHE_READ_MULT
    ) / 1e6 + (out * _PRICE_OUT) / 1e6
    return round(cost, 6)


def usage_from(response, started_at: float) -> Usage:
    u = response.usage
    return Usage(
        input_tokens=getattr(u, "input_tokens", 0) or 0,
        output_tokens=getattr(u, "output_tokens", 0) or 0,
        cache_creation_tokens=getattr(u, "cache_creation_input_tokens", 0) or 0,
        cache_read_tokens=getattr(u, "cache_read_input_tokens", 0) or 0,
        latency_ms=int((time.monotonic() - started_at) * 1000),
        cost_usd=_cost(u),
    )


class AiNotConfigured(RuntimeError):
    """ANTHROPIC_API_KEY пуст — до заполнения .env вызовы недоступны."""


_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if not ANTHROPIC_API_KEY:
        raise AiNotConfigured(
            "ANTHROPIC_API_KEY не задан. Впишите ключ в server/wtcars/.env "
            "и перезапустите сервис (systemctl restart wtcars-api)."
        )
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    return _client


def model_name() -> str:
    return AI_MODEL

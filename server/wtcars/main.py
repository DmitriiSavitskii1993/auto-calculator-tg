"""
main.py — FastAPI-приложение wtcars.

Работает на 127.0.0.1:8082, снаружи доступно через nginx как
https://publiosmm.ru/wtapi/*. Префикс /wtapi объявлен здесь, nginx его
не срезает — так же, как /api у PublioSMM.
"""
import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from config import ALLOWED_ORIGINS, DEBUG
from database import SessionLocal
from routers import auth, cars, extract, photos
from services import storage

log = logging.getLogger("wtcars")


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.ensure_dirs()
    removed = storage.cleanup_tmp()
    if removed:
        log.info("подчищено временных распознаваний: %s", removed)
    yield


app = FastAPI(
    title="wtcars",
    docs_url="/wtapi/docs" if DEBUG else None,
    redoc_url=None,
    openapi_url="/wtapi/openapi.json" if DEBUG else None,
    lifespan=lifespan,
)

# Mini App живёт на GitHub Pages — это отдельный origin, поэтому CORS нужен.
# Список origin-ов задаётся явно, никаких "*": с credentials это запрещено,
# а без них всё равно незачем.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

api = APIRouter(prefix="/wtapi")


@api.get("/health")
async def health():
    db_ok = False
    try:
        async with SessionLocal() as s:
            await s.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:
        log.warning("health: база недоступна: %s", e)
    return {"ok": True, "service": "wtcars", "db": db_ok}


api.include_router(auth.router)
api.include_router(cars.router)
api.include_router(photos.router)
api.include_router(extract.router)
app.include_router(api)

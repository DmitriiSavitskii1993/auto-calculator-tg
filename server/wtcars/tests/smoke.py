"""
smoke.py — сквозная проверка сервиса на фикстурах настоящего движка.

Запуск из каталога server/wtcars:
    ./venv/bin/python tests/smoke.py [путь/к/fixtures.json]

Фикстуры делает scratchpad/make_fixtures.js — он гоняет реальный js/calc.js
под Node. Смысл в том, чтобы проверять приём ровно того JSON, который отдаёт
боевой калькулятор, а не выдуманного.
"""
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

# --- окружение теста задаём ДО импорта config ---
TMP = Path(tempfile.mkdtemp(prefix="wtcars-smoke-"))
BOT_TOKEN = "123456:TEST-BOT-TOKEN-FOR-SMOKE"
os.environ.update(
    DATABASE_URL=f"sqlite+aiosqlite:///{TMP / 'smoke.db'}",
    WT_BOT_TOKEN=BOT_TOKEN,
    WT_JWT_SECRET="smoke-secret-not-for-prod",
    STORAGE_DIR=str(TMP / "storage"),
    OWNER_TELEGRAM_IDS="",
    DEBUG="on",
    ANTHROPIC_API_KEY="",  # намеренно пусто — проверяем путь «ключ не настроен»
    DROM_ENRICH="on",      # включаем на время теста, чтобы проверить и эту ветку
)

from fastapi.testclient import TestClient  # noqa: E402

import models  # noqa: E402
from database import engine  # noqa: E402
from main import app  # noqa: E402

OK, FAIL = "\033[32m✓\033[0m", "\033[31m✗\033[0m"
_failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    print(f"  {OK if cond else FAIL} {label}{('  — ' + detail) if detail else ''}")
    if not cond:
        _failures.append(label)


def make_init_data(tg_id: int = 777000111) -> str:
    """Собирает initData и подписывает её тем же алгоритмом, что Telegram."""
    user = json.dumps(
        {"id": tg_id, "first_name": "Дмитрий", "username": "wt_broker"},
        ensure_ascii=False, separators=(",", ":"),
    )
    pairs = {"auth_date": str(int(time.time())), "query_id": "AAF", "user": user}
    dcs = "\n".join(f"{k}={pairs[k]}" for k in sorted(pairs))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    pairs["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(pairs)


def tiny_png() -> bytes:
    """Реальный PNG 4×4, чтобы Pillow его действительно распознал."""
    from PIL import Image
    import io
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


def main() -> int:
    fixtures_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "fixtures.json"
    if not fixtures_path.is_file():
        print(f"нет файла фикстур: {fixtures_path}")
        return 2
    fixtures = json.loads(fixtures_path.read_text())

    import asyncio

    async def create_schema():
        async with engine.begin() as conn:
            await conn.run_sync(models.Base.metadata.create_all)

    asyncio.run(create_schema())

    with TestClient(app) as c:
        print("\n1. Здоровье и авторизация")
        r = c.get("/wtapi/health")
        check("GET /wtapi/health", r.status_code == 200 and r.json().get("db") is True, r.text[:80])

        r = c.post("/wtapi/auth/miniapp", json={"init_data": "hash=deadbeef&auth_date=1"})
        check("подделанная подпись отвергнута", r.status_code == 403)

        stale = make_init_data()
        stale = stale.replace(f"auth_date={int(time.time())}", "auth_date=1000000000")
        r = c.post("/wtapi/auth/miniapp", json={"init_data": stale})
        check("протухшая initData отвергнута", r.status_code == 403)

        r = c.post("/wtapi/auth/miniapp", json={"init_data": make_init_data()})
        check("валидная initData принята", r.status_code == 200, r.text[:120])
        if r.status_code != 200:
            return 1
        token = r.json()["token"]
        H = {"Authorization": f"Bearer {token}"}

        r = c.get("/wtapi/cars")
        check("без токена — 401", r.status_code == 401)

        print("\n2. Сохранение расчётов настоящего движка")
        created = []
        for fx in fixtures:
            body = {
                "vehicle": fx["vehicle"],
                "calc_input": fx["calc_input"],
                "calc_result": fx["calc_result"],
                "rates": fx["rates"],
            }
            r = c.post("/wtapi/cars", json=body, headers=H)
            ok = r.status_code == 201
            check(f"POST /cars — {fx['name']}", ok, "" if ok else r.text[:200])
            if ok:
                created.append((fx, r.json()))

        if len(created) != len(fixtures):
            return 1

        print("\n3. Снимок не разъехался с результатом движка")
        for fx, car in created:
            expected = round(float(fx["calc_result"]["grandTotal"]))
            check(
                f"price_rub_total == grandTotal ({fx['vehicle']['model']})",
                car["price_rub_total"] == expected,
                f"в базе {car['price_rub_total']}, движок {expected}",
            )
            check(
                f"util_preferential ({fx['vehicle']['model']})",
                car["util_preferential"] == fx["calc_result"]["utilPreferentialApplied"],
            )
            check(
                f"мощность в л.с. ({fx['vehicle']['model']})",
                car["power_hp"] == round(float(fx["calc_result"]["input"]["powerHp"])),
                f"в базе {car['power_hp']}",
            )
        ev = [c_ for f, c_ in created if f["vehicle"].get("fuel") == "ev"][0]
        check("электрокар помечен is_electric", ev["is_electric"] is True)
        check("порог утиля для EV = 80 л.с.", ev["util_threshold_hp"] == 80)
        check("заголовок собран автоматически", bool(created[0][1]["title"]),
              created[0][1]["title"] or "")

        print("\n4. Фильтры — то, ради чего вся база")
        def ids(**params):
            rr = c.get("/wtapi/cars", params=params, headers=H)
            assert rr.status_code == 200, rr.text
            return {i["id"] for i in rr.json()["items"]}, rr.json()["total"]

        all_ids, total = ids()
        check("список отдаёт все 3 карточки", total == 3, f"total={total}")

        pref_ids, _ = ids(util_pref=True)
        expect_pref = {c_["id"] for f, c_ in created if f["calc_result"]["utilPreferentialApplied"]}
        check("фильтр «льготный утиль» (≤160 л.с.)", pref_ids == expect_pref,
              f"{sorted(pref_ids)} vs {sorted(expect_pref)}")

        cheap_ids, _ = ids(price_max=2_000_000)
        expect_cheap = {c_["id"] for f, c_ in created
                        if round(float(f["calc_result"]["grandTotal"])) <= 2_000_000}
        check("фильтр «под ключ до 2 млн»", cheap_ids == expect_cheap)

        band_ids, _ = ids(price_min=5_000_000, price_max=6_500_000)
        check("фильтр «под ключ 5–6.5 млн» отдаёт 2 авто", len(band_ids) == 2, str(sorted(band_ids)))

        suv_ids, _ = ids(body="suv")
        check("фильтр по кузову suv", len(suv_ids) == 2, str(sorted(suv_ids)))
        check("фильтр по приводу AWD", len(ids(drive="AWD")[0]) == 2)
        check("фильтр по КПП CVT", len(ids(transmission="CVT")[0]) == 1)
        check("фильтр по году от 2021", len(ids(year_min=2021)[0]) == 2)
        check("фильтр по пробегу до 50 тыс.", len(ids(mileage_max=50000)[0]) == 2)
        check("фильтр по стране kr", len(ids(country="kr")[0]) == 1)
        check("комбинация: jp + льгота + до 2 млн", len(ids(country="jp", util_pref=True,
                                                           price_max=2_000_000)[0]) == 1)
        check("поиск по названию «Harrier»", len(ids(q="Harrier")[0]) == 1)
        check("несовпадающий фильтр даёт пусто", len(ids(body="pickup")[0]) == 0)

        rr = c.get("/wtapi/cars", params={"sort": "price", "order": "asc"}, headers=H)
        prices = [i["price_rub_total"] for i in rr.json()["items"]]
        check("сортировка по цене по возрастанию", prices == sorted(prices), str(prices))

        print("\n5. Фотографии")
        car_id = created[0][1]["id"]
        png = tiny_png()
        r = c.post(f"/wtapi/cars/{car_id}/photos", headers=H,
                   files=[("files", ("a.png", png, "image/png"))])
        check("загрузка фото", r.status_code == 200, r.text[:160])
        photo = r.json()[0]
        check("вернулся подписанный url", "?t=" in photo["url"], photo["url"][:60])
        check("размеры распознаны", (photo["width"], photo["height"]) == (4, 4))

        r2 = c.post(f"/wtapi/cars/{car_id}/photos", headers=H,
                    files=[("files", ("a-again.png", png, "image/png"))])
        check("повторная загрузка того же файла дедуплицируется",
              r2.status_code == 200 and r2.json()[0]["id"] == photo["id"])

        r = c.get(photo["url"].replace("/wtapi", "/wtapi"))
        check("фото отдаётся по подписанной ссылке",
              r.status_code == 200 and r.content == png, f"код {r.status_code}")
        r = c.get(f"/wtapi/photos/{photo['id']}?t=подделка")
        check("подделанный токен фото отвергнут", r.status_code == 403)
        r = c.get(f"/wtapi/photos/{photo['id']}")
        check("без токена фото не отдаётся", r.status_code == 422)

        r = c.post(f"/wtapi/cars/{car_id}/photos", headers=H,
                   files=[("files", ("bad.png", "не картинка".encode(), "image/png"))])
        check("мусор вместо картинки отвергнут", r.status_code == 400, r.text[:100])

        print("\n6. Правка и удаление")
        r = c.patch(f"/wtapi/cars/{car_id}", headers=H,
                    json={"status": "sold", "notes": "продано 28.08"})
        check("PATCH статуса", r.status_code == 200 and r.json()["status"] == "sold")
        check("проданное ушло из выдачи active", car_id not in ids()[0])
        check("status=all возвращает всё", len(ids(status="all")[0]) == 3)

        r = c.get(f"/wtapi/cars/{car_id}", headers=H)
        check("детальная карточка содержит calc_result",
              r.status_code == 200 and "grandTotal" in r.json()["calc_result"])
        check("детальная карточка содержит снимок курсов",
              bool(r.json().get("rates_snapshot", {}).get("market")))

        other = c.post("/wtapi/auth/miniapp", json={"init_data": make_init_data(999000222)}).json()
        r = c.get(f"/wtapi/cars/{car_id}", headers={"Authorization": f"Bearer {other['token']}"})
        check("чужую карточку не отдаём", r.status_code == 404)

        r = c.delete(f"/wtapi/cars/{car_id}", headers=H)
        check("DELETE карточки", r.status_code == 200)
        check("после удаления осталось 2", ids(status="all")[1] == 2)

        print("\n7. Распознавание скрина")
        r = c.post("/wtapi/extract", headers=H,
                   files={"file": ("sheet.png", tiny_png(), "image/png")})
        check("без ANTHROPIC_API_KEY — 503, а не 500", r.status_code == 503, r.text[:150])

        # Дальше — happy path без сети: подменяем ровно те имена, что
        # routers/extract.py импортировал к себе (`from services.ai_extract
        # import extract_car`), поэтому патчим модуль routers.extract, а не
        # services.ai_extract — иначе подмена не сработает.
        import routers.extract as extract_router
        from services.ai_client import Usage
        from services.ai_enrich import TrimEnrichment
        from services.ai_extract import CarExtraction

        canned = CarExtraction(
            source_type="jp_auction_sheet", country="jp",
            make="Toyota", model="Corolla Fielder", trim="Hybrid G", generation=None,
            year=2021, month=6, mileage_km=48000, mileage_raw="4.8万km",
            volume_cc=1500, power_hp=150, power_kw=None,
            fuel="petrol", transmission="CVT", drive="FWD", body="wagon",
            doors=5, seats=5, color="белый", color_raw="白",
            auction_grade="4.5", interior_grade="B", auction_name="JU MIE",
            auction_date=None, lot_number="30215",
            price_value=1200000, price_currency="JPY", price_kind="final",
            vin=None, plate_no=None,
            equipment=["климат-контроль", "камера заднего вида"],
            damage_notes=["A2 — вмятина на правой двери"],
            inspector_notes_ru=None,
            confidence={"make": 0.98, "model": 0.95, "year": 0.9, "power_hp": 0.92},
            warnings=["мощность на листе указана нечётко"],
        )
        canned_usage = Usage(input_tokens=2400, output_tokens=1100,
                              cache_creation_tokens=0, cache_read_tokens=0,
                              latency_ms=1200, cost_usd=0.0335)

        async def fake_extract_car(image_bytes, mime, country_hint=None):
            return canned, canned_usage

        canned_enrich = TrimEnrichment(
            generation="12 поколение", restyling="рестайлинг", trim_name="Hybrid G",
            factory_options=["панорамная крыша"], power_hp=152, volume_cc=1500,
            drive="FWD", transmission="CVT", body="wagon",
            dimensions="4495×1695×1500 мм", curb_weight_kg=1350,
            fuel_consumption="4.2 л/100км", matched_confidence=0.9,
            notes=["данные по заводской комплектации"],
        )
        enrich_usage = Usage(input_tokens=6000, output_tokens=900,
                              cache_creation_tokens=0, cache_read_tokens=0,
                              latency_ms=2100, cost_usd=0.0525)

        async def fake_enrich_from_drom(url):
            return canned_enrich, enrich_usage

        extract_router.extract_car = fake_extract_car
        extract_router.enrich_from_drom = fake_enrich_from_drom

        r = c.post("/wtapi/extract", headers=H,
                   files={"file": ("sheet.png", tiny_png(), "image/png")},
                   data={"country": "jp", "drom_url": "https://www.drom.ru/catalog/toyota/corolla/"})
        check("распознавание с подменённой моделью — 200", r.status_code == 200, r.text[:200])
        body = r.json()
        check("extraction_id вернулся", bool(body.get("extraction_id")))
        check("марка/модель дошли до клиента", body["fields"]["make"] == "Toyota"
              and body["fields"]["model"] == "Corolla Fielder")
        check("confidence дошла", body["confidence"].get("year") == 0.9)
        check("предупреждение модели сохранилось", "мощность" in " ".join(body["warnings"]))
        check("drom-обогащение отработало", body.get("specs", {}).get("drom", {}).get("trim_name") == "Hybrid G")
        filled = body["specs"].get("filled_from_drom") or []
        check("уверенно распознанное поле (power_hp, confidence 0.92) НЕ помечено как заполненное с drom",
              "power_hp" not in filled, str(filled))
        check("неуверенное/нераспознанное поле (drive) ПОМЕЧЕНО заполненным с drom",
              "drive" in filled, str(filled))

        extraction_id = body["extraction_id"]
        r = c.post("/wtapi/cars", headers=H, json={
            "vehicle": {"make": "Toyota", "model": "Corolla Fielder"},
            "calc_input": fixtures[0]["calc_input"],
            "calc_result": fixtures[0]["calc_result"],
            "rates": fixtures[0]["rates"],
            "extraction_id": extraction_id,
        })
        check("карточка из распознавания создалась", r.status_code == 201, r.text[:200])
        photos = r.json().get("photos", [])
        check("скрин из tmp усыновлён как source_screenshot", len(photos) == 1
              and photos[0]["kind"] == "source_screenshot", str(photos))

        r = c.get("/wtapi/health")  # приложение живо после всей цепочки с подменами
        check("сервис не упал после AI-веток", r.status_code == 200)

        # ai_calls действительно писались — и успешные, и вызов с 503 без ключа
        async def count_ai_calls():
            from sqlalchemy import func, select
            from database import SessionLocal
            async with SessionLocal() as s:
                total = (await s.execute(select(func.count()).select_from(models.AiCall))).scalar_one()
                failed = (await s.execute(
                    select(func.count()).select_from(models.AiCall).where(models.AiCall.ok.is_(False))
                )).scalar_one()
                return total, failed
        total_calls, failed_calls = asyncio.run(count_ai_calls())
        check("ai_calls: есть успешные записи", total_calls >= 2, f"total={total_calls}")
        check("ai_calls: 503 без ключа не считается вызовом модели (нет исходящего запроса)",
              failed_calls == 0, f"failed={failed_calls}")

    print()
    if _failures:
        print(f"\033[31mПРОВАЛЕНО: {len(_failures)}\033[0m")
        for f in _failures:
            print("   -", f)
        return 1
    print("\033[32mВсе проверки пройдены.\033[0m")
    return 0


if __name__ == "__main__":
    code = main()
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(code)

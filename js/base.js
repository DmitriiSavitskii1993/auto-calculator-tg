/* =========================================================================
 *  base.js — режим «База»: карточки авто и фильтры для подборок.
 *
 *  Расчёт не дублируется: считает по-прежнему calculate() из calc.js, а сюда
 *  приходит готовый результат и складывается в базу вместе со снимком курсов.
 *  Обработчики свои — bindEvents() из app.js вешает делегирование на
 *  #screenCalc, новые экраны его не наследуют.
 * ========================================================================= */

const BASE_FILTER_KEY = 'wt_base_filter_v1';

const baseState = {
  filter: {},
  items: [],
  total: 0,
  loading: false,
  selected: new Set(),   // id отмеченных карточек — из них собирается подборка
};

/* --- распознавание скрина --- */
let extractFile = null;
let lastExtraction = null;       // последний ответ /wtapi/extract целиком
let currentExtractionId = null;  // если задан — сохранение в базу заберёт скрин из tmp
/* Скрин, выбранный без распознавания ИИ: карточки ещё нет, поэтому файл
 * ждёт здесь и прикрепляется сразу после её создания. */
let pendingCarPhoto = null;

/* --- утилиты --- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const BODY_RU = {
  sedan: 'седан', suv: 'внедорожник', wagon: 'универсал', hatchback: 'хэтчбек',
  coupe: 'купе', minivan: 'минивэн', pickup: 'пикап', van: 'фургон',
  convertible: 'кабриолет', other: 'другое',
};
const FUEL_RU = {
  petrol: 'бензин', diesel: 'дизель', hybrid: 'гибрид',
  phev: 'гибрид (PHEV)', ev: 'электро', lpg: 'газ', other: 'другое',
};
const DRIVE_RU = { FWD: 'передний привод', RWD: 'задний привод', AWD: 'полный привод', '4WD': 'полный привод (4WD)' };
const TRANS_RU = { AT: 'автомат', CVT: 'вариатор', DCT: 'робот DCT', AMT: 'робот', MT: 'механика', other: 'КПП н/д' };
const FLAG = { jp: '🇯🇵', kr: '🇰🇷', cn: '🇨🇳' };

function money(n) {
  return n == null ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽';
}
function kmFmt(n) {
  return n == null ? '—' : Math.round(n).toLocaleString('ru-RU') + ' км';
}

/* --- снимок курсов, с которым посчитали --- */
function ratesSnapshot() {
  const cache = (typeof getCbrCache === 'function' && getCbrCache()) || null;
  return {
    cbr: Object.assign({}, cfg.rates.cbr),
    market: Object.assign({}, cfg.rates.market),
    cbr_date: cache && cache.date ? cache.date : null,
    calc_version: null,
  };
}

/* --- поля «про саму машину» из формы --- */
function collectVehicle() {
  const val = (sel) => { const el = $(sel); return el && el.value.trim() ? el.value.trim() : null; };
  const int = (sel) => { const v = val(sel); if (v == null) return null;
    const n = parseInt(v.replace(/[^\d-]/g, ''), 10); return isNaN(n) ? null : n; };

  // У пустого пункта значение '' и текст «— выбрать аукцион —»: без проверки
  // на value эта подпись уехала бы в базу как название аукциона.
  const auctionSel = $('#auction');
  const auctionName = (state.country === 'jp' && auctionSel && auctionSel.value !== '')
    ? auctionSel.options[auctionSel.selectedIndex].text : null;

  return {
    make: val('#make'),
    model: val('#model'),
    trim: val('#trimName'),
    year: int('#year'),
    month: int('#monthOut'),
    mileage_km: int('#mileage'),
    body: val('#body'),
    drive: val('#drive'),
    transmission: val('#trans'),
    fuel: state.isElectric ? 'ev' : val('#fuel'),
    color: val('#color'),
    auction_grade: val('#grade'),
    interior_grade: val('#interiorGrade'),
    lot_number: val('#lotNo'),
    auction_name: auctionName,
    drom_url: val('#dromUrl'),
    notes: val('#vehicleNotes'),
    price_foreign: num('#carPrice') || null,
    currency: { jp: 'JPY', kr: 'KRW', cn: 'CNY' }[state.country] || null,
  };
}

/* --- сохранение текущего расчёта в базу --- */
async function saveCurrentToBase(btn) {
  if (!lastResult) { toast('Сначала выполните расчёт'); return; }
  if (!wtAvailable()) { toast('База работает только внутри Telegram'); return; }

  const vehicle = collectVehicle();
  if (!vehicle.make || !vehicle.model) {
    toast('Укажите марку и модель — без них карточка не попадёт в подборку');
    const el = $('#make'); if (el) el.focus();
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Сохраняю…'; }
  try {
    const car = await wtApi.createCar({
      vehicle,
      calc_input: lastInput || lastResult.input,
      calc_result: lastResult,
      rates: ratesSnapshot(),
      extraction_id: currentExtractionId || undefined,
    });
    haptic('medium');
    if (btn) {
      btn.textContent = '✅ В базе';
      btn.dataset.carId = car.id;
    }
    // скрин, выбранный без распознавания, прикрепляем к уже созданной карточке
    if (pendingCarPhoto) {
      try {
        await wtApi.uploadPhotos(car.id, [pendingCarPhoto]);
        pendingCarPhoto = null;
      } catch (e) {
        toast('Карточка сохранена, но фото не загрузилось: ' + e.message);
      }
    }

    toast('✅ Сохранено в базу: ' + (car.title || 'авто') + ' — ' + money(car.price_rub_total));
    baseState.items = [];   // список устарел
    currentExtractionId = null;  // скрин уже усыновлён карточкой, повторно не переиспользуем
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Сохранить в базу'; }
    toast('Не удалось сохранить: ' + e.message);
  }
}

/* Хук из renderResult(): в режиме «База» дорисовываем кнопку сохранения. */
function onResultRendered() {
  const slot = $('#baseSaveSlot');
  if (!slot) return;
  if (state.mode !== 'base') { slot.innerHTML = ''; return; }
  slot.innerHTML =
    '<div class="actions-cap">В базу для подборок:</div>' +
    '<div class="result-actions">' +
    '<button class="copy-btn" id="btnSaveToBase" style="background:var(--accent)">💾 Сохранить в базу</button>' +
    '</div>';
}

/* --- распознавание скрина --- */

const EXTRACT_FIELD_LABELS = [
  ['make', 'Марка'], ['model', 'Модель'], ['trim', 'Комплектация'],
  ['year', 'Год'], ['month', 'Месяц'], ['mileage_km', 'Пробег, км'],
  ['volume_cc', 'Объём, см³'], ['power_hp', 'Мощность, л.с.'], ['power_kw', 'Мощность, кВт'],
  ['transmission', 'КПП'], ['drive', 'Привод'], ['body', 'Кузов'],
  ['color', 'Цвет'], ['auction_grade', 'Оценка'], ['interior_grade', 'Салон'],
  ['auction_name', 'Аукцион'], ['lot_number', 'Лот'],
];
const LOW_CONF = 0.75;   // ниже — подсвечиваем как «перепроверить»

/* Промт для распознавания скрина в ChatGPT/Claude. Держим в приложении,
 * чтобы копировать кнопкой, а не искать файл в репозитории. */
const EXTRACT_PROMPT = [
  'Ты помогаешь заносить японские автомобили в базу брокера автоимпорта.',
  '',
  'На скриншоте — лист японского аукциона (USS, TAA, JU, HAA, Arai и подобные),',
  'страница статистики продаж или карточка авто. Извлеки характеристики',
  'и верни ОДИН объект JSON в блоке кода. Больше ничего в блок не добавляй.',
  '',
  '{',
  '  "country": "jp",',
  '  "make": "Toyota",',
  '  "model": "Corolla Fielder",',
  '  "trim": "Hybrid G",',
  '  "year": 2021,',
  '  "month": 10,',
  '  "mileage_km": 48000,',
  '  "volume_cc": 1500,',
  '  "power_hp": 150,',
  '  "power_kw": null,',
  '  "fuel": "бензин",',
  '  "transmission": "вариатор",',
  '  "drive": "передний",',
  '  "body": "универсал",',
  '  "color": "белый",',
  '  "auction_grade": "4.5",',
  '  "interior_grade": "B",',
  '  "auction_name": "USS Tokyo",',
  '  "lot_number": "30215",',
  '  "price_value": 1200000,',
  '  "price_currency": "JPY",',
  '  "equipment": ["климат-контроль", "камера заднего вида"],',
  '  "damage_notes": ["A2 — вмятина на правой передней двери"],',
  '  "confidence": {"year": 0.95, "power_hp": 0.6},',
  '  "warnings": ["мощность на листе смазана"]',
  '}',
  '',
  'ГЛАВНОЕ ПРАВИЛО: не выдумывай. Если поле не видно или ты не уверен — не',
  'включай его в JSON и объясни почему в "warnings". Пустое поле лучше',
  'неверного: по этим данным считаются пошлина и утильсбор, ошибка в объёме,',
  'мощности или годе меняет цену на сотни тысяч рублей.',
  '',
  'ИСКЛЮЧЕНИЕ — "trim" (комплектация). Его заполняй ВСЕГДА. Если на скрине',
  'комплектация не указана или это базовая версия — пиши "BASE".',
  '',
  'ОБЯЗАТЕЛЬНЫ, иначе строка не загрузится: make, model, year, body, price_value',
  'и мощность (power_hp или power_kw). Плюс volume_cc — для бензина и дизеля',
  '(у электрокара его нет, но нужен power_kw и fuel "электро").',
  '',
  'МЕСЯЦ ВЫПУСКА ("month") указывай обязательно, если он виден. Год без месяца',
  'может дать неверную категорию возраста: авто января и октября одного года',
  'попадают в разные категории пошлины, разница — сотни тысяч рублей.',
  '',
  '"confidence" — уверенность 0..1 по спорным полям. Ниже 0.75 калькулятор',
  'подсветит поле для перепроверки.',
  '',
  'ЗНАЧЕНИЯ (пиши по-русски, как в примере):',
  '- fuel: бензин, дизель, гибрид, электро, газ',
  '- transmission: автомат, вариатор, робот, механика',
  '- drive: передний, задний, полный, 4WD',
  '- body: седан, внедорожник, универсал, хэтчбек, купе, минивэн, пикап,',
  '  фургон, кабриолет',
  '- price_value: число без пробелов, в иенах; price_currency: "JPY"',
  '',
  'ЕДИНИЦЫ И ЛОВУШКИ',
  '- Пробег «4.8万km» = 48000. Если в милях — переведи в км (×1.609)',
  '  и отметь это в warnings.',
  '- Объём приводи к см³: «2.0L» = 2000, «1998cc» = 1998.',
  '- Мощность: если на листе только кВт — заполни power_kw, а power_hp не',
  '  включай (и наоборот). Сам не пересчитывай.',
  '- Год — год ВЫПУСКА. Японский лист может показывать год по Хэйсэй/Рэйва',
  '  (Рэйва 3 = 2021, Хэйсэй 31 = 2019) — переведи в григорианский.',
  '',
  'АУКЦИОННЫЙ ЛИСТ',
  '- auction_grade (総合評価): S, 6, 5, 4.5, 4, 3.5, 3, 2, 1, R, RA.',
  '  R и RA — авто после ДТП, RA хуже.',
  '- interior_grade: A, B, C, D (A лучший).',
  '- auction_name — название дома торгов латиницей, как на листе. Указывай',
  '  только если уверен: по нему подтягивается стоимость доставки.',
  '- damage_notes — расшифруй коды с эскиза кузова человеческим языком.',
  '  A — вмятина, U — вмятина с заломом, W — царапина, S — ржавчина,',
  '  C — коррозия, P — след покраски, X — нужен ремонт, XX — замена детали.',
  '  Цифра рядом — серьёзность, больше значит хуже.',
  '',
  'ЕСЛИ ЭТО СТРАНИЦА СТАТИСТИКИ ПРОДАЖ',
  'Там обычно несколько строк с ценами проданных лотов. Возьми машину,',
  'которая явно в фокусе. Если непонятно какая — верни то, что общее для всех',
  'строк, и напиши в warnings, что на скрине несколько лотов.',
].join('\n');

async function copyExtractPrompt(btn) {
  const ok = await copyToClipboard(EXTRACT_PROMPT);
  haptic(ok ? 'medium' : 'light');
  toast(ok ? 'Промт скопирован — вставьте в чат вместе со скрином'
           : 'Не удалось скопировать');
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '✅ Скопировано';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

/* Разбирает вставленный из чата ответ и заполняет форму расчёта. */
function applyPasted() {
  const box = $('#pasteBox');
  const out = $('#pasteResult');
  if (!box) return;
  try {
    const parsed = parsePastedCar(box.value);
    const filled = Object.keys(parsed.fields).filter((k) => k !== 'notes_combined');
    if (!filled.length) throw new Error('в тексте не нашлось ни одного знакомого поля');

    applyExtraction(parsed);

    const shown = ['make', 'model', 'year', 'volume_cc', 'power_hp', 'power_kw', 'price_value']
      .filter((k) => parsed.fields[k] != null)
      .map((k) => esc(String(parsed.fields[k]))).join(' · ');
    out.innerHTML =
      '<div class="extract-warning" style="border-left-color:#1f9d57;background:rgba(39,174,96,.10)">' +
      '✅ Заполнено полей: ' + filled.length + (shown ? '<br>' + shown : '') + '</div>' +
      (parsed.warnings || []).map((w) => '<div class="extract-warning">⚠️ ' + esc(w) + '</div>').join('');

    haptic('medium');
    showScreen('screenCalc');
    toast('Форма заполнена — проверьте отмеченные поля и нажмите «Рассчитать»');
  } catch (e) {
    out.innerHTML = '<div class="extract-warning">⛔ ' + esc(e.message) + '</div>';
  }
}

/* Один путь для всех способов выбора скрина: файл, буфер, перетаскивание. */
function setExtractPhoto(file, how) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    toast('Это не картинка');
    return;
  }
  extractFile = file;
  // без ключа ИИ распознавать нечем, но скрин всё равно нужен —
  // он прикрепится к карточке при сохранении в базу
  pendingCarPhoto = file;

  const img = $('#extractPreview');
  const reader = new FileReader();
  reader.onload = () => {
    if (!img) return;
    img.src = reader.result;
    img.classList.remove('hidden');
    const dt = $('#extractDropText');
    if (dt) dt.classList.add('hidden');
  };
  reader.readAsDataURL(file);

  const runBtn = $('#btnExtractRun');
  if (runBtn) runBtn.disabled = false;
  const note = $('#extractPhotoNote');
  if (note) {
    const kb = Math.round(file.size / 1024);
    note.textContent = '📎 Скрин' + (how ? ' (' + how + ')' : '') +
      ' — ' + kb + ' КБ, прикрепится к карточке при сохранении в базу.';
  }
  const rev = $('#extractReview');
  if (rev) rev.classList.add('hidden');
  haptic('light');
}

/* Кнопка «из буфера»: читаем буфер напрямую. Работает не везде —
 * нужен защищённый контекст и разрешение, поэтому падение не фатально,
 * подсказываем горячие клавиши. */
async function pasteImageFromClipboard(btn) {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    toast('Браузер не даёт читать буфер — нажмите Cmd+V (Ctrl+V) прямо здесь');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = (item.types || []).find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        const ext = type.split('/')[1] || 'png';
        setExtractPhoto(new File([blob], 'screenshot.' + ext, { type }), 'из буфера');
        return;
      }
    }
    toast('В буфере нет картинки — сначала сделайте скриншот');
  } catch (e) {
    toast('Не вышло прочитать буфер — нажмите Cmd+V (Ctrl+V) прямо здесь');
  }
}

function resetExtractScreen() {
  extractFile = null;
  lastExtraction = null;
  currentExtractionId = null;
  pendingCarPhoto = null;
  const pb = $('#pasteBox'); if (pb) pb.value = '';
  const pr = $('#pasteResult'); if (pr) pr.innerHTML = '';
  const pn = $('#extractPhotoNote'); if (pn) pn.textContent = '';
  const fi = $('#extractFile'); if (fi) fi.value = '';
  const img = $('#extractPreview'); if (img) { img.classList.add('hidden'); img.src = ''; }
  const dt = $('#extractDropText'); if (dt) dt.classList.remove('hidden');
  const btn = $('#btnExtractRun'); if (btn) btn.disabled = true;
  const url = $('#extractDromUrl'); if (url) url.value = '';
  const rev = $('#extractReview'); if (rev) rev.classList.add('hidden');
}

async function runExtraction() {
  if (!extractFile) { toast('Выберите фото'); return; }
  if (!wtAvailable()) { toast('Распознавание работает только внутри Telegram'); return; }

  const btn = $('#btnExtractRun');
  btn.disabled = true; btn.textContent = '⏳ Распознаю…';
  try {
    const dromUrl = (($('#extractDromUrl') || {}).value || '').trim();
    const res = await wtApi.extract(extractFile, { country: state.country, dromUrl: dromUrl || undefined });
    lastExtraction = res;
    currentExtractionId = res.extraction_id;
    renderExtractReview(res);
    haptic('medium');
  } catch (e) {
    toast('Не удалось распознать: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '🔎 Распознать';
  }
}

function renderExtractReview(res) {
  const f = res.fields || {};
  const conf = res.confidence || {};

  const rows = EXTRACT_FIELD_LABELS
    .filter(([k]) => f[k] != null && f[k] !== '')
    .map(([k, label]) => {
      const c = conf[k];
      const low = typeof c === 'number' && c < LOW_CONF;
      return '<div class="extract-row"><span class="k">' + esc(label) + '</span>' +
        '<span class="v' + (low ? ' low-conf' : '') + '">' + esc(f[k]) + (low ? ' ⚠️' : '') +
        '</span></div>';
    }).join('');

  const priceRow = f.price_value != null
    ? '<div class="extract-row"><span class="k">Цена</span><span class="v">' +
      fmtNum(f.price_value) + ' ' + esc(f.price_currency || '') + '</span></div>'
    : '';

  $('#extractSummary').innerHTML = (rows + priceRow) ||
    '<p class="hint">Ничего не распознано — заполните карточку вручную.</p>';

  $('#extractWarnings').innerHTML = (res.warnings || [])
    .map((w) => '<div class="extract-warning">⚠️ ' + esc(w) + '</div>').join('');

  $('#extractReview').classList.remove('hidden');
}

/* =========================================================================
 *  Возраст авто — то, от чего пошлина зависит сильнее всего.
 *
 *  Граница между категориями стоит дорого: для 1500 см³ «3-5 лет» — это
 *  1.7 €/см³, а «5-7» — уже 3.2 €/см³, почти вдвое. Поэтому месяц выпуска
 *  нельзя домысливать: у авто 2021 года январский и октябрьский выпуск
 *  сегодня попадают в РАЗНЫЕ категории.
 * ========================================================================= */

const MONTHS_NOM = ['январь','февраль','март','апрель','май','июнь',
                    'июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const MONTHS_SHORT = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

function _bandForAgeMonths(months, isElectric) {
  const years = Math.max(0, months) / 12;
  if (isElectric) return years < 3 ? '<3' : '>3';
  if (years < 3) return '<3';
  if (years < 5) return '3-5';
  if (years < 7) return '5-7';
  return '>7';
}

/* Подробности по возрасту: категория, точный возраст, дата перехода
 * в следующую категорию и признак неоднозначности, если месяц не указан. */
function ageInfo(year, month, isElectric) {
  if (!year) return null;
  if (isElectric === undefined) isElectric = state.isElectric;

  const now = new Date();
  const nowIdx = now.getFullYear() * 12 + (now.getMonth() + 1);
  const bandFor = (m) => _bandForAgeMonths(nowIdx - (year * 12 + m), isElectric);

  if (!month) {
    // Январь даёт самое старое авто, декабрь — самое молодое. Если категории
    // расходятся, угадывать нельзя: разница в пошлине — сотни тысяч.
    const oldest = bandFor(1), youngest = bandFor(12);
    if (oldest !== youngest) {
      let cut = 12;
      for (let m = 1; m <= 12; m++) { if (bandFor(m) !== oldest) { cut = m; break; } }
      return { ambiguous: true, band: oldest, bandYoung: youngest, cutMonth: cut, year };
    }
    return { ambiguous: false, band: oldest, ageMonths: nowIdx - (year * 12 + 6), approx: true };
  }

  const ageMonths = Math.max(0, nowIdx - (year * 12 + month));
  const band = _bandForAgeMonths(ageMonths, isElectric);

  // ближайший порог, который авто ещё не перешло
  const thresholds = isElectric ? [36] : [36, 60, 84];
  const next = thresholds.find((t) => ageMonths < t);
  let boundary = null;
  if (next != null) {
    const absolute = (year * 12 + month) + next;            // месяц-индекс перехода
    boundary = {
      monthsLeft: next - ageMonths,
      year: Math.floor((absolute - 1) / 12),
      month: ((absolute - 1) % 12) + 1,
      nextBand: _bandForAgeMonths(next, isElectric),
    };
  }
  return { ambiguous: false, band, ageMonths, boundary };
}

/* Обратная совместимость: только категория. */
function ageBandFrom(year, month) {
  const info = ageInfo(year, month);
  return info ? info.band : null;
}

function ageWord(months) {
  const y = Math.floor(months / 12), m = months % 12;
  const yw = y === 0 ? '' : y + ' ' + (y % 10 === 1 && y % 100 !== 11 ? 'год'
    : (y % 10 >= 2 && y % 10 <= 4 && (y % 100 < 10 || y % 100 >= 20) ? 'года' : 'лет'));
  const mw = m === 0 ? '' : m + ' мес.';
  return [yw, mw].filter(Boolean).join(' ') || 'меньше месяца';
}

/* Год или месяц изменились: подставляем категорию, но только если она
 * однозначна. При неоднозначности поле не трогаем — пусть решает человек,
 * а подсказка объяснит, почему. */
function syncAgeFromYear() {
  const year = parseInt(($('#year') || {}).value, 10);
  const monthEl = $('#monthOut');
  const month = monthEl && monthEl.value ? parseInt(monthEl.value, 10) : null;
  const info = year ? ageInfo(year, month) : null;
  if (info && !info.ambiguous && $('#age')) {
    const has = Array.prototype.some.call($('#age').options, (o) => o.value === info.band);
    if (has) $('#age').value = info.band;
  }
  renderAgeHint();
}

/* Подсказка под полем «Возраст авто». Показывает, на чём основана категория
 * и когда она поменяется — чтобы граница не всплыла сюрпризом на таможне. */
function renderAgeHint() {
  const el = $('#ageHint');
  if (!el) return;
  const year = parseInt(($('#year') || {}).value, 10);
  const monthEl = $('#monthOut');
  const month = monthEl && monthEl.value ? parseInt(monthEl.value, 10) : null;

  if (!year) {
    el.innerHTML = '<span style="color:var(--hint)">Укажите год выпуска — категория подставится сама.</span>';
    return;
  }
  const info = ageInfo(year, month);
  if (!info) { el.textContent = ''; return; }

  const BAND_RU = { '<3': 'до 3 лет', '3-5': '3–5 лет', '5-7': '5–7 лет', '>7': 'старше 7', '>3': 'старше 3' };

  if (info.ambiguous) {
    const cut = info.cutMonth;
    const first = MONTHS_NOM[0], last = MONTHS_NOM[11];
    const leftEnd = MONTHS_NOM[cut - 2];        // последний месяц старой категории
    const rightStart = MONTHS_NOM[cut - 1];     // первый месяц новой
    el.innerHTML =
      '<span style="color:#e6a23c">⚠️ Месяц не указан, а ' + info.year +
      ' год — переходный.</span><br>' +
      'Выпуск ' + first + '–' + leftEnd + ' → категория <b>' + BAND_RU[info.band] + '</b>, ' +
      rightStart + '–' + last + ' → <b>' + BAND_RU[info.bandYoung] + '</b>. ' +
      'Разница в пошлине существенная — укажите месяц.';
    return;
  }

  let html = 'Возраст: <b>' + ageWord(info.ageMonths) + '</b> → категория <b>' + BAND_RU[info.band] + '</b>.';
  if (info.approx) {
    html += ' <span style="color:var(--hint)">Месяц не указан, но в этом году он на категорию не влияет.</span>';
  }
  if (info.boundary) {
    const b = info.boundary;
    const when = MONTHS_SHORT[b.month - 1] + ' ' + b.year;
    const soon = b.monthsLeft <= 6;
    html += '<br>' + (soon ? '<span style="color:#e6a23c">⏳ ' : '<span style="color:var(--hint)">') +
      'Через ' + ageWord(b.monthsLeft) + ' (' + when + ') перейдёт в <b>' + BAND_RU[b.nextBand] + '</b>' +
      (b.nextBand === '<3' ? '' : ' — пошлина вырастет') + '.</span>';
  }
  el.innerHTML = html;
}

/* заполнить форму калькулятора и характеристик по результату распознавания */
function applyExtraction(x) {
  const f = x.fields || {};
  const conf = x.confidence || {};

  if (f.country && f.country !== state.country) state.country = f.country;
  if (f.fuel === 'ev' && !state.isElectric) {
    state.isElectric = true;
    state.powerUnit = 'kw';
    if ($('#isElectric')) $('#isElectric').checked = true;
  }
  renderCountry();
  syncPowerUnit();

  const setVal = (sel, val, confKey) => {
    const el = $(sel);
    if (!el || val == null || val === '') return;
    el.value = val;
    if (confKey && typeof conf[confKey] === 'number' && conf[confKey] < LOW_CONF) el.classList.add('needs-check');
    else el.classList.remove('needs-check');
  };

  setVal('#monthOut', f.month, 'month');
  const band = ageBandFrom(f.year, f.month);
  if (band && $('#age') && Array.prototype.some.call($('#age').options, (o) => o.value === band)) {
    $('#age').value = band;
  }

  setVal('#volume', f.volume_cc, 'volume_cc');
  setVal('#power', state.isElectric ? f.power_kw : f.power_hp, state.isElectric ? 'power_kw' : 'power_hp');

  const carCurrency = { jp: 'JPY', kr: 'KRW', cn: 'CNY' }[state.country];
  const extraWarnings = [];
  if (f.price_value != null) {
    if (f.price_currency === carCurrency) setVal('#carPrice', Math.round(f.price_value), 'price_value');
    else extraWarnings.push('Цена распознана в валюте ' + (f.price_currency || '?') + ' — впишите вручную.');
  }

  // Аукцион — только Япония без санкций: та же логика сопоставления, что в
  // applyFieldInputs(app.js) — по совпадению видимого текста опции.
  if (state.country === 'jp' && !state.isSanctioned && f.auction_name && $('#auction')) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
    const target = norm(f.auction_name);
    let matched = -1;
    Array.prototype.forEach.call($('#auction').options, (o, i) => {
      if (matched === -1 && o.value !== '' && norm(o.text) === target) matched = i;
    });
    if (matched >= 0) {
      $('#auction').selectedIndex = matched;
      $('#delivery').value = CALC_DATA.auctions[matched].fob;
    }
  }
  updateDelivery();

  setVal('#make', f.make, 'make');
  setVal('#model', f.model, 'model');
  setVal('#trimName', f.trim, 'trim');
  setVal('#year', f.year, 'year');
  setVal('#mileage', f.mileage_km, 'mileage_km');
  setVal('#body', f.body, 'body');
  setVal('#drive', f.drive, 'drive');
  setVal('#trans', f.transmission, 'transmission');
  if (!state.isElectric) setVal('#fuel', f.fuel, 'fuel');
  renderAgeHint();
  setVal('#color', f.color, 'color');
  setVal('#grade', f.auction_grade, 'auction_grade');
  setVal('#interiorGrade', f.interior_grade, 'interior_grade');
  setVal('#lotNo', f.lot_number, 'lot_number');
  if (f.drom_url) { const el = $('#dromUrl'); if (el && !el.value) el.value = f.drom_url; }

  // рукописные заметки/повреждения/опции с листа — в то же поле, что и ручной ввод
  const noteParts = [];
  if (f.inspector_notes_ru) noteParts.push(f.inspector_notes_ru);
  if (Array.isArray(f.damage_notes) && f.damage_notes.length) noteParts.push('Повреждения: ' + f.damage_notes.join('; '));
  if (Array.isArray(f.equipment) && f.equipment.length) noteParts.push('Опции: ' + f.equipment.join(', '));
  if (noteParts.length) {
    const notesEl = $('#vehicleNotes');
    if (notesEl && !notesEl.value) notesEl.value = noteParts.join('\n');
  }

  persistInputs();

  const allWarnings = (x.warnings || []).concat(extraWarnings);
  if (allWarnings.length) toast('Проверьте: ' + allWarnings[0]);
}

function bindExtractEvents() {
  const screen = $('#screenExtract');
  if (!screen) return;

  const fileInput = $('#extractFile');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) setExtractPhoto(file);
    });
  }

  // Cmd+V / Ctrl+V прямо на экране: скриншот из буфера, без сохранения на диск.
  // Слушаем на всём экране, а не только на поле — фокус чаще всего в textarea.
  screen.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.kind === 'file' && String(it.type).startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();   // иначе картинка попробует вставиться в textarea
          setExtractPhoto(f, 'из буфера');
          return;
        }
      }
    }
  });

  const pasteImgBtn = $('#btnPasteImage');
  if (pasteImgBtn) pasteImgBtn.addEventListener('click', () => pasteImageFromClipboard(pasteImgBtn));

  // перетаскивание файла на область — удобно с рабочего стола
  const drop = $('#extractDrop');
  if (drop) {
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('upload-drop-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('upload-drop-over');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && String(f.type).startsWith('image/')) setExtractPhoto(f, 'перетаскиванием');
    });
  }

  const run = $('#btnExtractRun'); if (run) run.addEventListener('click', runExtraction);
  const paste = $('#btnPasteApply'); if (paste) paste.addEventListener('click', applyPasted);
  const cp = $('#btnCopyExtractPrompt');
  if (cp) cp.addEventListener('click', () => copyExtractPrompt(cp));
  const back = $('#btnExtractBack'); if (back) back.addEventListener('click', () => showScreen('screenCalc'));
  const cancel = $('#btnExtractCancel');
  if (cancel) cancel.addEventListener('click', () => {
    $('#extractReview').classList.add('hidden');
    lastExtraction = null;
    currentExtractionId = null;
  });
  const apply = $('#btnExtractApply');
  if (apply) apply.addEventListener('click', () => {
    if (!lastExtraction) return;
    applyExtraction(lastExtraction);
    showScreen('screenCalc');
    toast('Форма заполнена — проверьте отмеченные поля и рассчитайте');
  });
}

/* --- пакетный импорт из CSV --- */

let importParsed = null;   // [{lineNo, vehicle, input, errors, warnings, result}]

function resetImportScreen() {
  importParsed = null;
  const fi = $('#importFile'); if (fi) fi.value = '';
  const dt = $('#importDropText'); if (dt) dt.textContent = '📊 Выбрать CSV';
  ['#importPreview', '#importResult'].forEach((s) => {
    const el = $(s); if (el) el.classList.add('hidden');
  });
}

async function handleImportFile(file) {
  try {
    const data = await readImportFile(file);   // CSV → строка, XLSX → строки
    const { parsed, unknownColumns } = parseImport(data);

    // считаем каждую строку настоящим движком — сразу видно итог «под ключ»
    parsed.forEach((p) => {
      if (p.errors.length) return;
      try {
        p.result = calculate(p.input, cfg);
      } catch (e) {
        p.errors.push('расчёт не выполнился: ' + e.message);
      }
    });

    importParsed = parsed;
    renderImportPreview(unknownColumns);
    $('#importDropText').textContent = '📊 ' + esc(file.name);
  } catch (e) {
    toast('Не удалось разобрать файл: ' + e.message);
    resetImportScreen();
  }
}

function renderImportPreview(unknownColumns) {
  const ok = importParsed.filter((p) => !p.errors.length);
  const bad = importParsed.filter((p) => p.errors.length);

  $('#importCount').textContent = `${ok.length} готовы, ${bad.length} с ошибками`;

  const issues = [];
  if (unknownColumns && unknownColumns.length) {
    issues.push('<div class="extract-warning">⚠️ Неизвестные колонки (пропущены): ' +
      esc(unknownColumns.join(', ')) + '</div>');
  }
  bad.forEach((p) => {
    issues.push('<div class="extract-warning">⛔ Строка ' + p.lineNo + ': ' +
      esc(p.errors.join('; ')) + '</div>');
  });
  ok.forEach((p) => {
    if (p.warnings.length) {
      issues.push('<div class="extract-warning">⚠️ Строка ' + p.lineNo + ': ' +
        esc(p.warnings.join('; ')) + '</div>');
    }
  });
  $('#importIssues').innerHTML = issues.join('');

  $('#importRows').innerHTML = ok.map((p) => {
    const r = p.result;
    const util = r.utilPreferentialApplied
      ? '<span class="badge badge-good">льгота</span>'
      : '<span class="badge badge-warn">утиль ' + money(r.utilFee) + '</span>';
    return '<div class="extract-row">' +
      '<span class="k">' + (FLAG[p.input.country] || '') + ' ' +
      esc([p.vehicle.make, p.vehicle.model].filter(Boolean).join(' ')) +
      (p.vehicle.year ? ' ' + p.vehicle.year : '') + '</span>' +
      '<span class="v">' + money(r.grandTotal) + ' ' + util + '</span></div>';
  }).join('') || '<p class="hint">Нет строк, готовых к импорту.</p>';

  $('#btnImportRun').disabled = ok.length === 0;
  $('#btnImportRun').textContent = ok.length
    ? `Импортировать ${ok.length}` : 'Нечего импортировать';
  $('#importPreview').classList.remove('hidden');
  $('#importResult').classList.add('hidden');
}

async function runImport() {
  if (!importParsed) return;
  if (!wtAvailable()) { toast('База работает только внутри Telegram'); return; }

  const ok = importParsed.filter((p) => !p.errors.length && p.result);
  const btn = $('#btnImportRun');
  btn.disabled = true;

  const rates = ratesSnapshot();
  const done = [];
  const failed = [];

  for (let i = 0; i < ok.length; i++) {
    const p = ok[i];
    btn.textContent = `⏳ ${i + 1} из ${ok.length}…`;
    try {
      // последовательно, а не Promise.all: пачка параллельных запросов с
      // телефона легко упирается в лимит nginx, а выигрыш тут не нужен
      const car = await wtApi.createCar({
        vehicle: p.vehicle,
        calc_input: p.input,
        calc_result: p.result,
        rates,
      });
      done.push({ line: p.lineNo, car });
    } catch (e) {
      failed.push({ line: p.lineNo, error: e.message });
    }
  }

  $('#importResultBody').innerHTML =
    '<div class="extract-row"><span class="k">Загружено</span><span class="v">' +
      done.length + ' из ' + ok.length + '</span></div>' +
    failed.map((f) => '<div class="extract-warning">⛔ Строка ' + f.line + ': ' +
      esc(f.error) + '</div>').join('');
  $('#importResult').classList.remove('hidden');
  $('#importPreview').classList.add('hidden');

  baseState.items = [];   // список в базе устарел
  haptic('medium');
  toast(done.length ? `Загружено ${done.length} авто` : 'Не удалось загрузить ни одной строки');
  btn.disabled = false;
}

function bindImportEvents() {
  const screen = $('#screenImport');
  if (!screen) return;

  const fileInput = $('#importFile');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleImportFile(f);
    });
  }
  const back = $('#btnImportBack');
  if (back) back.addEventListener('click', () => showScreen('screenCalc'));
  const cancel = $('#btnImportCancel');
  if (cancel) cancel.addEventListener('click', resetImportScreen);
  const run = $('#btnImportRun');
  if (run) run.addEventListener('click', runImport);
}

/* --- фильтры --- */
function readFilter() {
  const v = (sel) => { const el = $(sel); return el && el.value !== '' ? el.value : undefined; };
  const n = (sel) => { const x = v(sel); if (x === undefined) return undefined;
    const p = parseInt(String(x).replace(/[^\d]/g, ''), 10); return isNaN(p) ? undefined : p; };

  const f = {
    price_min: n('#fPriceMin'),
    price_max: n('#fPriceMax'),
    year_min: n('#fYearMin'),
    year_max: n('#fYearMax'),
    mileage_max: n('#fMileageMax'),
    body: v('#fBody'),
    drive: v('#fDrive'),
    transmission: v('#fTrans'),
    country: v('#fCountry'),
    q: v('#fQ'),
    status: v('#fStatus') || 'active',
    sort: v('#fSort') || 'created_at',
  };
  if ($('#fUtilPref') && $('#fUtilPref').checked) f.util_pref = true;
  f.order = f.sort === 'created_at' ? 'desc' : 'asc';
  return f;
}

function saveFilter(f) {
  try { localStorage.setItem(BASE_FILTER_KEY, JSON.stringify(f)); } catch (e) {}
}
function restoreFilter() {
  let f = {};
  try { f = JSON.parse(localStorage.getItem(BASE_FILTER_KEY)) || {}; } catch (e) {}
  const set = (sel, val) => { const el = $(sel); if (el && val != null) el.value = val; };
  set('#fPriceMin', f.price_min); set('#fPriceMax', f.price_max);
  set('#fYearMin', f.year_min); set('#fYearMax', f.year_max);
  set('#fMileageMax', f.mileage_max);
  set('#fBody', f.body); set('#fDrive', f.drive); set('#fTrans', f.transmission);
  set('#fCountry', f.country); set('#fStatus', f.status); set('#fSort', f.sort);
  if ($('#fUtilPref')) $('#fUtilPref').checked = !!f.util_pref;
  return f;
}

async function loadBase() {
  if (baseState.loading) return;
  baseState.loading = true;
  const listEl = $('#baseList');
  if (listEl) listEl.innerHTML = '<p class="hint">Загружаю…</p>';

  // Всё внутри try: если сборка фильтра бросит исключение, флаг loading
  // останется поднятым и экран зависнет на «Загружаю…» уже навсегда,
  // потому что повторный вызов выйдет по проверке в начале функции.
  try {
    const f = readFilter();
    saveFilter(f);
    const data = await wtApi.listCars(Object.assign({ limit: 100 }, f));
    baseState.items = data.items;
    baseState.total = data.total;
    renderBaseList();
  } catch (e) {
    if (listEl) {
      listEl.innerHTML =
        '<div class="extract-warning">⛔ Не удалось загрузить базу.<br>' + esc(e.message) + '</div>' +
        '<button class="primary-btn" id="btnRetryBase" type="button" style="width:100%;margin-top:8px">' +
        '↻ Повторить</button>';
    }
  } finally {
    baseState.loading = false;
  }
}

/* Курс, по которому посчитана карточка. Возвращает null, если снимок
 * совпадает с текущим — тогда метку показывать незачем. */
function rateStaleness(c) {
  const snap = (c.rates_snapshot || {}).market || {};
  const now = cfg.rates.market || {};
  const key = { jp: 'JPY100_ATB', kr: 'KRW1000', cn: 'CNY' }[c.country];
  if (!key || snap[key] == null || now[key] == null) return null;
  const was = Number(snap[key]), is = Number(now[key]);
  if (!was || !is || was === is) return null;
  const diffPct = ((is - was) / was) * 100;
  return { was, is, diffPct, date: (c.rates_snapshot || {}).cbr_date || null };
}

function carCardHtml(c) {
  // 320 px хватает на превью 92×70 даже на экране с тройной плотностью
  const photos = c.photos || [];
  const photo = photos[0] ? wtApi.photoUrl(photos[0].url, 320) : null;
  const specs = [
    c.year, kmFmt(c.mileage_km),
    c.volume_cc ? (c.volume_cc / 1000).toFixed(1) + ' л' : null,
    c.power_hp ? c.power_hp + ' л.с.' : null,
    BODY_RU[c.body] || c.body, c.drive, c.transmission,
    c.is_electric ? FUEL_RU.ev : (FUEL_RU[c.fuel] || c.fuel),
  ].filter(Boolean).join(' · ');

  const utilBadge = c.util_preferential === true
    ? '<span class="badge badge-good">льготный утиль</span>'
    : (c.util_preferential === false
        ? '<span class="badge badge-warn">утиль ' + money(c.util_fee) + '</span>' : '');
  const statusBadge = c.status !== 'active'
    ? '<span class="badge">' + esc(c.status) + '</span>' : '';

  // цена в валюте — то, что зафиксировано сделкой; рубли зависят от курса
  const CUR_SIGN = { JPY: '¥', KRW: '₩', CNY: '¥' };
  const foreign = c.price_foreign
    ? '<div class="car-foreign">' + fmtNum(c.price_foreign) + ' ' +
      esc(CUR_SIGN[c.currency] || c.currency || '') + '</div>'
    : '';

  const stale = rateStaleness(c);
  const staleBadge = stale
    ? '<span class="badge badge-stale" title="Курс изменился с момента расчёта">' +
      'курс ' + (stale.diffPct > 0 ? '+' : '') + stale.diffPct.toFixed(1) + '%</span>'
    : '';

  const checked = baseState.selected.has(c.id) ? ' checked' : '';

  return (
    '<div class="car-card' + (checked ? ' car-card-sel' : '') + '" data-car-id="' + c.id + '">' +
      '<input type="checkbox" class="car-pick" data-pick="' + c.id + '"' + checked +
        ' title="Отметить для подборки">' +
      (photo
        ? '<div class="car-thumb-wrap" data-act="orig" data-id="' + c.id + '" title="Скопировать оригинал в буфер">' +
            // Без loading="lazy": список рисуется, пока экран ещё скрыт, и в WebView
            // Telegram отложенные картинки для части карточек так и не запрашивались —
            // фото появлялось лишь у двух-трёх. Миниатюра весит ~15 КБ, откладывать нечего.
            '<img class="car-thumb" src="' + esc(photo) + '" alt="" width="92" height="70" decoding="async">' +
            (photos.length > 1 ? '<span class="car-thumb-count">' + photos.length + '</span>' : '') +
          '</div>'
        : '<div class="car-thumb car-thumb-empty">📷</div>') +
      '<div class="car-body">' +
        '<div class="car-title">' + (FLAG[c.country] || '') + ' ' +
          esc(c.title || [c.make, c.model].filter(Boolean).join(' ') || 'без названия') + '</div>' +
        '<div class="car-specs">' + esc(specs) + '</div>' +
        '<div class="car-price">' + money(c.price_rub_total) +
          '<span class="car-price-cap"> под ключ</span></div>' +
        foreign +
        '<div class="car-badges">' + utilBadge + staleBadge + statusBadge + '</div>' +
        '<div class="car-actions">' +
          '<button class="mini-btn" data-act="image" data-id="' + c.id + '">🖼 Расчёт</button>' +
          '<button class="mini-btn" data-act="offer" data-id="' + c.id + '">📄 Клиенту</button>' +
          '<button class="mini-btn" data-act="photos" data-id="' + c.id + '">📷 Фото</button>' +
          '<button class="mini-btn" data-act="del" data-id="' + c.id + '">🗑</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

/* =========================================================================
 *  Подборка: выбрал карточки → скопировал текстом → вставил в GPT → пост.
 *
 *  Формат намеренно человекочитаемый, а не JSON: модель по нему пишет
 *  живее, да и глазами проверить проще перед отправкой.
 * ========================================================================= */

/* Лимит подписи к медиа в Telegram — 1024 видимых символа (теги не в счёт).
 * PublioSMM считает ровно так (telegram_service.CAPTION_LIMIT) и, если текст
 * длиннее, отправляет его ОТДЕЛЬНЫМ сообщением — пост отрывается от фото.
 * Поэтому для поста с альбомом это жёсткая граница, а не пожелание. */
const TG_CAPTION_LIMIT = 1024;
const TG_MESSAGE_LIMIT = 4096;

function formatRules(fmt) {
  if (fmt === 'md') {
    return [
      'ФОРМАТ ОТВЕТА',
      'Верни ТОЛЬКО готовый пост целиком, одним блоком кода.',
      'Ни вступления, ни пояснений, ни комментариев после — я копирую',
      'содержимое блока и публикую как есть.',
      '',
      'Весь пост размечен в MarkdownV2 (Telegram):',
      '- *жирный*, _курсив_, цитата — строка, начинающаяся с «>»;',
      '- спецсимволы вне разметки экранируй обратным слэшем:',
      '  . - ! ( ) + = # | { } ~ ` > _ *  — иначе Telegram не примет пост;',
      '- в числах и датах точки и дефисы тоже экранируются: 1\\.5, 2021\\-й;',
      '- HTML-теги не используй вообще.',
    ].join('\n');
  }
  return [
    'ФОРМАТ ОТВЕТА',
    'Верни ТОЛЬКО готовый пост целиком, одним блоком кода.',
    'Ни вступления, ни пояснений, ни комментариев после — я копирую',
    'содержимое блока и публикую как есть, без правок.',
    '',
    'ВЕСЬ ПОСТ — РАЗМЕЧЕННЫЙ HTML для Telegram. Не Markdown.',
    'Разрешённые теги, других нет:',
    '  <b>жирный</b>, <i>курсив</i>, <u>подчёркнутый</u>, <s>зачёркнутый</s>,',
    '  <a href="ссылка">текст</a>, <code>моноширинный</code>,',
    '  <blockquote>цитата</blockquote>',
    '',
    '- НЕ используй Markdown: ни **звёздочки**, ни ## заголовки, ни _подчерки_.',
    '  В Telegram они останутся видимым мусором;',
    '- НЕ используй <p>, <br>, <div>, <ul>, <li>, <h1>: Telegram их не понимает',
    '  и покажет как текст. Абзацы и списки делай обычными переносами строк,',
    '  списки — через эмодзи или дефис в начале строки;',
    '- символы < > & вне тегов экранируй: &lt; &gt; &amp;;',
    '- ВАЖНО про цитату: пиши <blockquote>текст</blockquote> без пробелов',
    '  и переносов сразу после открывающего и перед закрывающим тегом,',
    '  и без пустой строки перед цитатой — иначе в посте появится лишний',
    '  отступ. Нужный перенос система добавит сама.',
  ].join('\n');
}

function postPrompt(fmt, withPhoto) {
  const limit = withPhoto ? TG_CAPTION_LIMIT : TG_MESSAGE_LIMIT;
  const lenRule = withPhoto
    ? 'ДЛИНА: не больше ' + limit + ' знаков видимого текста (теги не считаются).\n' +
      'Это лимит подписи к фотоальбому: если превысить, текст оторвётся от фото\n' +
      'и уйдёт отдельным сообщением. Уложись с запасом — целься в 900.'
    : 'ДЛИНА: не больше ' + limit + ' знаков (лимит сообщения Telegram).\n' +
      'Пост без фото, поэтому места достаточно — но не растекайся, целься в 2000.';

  return [
    'Напиши пост-подборку для Telegram-канала об автомобилях под заказ из Японии.',
    'Компания WESTTRANSIT (WT), Владивосток: привозим авто под ключ до города клиента.',
    'Пост публикуется через сервис автопостинга, поэтому важен точный формат.',
    '',
    formatRules(fmt),
    '',
    lenRule,
    '',
    'Требования к посту:',
    '- живой текст, без канцелярита и без «уважаемые клиенты»;',
    '- начни с цепляющей строки: для кого эта подборка и в каком бюджете;',
    '- по каждой машине 2–3 строки: чем хороша и кому подойдёт;',
    '- модель и цену «под ключ» выделяй жирным, цена — финальная сумма до города;',
    '- вставь одну цитату: в неё вынеси главный аргумент подборки',
    '  (например, про льготный утильсбор или про разброс цен);',
    '- если у машины отмечен льготный утильсбор — это сильный довод,',
    '  обыграй: мощность до 160 л.с. экономит сотни тысяч на утиле;',
    '- в конце короткий призыв написать в личку за подбором;',
    '- эмодзи умеренно, 1–2 на машину;',
    '- не выдумывай характеристики, которых нет в данных ниже.',
    '',
    'Учти: во ВКонтакте разметка вырезается и остаётся голый текст,',
    'поэтому смысл не должен держаться на жирном и цитатах — читаться',
    'должно и без них.',
    '',
    'Данные:',
    '',
  ].join('\n');
}

function carToPostLines(c, idx) {
  const L = [];
  // Комплектация участвует в названии всегда: пустая графа читается как
  // недоработка, а BASE — принятое обозначение базовой версии.
  const trim = (c.trim && String(c.trim).trim()) || 'BASE';
  const title = [c.make, c.model, trim].filter(Boolean).join(' ') || c.title || 'Авто';
  const when = c.year ? (c.year + (c.month ? ' (' + String(c.month).padStart(2, '0') + ')' : '')) : '';
  L.push(`${idx}. ${title}${when ? ', ' + when : ''}`);

  // всё по-русски: текст уходит в GPT и дальше в пост, коды вроде FWD там лишние
  const spec = [
    BODY_RU[c.body] || c.body,
    DRIVE_RU[c.drive] || c.drive,
    TRANS_RU[c.transmission] || c.transmission,
    c.is_electric ? 'электро' : (FUEL_RU[c.fuel] || c.fuel),
  ].filter(Boolean).join(' · ');
  if (spec) L.push('   ' + spec);

  const tech = [
    c.mileage_km != null ? 'пробег ' + fmtNum(c.mileage_km) + ' км' : null,
    // объём без разделителя разрядов: «1500 см³» читается привычнее, чем «1 500»
    c.volume_cc ? c.volume_cc + ' см³' : null,
    c.power_hp ? c.power_hp + ' л.с.' : null,
  ].filter(Boolean).join(' · ');
  if (tech) L.push('   ' + tech);

  if (c.auction_grade) L.push('   оценка аукциона ' + c.auction_grade +
    (c.interior_grade ? ', салон ' + c.interior_grade : ''));

  // город отдельной строкой: склонять его в «до ...» на клиенте нечем
  L.push('   ЦЕНА ПОД КЛЮЧ: ' + money(c.price_rub_total));
  if (c.logistics_city) L.push('   город доставки: ' + c.logistics_city);

  if (c.util_preferential === true) {
    L.push('   ✅ льготный утильсбор ' + money(c.util_fee) + ' — мощность в пределах 160 л.с.');
  } else if (c.util_preferential === false && c.util_fee) {
    L.push('   утильсбор ' + money(c.util_fee) + ' (мощность выше льготного порога)');
  }
  return L.join('\n');
}

function buildSelectionText(cars, withPrompt, opts) {
  opts = opts || {};
  const date = new Date().toLocaleDateString('ru-RU');
  const head = `Подборка на ${date}, ${cars.length} шт. Цены «под ключ» в рублях.\n\n`;
  const body = cars.map((c, i) => carToPostLines(c, i + 1)).join('\n\n');
  if (!withPrompt) return head + body + '\n';
  const fmt = opts.format || 'html';
  const withPhoto = opts.withPhoto !== false;
  return postPrompt(fmt, withPhoto) + head.trim() + '\n\n' + body + '\n';
}

/* =========================================================================
 *  КП клиенту по одной машине.
 *
 *  Отличается от поста в канал по существу: каналу нужен крючок, клиенту —
 *  доверие. Поэтому здесь разбивка цены и этапы оплаты: по GTM-документу
 *  главная боль рынка — страх «кинут» и скрытые доплаты, и прозрачная
 *  смета закрывает её лучше любых обещаний.
 *
 *  Обычный текст, без разметки: уходит в личку через любой мессенджер,
 *  а HTML там не отрисуется.
 * ========================================================================= */
function buildClientOffer(car) {
  const r = car.calc_result || {};
  const L = [];
  const trim = (car.trim && String(car.trim).trim()) || 'BASE';
  const when = car.year ? car.year + (car.month ? ' (' + String(car.month).padStart(2, '0') + ')' : '') : '';

  L.push('🚗 ' + [car.make, car.model, trim].filter(Boolean).join(' ') + (when ? ', ' + when : ''));

  const spec = [
    BODY_RU[car.body] || car.body,
    DRIVE_RU[car.drive] || car.drive,
    TRANS_RU[car.transmission] || car.transmission,
    car.is_electric ? 'электро' : (FUEL_RU[car.fuel] || car.fuel),
  ].filter(Boolean).join(' · ');
  if (spec) L.push(spec);

  const tech = [
    car.mileage_km != null ? 'пробег ' + fmtNum(car.mileage_km) + ' км' : null,
    car.volume_cc ? car.volume_cc + ' см³' : null,
    car.power_hp ? car.power_hp + ' л.с.' : null,
  ].filter(Boolean).join(' · ');
  if (tech) L.push(tech);

  if (car.auction_grade) {
    L.push('Оценка аукциона: ' + car.auction_grade +
      (car.interior_grade ? ', салон ' + car.interior_grade : ''));
  }

  // Город в шапке — только если логистика по РФ действительно посчитана.
  // Иначе клиент прочтёт «под ключ до города», а доставки в сумме нет:
  // в пресетах rf_logistics по умолчанию 0 и заполняется вручную.
  const hasRfLogistics = (r.logistics || 0) > 0;
  L.push('');
  L.push('💰 ПОД КЛЮЧ' + (hasRfLogistics && car.logistics_city ? ', ' + car.logistics_city : ' во Владивостоке') +
    ': ' + money(car.price_rub_total));
  L.push('');

  // Разбивка: те же четыре блока, что и в расчёте на экране
  const foreign = (r.carCostRub || 0) + (r.bankFee || 0);
  const services = (r.expensesSum || 0) + (r.commission || 0);
  L.push('Что входит в сумму:');
  if (foreign) L.push('• Авто с аукциона, доставка и фрахт — ' + money(foreign));
  if (r.customsTotal) L.push('• Таможня: пошлина, сбор, утильсбор — ' + money(r.customsTotal));
  if (services) L.push('• Оформление и услуги в РФ — ' + money(services));
  if (hasRfLogistics) {
    L.push('• Доставка по России' + (car.logistics_city ? ' до города ' + car.logistics_city : '') +
      ' — ' + money(r.logistics));
  } else {
    L.push('');
    L.push('Доставка по России в сумму не входит — посчитаем отдельно' +
      (car.logistics_city ? ' до города ' + car.logistics_city : ' до вашего города') + '.');
  }

  // Этапы оплаты — то, ради чего клиент и читает КП: видно, когда и за что платить
  const stages = (r.stages || []).filter((s) => s && s.value > 0);
  if (stages.length) {
    L.push('');
    L.push('Как проходит оплата:');
    stages.forEach((s, i) => L.push(`${i + 1}) ${s.label} — ${money(s.value)}`));
  }

  // Льготный утиль — сильный и проверяемый аргумент, а не маркетинг
  if (r.utilPreferentialApplied === true && r.utilThresholdHp) {
    L.push('');
    L.push('✅ Мощность ' + Math.round(r.input && r.input.powerHp || car.power_hp) +
      ' л.с. — в пределах льготного порога ' + r.utilThresholdHp + ' л.с.');
    L.push('   Утильсбор льготный: ' + money(r.utilFee) +
      '. У авто мощнее порога он вырос бы в десятки раз.');
  } else if (r.utilPreferentialApplied === false && r.utilFee) {
    L.push('');
    L.push('ℹ️ Утильсбор ' + money(r.utilFee) + ' — мощность выше льготного порога ' +
      (r.utilThresholdHp || 160) + ' л.с. Он уже учтён в сумме выше.');
  }

  const rateDate = (car.rates_snapshot || {}).cbr_date;
  const when2 = rateDate ? new Date(rateDate).toLocaleDateString('ru-RU') : new Date().toLocaleDateString('ru-RU');
  L.push('');
  L.push('Расчёт по курсу на ' + when2 + '. Предварительный, справочный,');
  L.push('не является публичной офертой: итоговые платежи определяет');
  L.push('таможенный орган на дату оформления.');

  return L.join('\n');
}

function selectedCars() {
  return baseState.items.filter((c) => baseState.selected.has(c.id));
}

function renderSelectionBar() {
  const bar = $('#selBar');
  if (!bar) return;
  const n = baseState.selected.size;
  bar.classList.toggle('hidden', n === 0);
  const label = $('#selCount');
  if (label && n > 0) {
    // Math.min от пустого массива вернул бы Infinity — считаем только по
    // карточкам с ценой и только когда выбор непустой
    const prices = selectedCars().map((c) => c.price_rub_total).filter((p) => p != null);
    const range = prices.length
      ? ' · от ' + money(Math.min.apply(null, prices)) + ' до ' + money(Math.max.apply(null, prices))
      : '';
    label.textContent = (n === 1 ? 'Выбрана 1 машина' : 'Выбрано ' + n) +
      (n > 1 ? range : (prices.length ? ' · ' + money(prices[0]) : ''));
  }
}

async function copySelection(withPrompt, btn) {
  const cars = selectedCars();
  if (!cars.length) { toast('Отметьте хотя бы одну машину'); return; }
  const fmtEl = $('#selFormat');
  const photoEl = $('#selWithPhoto');
  const text = buildSelectionText(cars, withPrompt, {
    format: fmtEl ? fmtEl.value : 'html',
    withPhoto: photoEl ? photoEl.checked : true,
  });
  const ok = await copyToClipboard(text);
  haptic(ok ? 'medium' : 'light');
  toast(ok
    ? (withPrompt ? `Скопировано с промтом (${cars.length} шт.) — вставьте в GPT`
                  : `Скопировано ${cars.length} шт.`)
    : 'Не удалось скопировать');
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '✅ Скопировано';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
}

function renderBaseList() {
  const el = $('#baseList');
  if (!el) return;
  const cnt = $('#baseCount');
  if (cnt) {
    const sum = baseState.items.reduce((s, c) => s + (c.price_rub_total || 0), 0);
    const avg = baseState.items.length ? Math.round(sum / baseState.items.length) : 0;
    cnt.textContent = baseState.total
      ? `${baseState.total} авто · средний чек ${money(avg)}`
      : 'ничего не найдено';
  }
  el.innerHTML = baseState.items.length
    ? baseState.items.map(carCardHtml).join('')
    : '<p class="hint">Под фильтр ничего не подошло. Смягчите условия или сохраните первый расчёт в режиме «База».</p>';

  // отметки могли остаться от прошлой выдачи — оставляем только видимые
  const visible = new Set(baseState.items.map((c) => c.id));
  baseState.selected.forEach((id) => { if (!visible.has(id)) baseState.selected.delete(id); });
  renderSelectionBar();
}

/* Пересчёт показанных карточек по сегодняшним курсам.
 * Цена в валюте не трогается — она зафиксирована сделкой. Пересчитываются
 * только рублёвые суммы: тем же calculate() из calc.js на сохранённом
 * calc_input, но с текущим cfg. */
async function recalcVisible(btn) {
  const stale = baseState.items.filter((c) => rateStaleness(c));
  if (!stale.length) { toast('Все показанные карточки уже по актуальному курсу'); return; }

  const ok = await confirmAsync(
    `Пересчитать ${stale.length} шт. по сегодняшнему курсу?\n` +
    'Цены в иенах/вонах/юанях останутся прежними — обновятся только рубли.');
  if (!ok) return;

  const rates = ratesSnapshot();
  let done = 0;
  const failed = [];
  if (btn) btn.disabled = true;

  for (let i = 0; i < stale.length; i++) {
    const c = stale[i];
    if (btn) btn.textContent = `⏳ ${i + 1} из ${stale.length}…`;
    try {
      // берём полную карточку: в списке calc_input не приходит
      const full = await wtApi.getCar(c.id);
      const result = calculate(full.calc_input, cfg);
      await wtApi.recalcCar(c.id, { calc_result: result, rates });
      done++;
    } catch (e) {
      failed.push(c.id + ': ' + e.message);
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '💱 Пересчитать по курсу'; }
  haptic('medium');
  toast(failed.length
    ? `Пересчитано ${done}, не вышло ${failed.length}`
    : `Пересчитано ${done} шт. по сегодняшнему курсу`);
  loadBase();
}

/* Картинка расчёта по сохранённой карточке — та же таблица, что и после
 * обычного расчёта. Курс берём из снимка карточки, а не текущий: иначе
 * в картинке окажется сегодняшний курс при вчерашних суммах.
 *
 * Blob собираем ВНУТРИ ClipboardItem, не дожидаясь загрузки заранее:
 * Safari и WebView Telegram разрешают запись в буфер только в рамках
 * пользовательского жеста, а await до вызова write() его теряет. */
async function copyCardImage(id, btn) {
  const label = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  const buildBlob = async () => {
    const full = await wtApi.getCar(id);
    const snap = full.rates_snapshot || {};
    const conf = (snap.cbr && snap.market)
      ? Object.assign({}, cfg, { rates: { cbr: snap.cbr, market: snap.market } })
      : cfg;
    return renderTableToBlob(buildTableLines(full.calc_result, true, conf));
  };

  let ok = false;
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': buildBlob() })]);
      ok = true;
    }
  } catch (e) { /* ниже второй заход: сначала блоб, потом запись */ }

  if (!ok) {
    try {
      const blob = await buildBlob();
      if (blob && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        ok = true;
      }
    } catch (e) { /* остаётся текстовый запасной вариант */ }
  }

  if (!ok) {
    try {
      const full = await wtApi.getCar(id);
      const snap = full.rates_snapshot || {};
      const conf = (snap.cbr && snap.market)
        ? Object.assign({}, cfg, { rates: { cbr: snap.cbr, market: snap.market } })
        : cfg;
      ok = await copyToClipboard(buildCopyText(full.calc_result, true, conf));
      if (ok) toast('Картинка не поддерживается — скопирован текст расчёта');
    } catch (e) {}
  } else {
    toast('🖼 Расчёт скопирован картинкой — вставьте в чат');
  }

  haptic(ok ? 'medium' : 'light');
  if (!ok) toast('Не удалось скопировать расчёт');
  if (btn) { btn.textContent = ok ? '✅ Готово' : (label || '🖼 Расчёт'); btn.disabled = false; }
  if (btn && ok) setTimeout(() => { btn.textContent = '🖼 Расчёт'; }, 1600);
}

/* Оригинал фото в полном разрешении — чтобы приложить к посту или отправить
 * клиенту. В Telegram WebView скачивание файлов заблокировано, поэтому
 * открываем во внешнем браузере: там сохранение работает длинным нажатием
 * (телефон) или обычным «Сохранить как» (компьютер). Вне Telegram —
 * обычная ссылка на скачивание. */
/* Какое по счёту фото открывали в прошлый раз — чтобы повторные нажатия
 * перебирали галерею по кругу, а не открывали одно и то же. Открыть их
 * пачкой нельзя: браузеры глушат несколько окон подряд. */
const _origCursor = {};

async function openOriginals(carId) {
  // id из data-атрибута приходит строкой — сравниваем по числу, иначе
  // строгое равенство не сработает и покажется «нет фото»
  const wanted = Number(carId);
  const car = baseState.items.find((c) => Number(c.id) === wanted);
  const photos = (car && car.photos) || [];
  if (!photos.length) { toast('У этой карточки нет фото'); return; }

  const idx = (_origCursor[wanted] || 0) % photos.length;
  _origCursor[wanted] = idx + 1;
  const url = wtApi.photoUrl(photos[idx].url);   // без w — оригинал
  const nth = photos.length > 1 ? ` (${idx + 1} из ${photos.length})` : '';

  // Сначала пробуем положить оригинал в буфер — это то, что нужно чаще
  // всего: вставить фото в пост или в переписку с клиентом.
  if (await copyImageToClipboard(url)) {
    haptic('medium');
    toast('🖼 Оригинал в буфере' + nth + ' — вставьте в пост или клиенту' +
      (photos.length > 1 ? '. Нажмите ещё раз для следующего.' : ''));
    return;
  }

  // Буфер недоступен (частая история в мобильном WebView) — открываем файл.
  // Именно inTelegram, а не «tg существует»: вне Telegram объект tg всё равно
  // создаётся загруженным скриптом, и openLink там ничего не открывает.
  if (inTelegram && tg && tg.openLink) {
    tg.openLink(url);
    toast('Буфер недоступен — оригинал открыт' + nth + ', сохраните долгим нажатием');
    return;
  }

  const a = document.createElement('a');
  a.href = url + (url.includes('?') ? '&' : '?') + 'download=1';
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  toast('Скачивается оригинал' + nth);
}

/* Оригинал в буфер обмена, в полном разрешении.
 *
 * Буфер принимает только image/png — JPEG и WebP браузеры отклоняют, поэтому
 * неподходящий формат перерисовываем через canvas.
 *
 * Файлы весят по 1,5–2 МБ, а раньше неудачная первая попытка записи тянула
 * снимок повторно, и каждое следующее нажатие — тоже: в журнале сервера один
 * файл уезжал по пять раз подряд. Держим уже скачанный блоб под рукой. */
const _origBlobs = new Map();   // ссылка → Promise<Blob>
const _ORIG_CACHE_MAX = 3;      // ~6 МБ потолок, дальше вытесняем самый старый

function pngBlobFor(url) {
  let p = _origBlobs.get(url);
  if (p) return p;
  p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bitmap.width; cv.height = bitmap.height;
    cv.getContext('2d').drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('не удалось перекодировать в PNG');
    return png;
  })();
  p.catch(() => _origBlobs.delete(url));   // неудачу не кэшируем — дадим повторить
  _origBlobs.set(url, p);
  if (_origBlobs.size > _ORIG_CACHE_MAX) _origBlobs.delete(_origBlobs.keys().next().value);
  return p;
}

async function copyImageToClipboard(url) {
  if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) return false;

  // Промис передаём в ClipboardItem как есть: Safari разрешает запись только
  // в рамках жеста пользователя, а ожидание блоба до вызова его теряет.
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlobFor(url) })]);
    return true;
  } catch (e) {
    try {                    // второй заход: блоб уже скачан, повторной загрузки нет
      const blob = await pngBlobFor(url);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (e2) { return false; }
  }
}

async function baseCardAction(act, id, btn) {
  const car = baseState.items.find((c) => String(c.id) === String(id));
  try {
    if (act === 'del') {
      const ok = await confirmAsync('Удалить карточку' + (car ? ' «' + (car.title || '') + '»' : '') + '?');
      if (!ok) return;
      await wtApi.deleteCar(id);
      baseState.items = baseState.items.filter((c) => String(c.id) !== String(id));
      baseState.total = Math.max(0, baseState.total - 1);
      renderBaseList();
      haptic('light');
    } else if (act === 'orig') {
      await openOriginals(id);
    } else if (act === 'image') {
      await copyCardImage(id, btn);
    } else if (act === 'offer') {
      // calc_result приходит только в детальной карточке — в списке его нет
      if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
      try {
        const full = await wtApi.getCar(id);
        const ok = await copyToClipboard(buildClientOffer(full));
        haptic(ok ? 'medium' : 'light');
        toast(ok ? '📄 КП скопировано — вставьте клиенту в переписку'
                 : 'Не удалось скопировать');
        if (btn) btn.textContent = ok ? '✅ Готово' : '📄 Клиенту';
        setTimeout(() => { if (btn) { btn.textContent = '📄 Клиенту'; btn.disabled = false; } }, 1600);
      } catch (e) {
        if (btn) { btn.textContent = '📄 Клиенту'; btn.disabled = false; }
        throw e;
      }
    } else if (act === 'photos') {
      const input = $('#basePhotoInput');
      if (!input) return;
      input.dataset.carId = id;
      input.click();
    }
  } catch (e) {
    toast('Не получилось: ' + e.message);
  }
}

/* Подтверждение: в WebView Telegram нативный confirm() заблокирован. */
function confirmAsync(message) {
  return new Promise((resolve) => {
    if (tg && tg.showConfirm) {
      try { tg.showConfirm(message, (ok) => resolve(!!ok)); return; } catch (e) {}
    }
    resolve(window.confirm(message));
  });
}

async function uploadBasePhotos(input) {
  const carId = input.dataset.carId;
  if (!carId || !input.files || !input.files.length) return;
  toast('Загружаю фото…');
  try {
    await wtApi.uploadPhotos(carId, input.files);
    haptic('light');
    toast('Фото добавлены');
    loadBase();
  } catch (e) {
    toast('Не удалось загрузить: ' + e.message);
  } finally {
    input.value = '';
  }
}

/* --- обработчики экрана «База» --- */
function bindBaseEvents() {
  const screen = $('#screenBase');
  if (!screen) return;

  // Картинка не загрузилась — пробуем ещё дважды. На нестабильной сети
  // (VPN, мобильный интернет) часть соединений просто рвётся, и без
  // повтора карточка навсегда остаётся без превью. Событие error не
  // всплывает, поэтому слушаем на фазе перехвата.
  screen.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('car-thumb')) return;
    const tries = Number(img.dataset.retry || 0);
    if (tries >= 2) {
      const wrap = img.closest('.car-thumb-wrap');
      if (wrap) wrap.innerHTML = '<div class="car-thumb car-thumb-empty" title="Фото не загрузилось">⚠️</div>';
      return;
    }
    img.dataset.retry = String(tries + 1);
    const base = img.src.split('#')[0];
    setTimeout(() => { img.src = base + '#r' + (tries + 1); }, 400 * (tries + 1));
  }, true);

  screen.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const id = Number(pick.dataset.pick);
      if (pick.checked) baseState.selected.add(id); else baseState.selected.delete(id);
      const card = pick.closest('.car-card');
      if (card) card.classList.toggle('car-card-sel', pick.checked);
      renderSelectionBar();
      return;
    }
    if (e.target.closest('#btnCopySel')) { copySelection(false, e.target.closest('#btnCopySel')); return; }
    if (e.target.closest('#btnCopySelPrompt')) { copySelection(true, e.target.closest('#btnCopySelPrompt')); return; }
    if (e.target.closest('#btnClearSel')) {
      baseState.selected.clear();
      screen.querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = false; });
      screen.querySelectorAll('.car-card').forEach((cd) => cd.classList.remove('car-card-sel'));
      renderSelectionBar();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (btn) { baseCardAction(btn.dataset.act, btn.dataset.id, btn); return; }
    if (e.target.closest('#btnApplyFilter') || e.target.closest('#btnRetryBase')) { loadBase(); return; }
    const recalcBtn = e.target.closest('#btnRecalcRates');
    if (recalcBtn) { recalcVisible(recalcBtn); return; }
    if (e.target.closest('#btnResetFilter')) {
      screen.querySelectorAll('#filterCard input, #filterCard select').forEach((el) => {
        if (el.type === 'checkbox') el.checked = false; else el.value = '';
      });
      loadBase();
      return;
    }
    if (e.target.closest('#btnBaseBack')) { showScreen('screenCalc'); return; }
  });

  screen.addEventListener('change', (e) => {
    if (e.target.id === 'basePhotoInput') { uploadBasePhotos(e.target); return; }
    if (e.target.closest('#filterCard')) loadBase();
  });

  screen.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault(); e.target.blur(); loadBase();
    }
  });

  // Кнопка сохранения живёт внутри #result — там делегирование уже есть в
  // app.js, но на всякий случай ловим и здесь: слот дорисовывается позже.
  const res = $('#result');
  if (res) {
    res.addEventListener('click', (e) => {
      const b = e.target.closest('#btnSaveToBase');
      if (b && !b.disabled && !b.dataset.carId) saveCurrentToBase(b);
    });
  }
}

/* --- переключатель режима --- */
function applyMode() {
  const isBase = state.mode === 'base';
  $$('#modeTabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  const vc = $('#cardVehicle'); if (vc) vc.classList.toggle('hidden', !isBase);
  const ba = $('#baseActions'); if (ba) ba.classList.toggle('hidden', !isBase);
  onResultRendered();
  // текст MainButton зависит от режима — обновляем, если экран расчёта открыт
  if (typeof setMainButtonFor === 'function' && !$('#screenCalc').classList.contains('hidden')) {
    setMainButtonFor('screenCalc');
  }
  try { localStorage.setItem('wt_mode_v1', state.mode); } catch (e) {}
}

function initBase() {
  try { state.mode = localStorage.getItem('wt_mode_v1') || 'client'; } catch (e) { state.mode = 'client'; }

  const tabs = $('#modeTabs');
  if (tabs) {
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.seg');
      if (!b) return;
      state.mode = b.dataset.mode;
      applyMode();
      haptic('light');
    });
  }
  const openBtn = $('#btnOpenBase');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      showScreen('screenBase');
      restoreFilter();
      loadBase();
    });
  }
  const openExtractBtn = $('#btnOpenExtract');
  if (openExtractBtn) {
    openExtractBtn.addEventListener('click', () => {
      resetExtractScreen();
      showScreen('screenExtract');
    });
  }
  const openImportBtn = $('#btnOpenImport');
  if (openImportBtn) {
    openImportBtn.addEventListener('click', () => {
      resetImportScreen();
      showScreen('screenImport');
    });
  }
  // год/месяц выпуска меняют категорию возраста — пересчитываем подсказку
  // и подставляем категорию, если она однозначна
  const vc = $('#cardVehicle');
  if (vc) {
    vc.addEventListener('input', (e) => {
      if (e.target.id === 'year') syncAgeFromYear();
    });
    vc.addEventListener('change', (e) => {
      if (e.target.id === 'year' || e.target.id === 'monthOut') syncAgeFromYear();
    });
  }

  bindBaseEvents();
  bindExtractEvents();
  bindImportEvents();
  applyMode();
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    initBase, applyMode, onResultRendered, loadBase, saveCurrentToBase,
    ratesSnapshot, collectVehicle, applyExtraction, ageBandFrom, runExtraction,
    handleImportFile, runImport, resetImportScreen, renderImportPreview,
    applyPasted, recalcVisible, rateStaleness,
    ageInfo, renderAgeHint, syncAgeFromYear,
    buildSelectionText, copySelection, selectedCars, renderSelectionBar,
    postPrompt, EXTRACT_PROMPT, copyExtractPrompt, carToPostLines,
    setExtractPhoto, pasteImageFromClipboard, buildClientOffer, copyCardImage,
    openOriginals,
  });
}

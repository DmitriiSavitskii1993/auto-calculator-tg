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
      if (!file) return;
      extractFile = file;
      // без ключа ИИ распознавать нечем, но скрин всё равно нужен —
      // он прикрепится к карточке при сохранении в базу
      pendingCarPhoto = file;
      const img = $('#extractPreview');
      const reader = new FileReader();
      reader.onload = () => {
        img.src = reader.result;
        img.classList.remove('hidden');
        $('#extractDropText').classList.add('hidden');
      };
      reader.readAsDataURL(file);
      $('#btnExtractRun').disabled = false;
      const note = $('#extractPhotoNote');
      if (note) note.textContent = '📎 Скрин прикрепится к карточке при сохранении в базу.';
      $('#extractReview').classList.add('hidden');
    });
  }

  const run = $('#btnExtractRun'); if (run) run.addEventListener('click', runExtraction);
  const paste = $('#btnPasteApply'); if (paste) paste.addEventListener('click', applyPasted);
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

  const f = readFilter();
  saveFilter(f);
  try {
    const data = await wtApi.listCars(Object.assign({ limit: 100 }, f));
    baseState.items = data.items;
    baseState.total = data.total;
    renderBaseList();
  } catch (e) {
    if (listEl) {
      listEl.innerHTML = '<p class="hint">Не удалось загрузить: ' + esc(e.message) + '</p>';
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
  const photo = (c.photos && c.photos[0]) ? wtApi.photoUrl(c.photos[0].url) : null;
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

  return (
    '<div class="car-card" data-car-id="' + c.id + '">' +
      (photo
        ? '<img class="car-thumb" src="' + esc(photo) + '" alt="" loading="lazy">'
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
          '<button class="mini-btn" data-act="photos" data-id="' + c.id + '">📷 Фото</button>' +
          '<button class="mini-btn" data-act="sold" data-id="' + c.id + '">✅ Продано</button>' +
          '<button class="mini-btn" data-act="del" data-id="' + c.id + '">🗑</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
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
    } else if (act === 'sold') {
      await wtApi.updateCar(id, { status: 'sold' });
      toast('Отмечено как проданное');
      loadBase();
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

  screen.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (btn) { baseCardAction(btn.dataset.act, btn.dataset.id, btn); return; }
    if (e.target.closest('#btnApplyFilter')) { loadBase(); return; }
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
  });
}

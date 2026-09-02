/* =========================================================================
 *  app.js — логика интерфейса Mini App
 * ========================================================================= */
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const inTelegram = !!(tg && tg.initData !== undefined && tg.platform && tg.platform !== 'unknown');

// Адрес бэкенда бота (Render). Пусто → отправка через t.me/share.
const BACKEND_URL = 'https://auto-calculator-tg.onrender.com';

/* --- состояние --- */
const state = {
  country: 'jp',
  isElectric: false,
  isSanctioned: false,  // санкционное авто (Япония)
  isNotDvfo: false,     // не из ДВФО → нужна врем. регистрация (+15 000 ₽)
  powerUnit: 'hp',
  logisticsCity: '',    // город доставки по РФ (к строке «Логистика по РФ»)
  mode: 'client',       // 'client' — как раньше, 'base' — наполняем базу авто
};

/* текущий пресет расходов (с учётом санкций для Японии) */
function currentPresetKey() {
  return (state.country === 'jp' && state.isSanctioned) ? 'jp_sanctioned' : state.country;
}
function currentPreset() { return cfg.expensePresets[currentPresetKey()]; }

const CUR = { jp: '¥', cn: '¥', kr: '₩' };

/* все коммерческие курсы (вводятся 1 раз в день, запоминаются) */
const ALL_RATE_FIELDS = [
  { key: 'JPY100_ATB', label: '¥ за 100 (АТБ)', step: 0.01 },
  { key: 'CNY', label: '¥ (CNY) за 1', step: 0.01 },
  { key: 'KRW1000', label: '₩ за 1000 → ₽', step: 0.01 },
];

/* --- утилиты --- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const num = (el) => { const v = parseFloat(($(el).value || '').toString().replace(',', '.')); return isNaN(v) ? 0 : v; };
const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');

let cfg = buildConfig();
let lastResult = null;
let lastInput = null;          // сырой input последнего расчёта (уходит в базу)
let currentExpenseItems = [];

/* --- экранирование значения для HTML-атрибута (город вводится вручную) --- */
const escapeAttr = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* =================== ПОСЛЕДНИЕ ВВЕДЁННЫЕ ДАННЫЕ (по странам) ===================
 * Запоминаем по каждой стране: возраст, объём, мощность (+ед.), цену, аукцион (Япония),
 * город логистики. Храним в localStorage и дублируем в Telegram CloudStorage,
 * чтобы переживало очистку кэша WebView и синхронизировалось между устройствами. */
const LAST_INPUTS_KEY   = 'calc_last_inputs_v1'; // localStorage
const LAST_INPUTS_CLOUD = 'last_inputs_v1';      // Telegram CloudStorage

function getLastInputs() {
  try { return JSON.parse(localStorage.getItem(LAST_INPUTS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveLastInputs(obj) {
  try { localStorage.setItem(LAST_INPUTS_KEY, JSON.stringify(obj)); } catch (e) {}
  if (cloudAvailable()) {
    try { tg.CloudStorage.setItem(LAST_INPUTS_CLOUD, JSON.stringify(obj), function () {}); } catch (e) {}
  }
}
function loadLastInputsFromCloud() {
  return new Promise(function (resolve) {
    if (!cloudAvailable()) { resolve(null); return; }
    try {
      tg.CloudStorage.getItem(LAST_INPUTS_CLOUD, function (err, val) {
        if (err || !val) { resolve(null); return; }
        try { resolve(JSON.parse(val)); } catch (e) { resolve(null); }
      });
    } catch (e) { resolve(null); }
  });
}

/* собрать текущие поля формы в объект для текущей страны */
function captureInputs() {
  const sel = $('#auction');
  return {
    age: $('#age') ? $('#age').value : '',
    volumeCc: $('#volume') ? $('#volume').value : '',
    power: $('#power') ? $('#power').value : '',
    powerUnit: state.powerUnit,
    carPrice: $('#carPrice') ? $('#carPrice').value : '',
    auction: (state.country === 'jp' && sel) ? sel.value : '',
    city: $('#logCity') ? $('#logCity').value : (state.logisticsCity || ''),
  };
}
/* сохранить текущие поля под текущую страну */
function persistInputs() {
  const all = getLastInputs();
  all[state.country] = captureInputs();
  saveLastInputs(all);
}
/* подставить сохранённые поля в форму (форма уже отрисована для текущей страны) */
function applyFieldInputs(saved) {
  saved = saved || {};
  if (saved.age && $('#age')) {
    const opt = Array.prototype.some.call($('#age').options, o => o.value === saved.age);
    if (opt) $('#age').value = saved.age;
  }
  if ($('#volume'))   $('#volume').value   = saved.volumeCc != null ? saved.volumeCc : '';
  if ($('#power'))    $('#power').value     = saved.power != null ? saved.power : '';
  if ($('#carPrice')) $('#carPrice').value  = saved.carPrice != null ? saved.carPrice : '';
  // аукцион (только Япония без санкций): восстанавливаем и подставляем доставку
  if (state.country === 'jp' && !state.isSanctioned && $('#auction') &&
      saved.auction != null && saved.auction !== '' && CALC_DATA.auctions[saved.auction]) {
    $('#auction').value = saved.auction;
    $('#delivery').value = CALC_DATA.auctions[saved.auction].fob;
  }
  updateDelivery(); // Корея/Китай/санкц.Япония — пересчитать авто-доставку от восстановленной цены
}
/* загрузить сохранённые поля выбранной страны в состояние + форму */
function loadInputsFor(country) {
  const saved = getLastInputs()[country] || {};
  state.logisticsCity = saved.city || '';
  state.powerUnit = saved.powerUnit || 'hp';
  return saved;
}

/* ============================ ИНИЦИАЛИЗАЦИЯ ============================ */
function init() {
  if (tg) { tg.ready(); tg.expand(); }
  renderAuctions();                              // опции аукциона нужны до восстановления сохранённого
  const saved0 = loadInputsFor(state.country);   // город / ед. мощности в state до рендера формы
  renderCountry();
  renderRatesPanel();
  bindEvents();
  applyFieldInputs(saved0);                       // подставить последние введённые поля
  syncPowerUnit();
  loadCbr();
  setupMainButton();
  setupKeyboardDone();
  setupEnterToCalc();
  if (typeof initBase === 'function') initBase();  // режим «База» и её экран
  hydrateFromCloud();   // подтянуть сохранённые курсы/настройки/поля из облака Telegram
}

/* подсветить активную единицу мощности (л.с./кВт) по состоянию */
function syncPowerUnit() {
  $$('.unit').forEach(x => x.classList.toggle('active', x.dataset.unit === state.powerUnit));
}

/* расчёт по нажатию Enter в любом поле ввода + авто-копирование полной картинки */
function setupEnterToCalc() {
  $('#screenCalc').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    if (e.target && e.target.tagName === 'INPUT') {
      e.preventDefault();
      if (e.target.blur) e.target.blur();
      // расчёт и сразу в буфер картинкой с полным расчётом (с этапами оплаты).
      // Enter — пользовательский жест, поэтому запись в буфер обмена разрешена.
      if (onCalculate()) await copyCalcImage(true);
    }
  });
}

/* Курсы/настройки сохраняются в CloudStorage Telegram (переживают очистку кэша
   WebView и синхронизируются между устройствами). Подтягиваем и перерисовываем. */
async function hydrateFromCloud() {
  try {
    const cloud = await loadOverridesFromCloud();
    if (cloud) {
      mergeCloudOverrides(cloud);
      cfg = buildConfig();
      renderRatesPanel();
      renderExpenses();
    }
  } catch (e) {}
  // последние введённые поля из облака (локальные правки этой сессии — приоритетнее)
  try {
    const inputsCloud = await loadLastInputsFromCloud();
    if (!inputsCloud) return;
    const localBefore = getLastInputs();
    const hadLocal = !!localBefore[state.country];
    const merged = Object.assign({}, inputsCloud, localBefore);
    try { localStorage.setItem(LAST_INPUTS_KEY, JSON.stringify(merged)); } catch (e) {}
    if (!hadLocal) {
      const saved = loadInputsFor(state.country);
      renderExpenses();         // обновить город в строке логистики
      applyFieldInputs(saved);
      syncPowerUnit();
    }
  } catch (e) {}
}

/* ===================== ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ =====================
 * Экраны — сиблинги, переключаются классом .hidden. Единая точка, чтобы
 * добавление нового экрана не требовало править вызовы по всему файлу. */
const SCREENS = ['screenCalc', 'screenSettings', 'screenBase', 'screenExtract', 'screenImport'];

function showScreen(id) {
  SCREENS.forEach((s) => {
    const el = $('#' + s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  // переключатель режима имеет смысл только на экране расчёта
  const tabs = $('#modeTabs');
  if (tabs) tabs.classList.toggle('hidden', id !== 'screenCalc');
  setMainButtonFor(id);
}

/* MainButton один на всё приложение. Без offClick обработчики копятся, и одно
 * нажатие срабатывает сразу за несколько экранов — поэтому держим текущий. */
let mbHandler = null;

function setMainButton(text, handler) {
  if (!inTelegram) return;
  if (mbHandler) { try { tg.MainButton.offClick(mbHandler); } catch (e) {} }
  mbHandler = handler || null;
  if (!handler) { tg.MainButton.hide(); return; }
  tg.MainButton.setText(text);
  tg.MainButton.onClick(handler);
  tg.MainButton.show();
}

function setMainButtonFor(screenId) {
  if (screenId === 'screenCalc') {
    setMainButton(
      state.mode === 'base' ? 'Рассчитать и сохранить' : 'Рассчитать стоимость',
      onCalculate,
    );
  } else {
    setMainButton(null, null);
  }
}

/* --- кнопка «Рассчитать» --- */
function setupMainButton() {
  if (inTelegram) {
    setMainButtonFor('screenCalc');
  } else {
    // в браузере — обычная кнопка
    const btn = document.createElement('button');
    btn.className = 'calc-btn';
    btn.textContent = 'Рассчитать стоимость';
    btn.addEventListener('click', onCalculate);
    $('#screenCalc').appendChild(btn);
  }
}

/* --- загрузка курсов ЦБ --- */
async function loadCbr() {
  const cache = getCbrCache();
  if (cache) showCbrStatus(cache);
  try {
    const fresh = await fetchCbr();
    cfg = buildConfig();
    showCbrStatus(fresh);
  } catch (e) {
    if (!cache) $('#cbrStatus').textContent = 'Курсы ЦБ: не удалось загрузить, используются сохранённые';
  }
}
function showCbrStatus(c) {
  const d = c.date ? new Date(c.date).toLocaleDateString('ru-RU') : '';
  $('#cbrStatus').textContent =
    `Курсы ЦБ ${d}: $ ${c.rates.USD} · € ${c.rates.EUR} · ¥100 ${(c.rates.JPY*100).toFixed(2)} · ₩1000 ${(c.rates.KRW*1000).toFixed(2)} · ¥(CNY) ${c.rates.CNY}`;
}

/* ============================ РЕНДЕР ФОРМЫ ============================ */
function renderCountry() {
  // вкладки
  $$('#countryTabs .seg').forEach(b => b.classList.toggle('active', b.dataset.country === state.country));
  // валютные подписи
  $('#curLabel1').textContent = CUR[state.country];
  $('#curLabel2').textContent = CUR[state.country];
  // санкции, ДВФО — только Япония; аукцион — Япония кроме санкционных (там фрахт по формуле)
  const isJp = state.country === 'jp';
  $('#fieldAuction').classList.toggle('hidden', !(isJp && !state.isSanctioned));
  $('#fieldSanctioned').classList.toggle('hidden', !isJp);
  $('#fieldDvfo').classList.toggle('hidden', !isJp);
  // объём — скрыт для электрокара
  $('#fieldVolume').classList.toggle('hidden', state.isElectric);
  // возраст
  renderAgeOptions();
  // доставка/фрахт: Китай — фикс, Корея — авто, Япония-санкции — формула, иначе из аукциона
  updateDelivery();
  // расходы по РФ + комиссия из пресета
  renderExpenses();
}

/* панель «Курсы на сегодня» — все коммерческие курсы, сохраняются сразу при вводе */
function renderRatesPanel() {
  $('#rateList').innerHTML = ALL_RATE_FIELDS.map(f =>
    `<label>${f.label}<input type="text" inputmode="decimal" data-mrate="${f.key}" value="${String(cfg.rates.market[f.key]).replace('.', ',')}"></label>`
  ).join('');
  updateRateSummary();
}
function updateRateSummary() {
  const m = cfg.rates.market;
  $('#rateSummary').textContent = `¥100 ${m.JPY100_ATB} · CNY ${m.CNY} · ₩1000 ${m.KRW1000}`;
}

/* доставка+фрахт: Китай фикс, Корея авто по цене, Япония из аукциона (вручную) */
function updateDelivery() {
  const d = $('#delivery');
  const hint = $('#deliveryHint');
  if (state.country === 'cn') {
    d.value = currentPreset().fixedDeliveryForeign || 0;
    d.readOnly = true; hint.textContent = '(фикс.)';
  } else if (state.country === 'kr') {
    d.value = koreaDeliveryWon(num('#carPrice'), cfg);
    d.readOnly = true; hint.textContent = '(авто по цене авто)';
  } else if (state.country === 'jp' && state.isSanctioned) {
    const f = cfg.jpSanctionedFreight || { base: 490000, pct: 0.05 };
    d.value = Math.round(f.base + f.pct * num('#carPrice'));
    d.readOnly = true; hint.textContent = '(490 000 + 5% от цены)';
  } else {
    d.readOnly = false; hint.textContent = '';
  }
}

function renderAgeOptions() {
  const opts = state.isElectric ? CALC_DATA.ageOptionsEv : CALC_DATA.ageOptions;
  $('#age').innerHTML = opts.map(o => `<option value="${o.id}">${o.label}</option>`).join('');
}

function renderAuctions() {
  // только названия аукционов, без цен
  $('#auction').innerHTML =
    '<option value="">— выбрать аукцион —</option>' +
    CALC_DATA.auctions.map((a, i) => `<option value="${i}">${a.name}</option>`).join('');
}

function renderExpenses() {
  const preset = currentPreset();
  // список расходов пресета + (для Японии не из ДВФО) справка о врем. регистрации
  let items = preset.items.slice();
  if (state.country === 'jp' && state.isNotDvfo) {
    items.push({ key: 'tempreg', label: 'Справка о врем. регистрации (не из ДВФО)', short: 'Справка врем.рег.', value: cfg.tempRegFee });
  }
  currentExpenseItems = items;
  const box = $('#expenseList');
  box.innerHTML = items.map((it, i) => {
    const row = `
    <div class="exp-item">
      <span class="exp-label">${it.label}</span>
      <input type="number" inputmode="numeric" data-exp="${i}" value="${it.value}">
    </div>`;
    // под «Логистика по РФ» — поле города доставки
    if (it.key === 'rf_logistics') {
      return row + `
    <div class="exp-item exp-city">
      <span class="exp-label">↳ Город доставки</span>
      <input type="text" id="logCity" inputmode="text" placeholder="напр. Москва" value="${escapeAttr(state.logisticsCity)}">
    </div>`;
    }
    return row;
  }).join('');
  const commEl = $('#commission');
  if (commEl) {
    commEl.value = preset.commission;      // дефолт (1-я ступень); фактическая — по цене авто при расчёте
    commEl.readOnly = true;                // комиссия ступенчатая (commissionTiers), редактировать нельзя
    commEl.title = 'Считается автоматически по стоимости авто (₽)';
  }
  $('#bankFee').value = String(preset.bankFeePercent != null ? preset.bankFeePercent : 0).replace('.', ',');
}

/* ============================ СОБЫТИЯ ============================ */
function bindEvents() {
  $$('#countryTabs .seg').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.country === state.country) return;
    persistInputs();                            // сохранить поля уходящей страны
    state.country = b.dataset.country;
    haptic('light');
    const saved = loadInputsFor(state.country); // город / ед. мощности в state
    renderCountry();
    applyFieldInputs(saved);                     // подставить поля выбранной страны
    syncPowerUnit();
    hideResult();
  }));

  $('#isElectric').addEventListener('change', (e) => {
    state.isElectric = e.target.checked;
    // официальный расчёт акциза/утиля для EV — от кВт; для ДВС привычнее л.с.
    state.powerUnit = e.target.checked ? 'kw' : 'hp';
    syncPowerUnit();
    renderCountry();
    persistInputs();
    hideResult();
  });

  $('#isSanctioned').addEventListener('change', (e) => {
    state.isSanctioned = e.target.checked;
    renderCountry();    // пресет (СВХ), фрахт по формуле, скрытие аукциона
    hideResult();
  });

  $('#isNotDvfo').addEventListener('change', (e) => {
    state.isNotDvfo = e.target.checked;
    renderExpenses();   // добавляет/убирает строку врем. регистрации
    hideResult();
  });

  // пересчёт доставки/фрахта от цены авто (Корея и санкционная Япония)
  $('#carPrice').addEventListener('input', () => {
    if (state.country === 'kr' || (state.country === 'jp' && state.isSanctioned)) updateDelivery();
  });

  // панель «Курсы на сегодня»: сворачивание + сохранение сразу при вводе
  $('#rateToggle').addEventListener('click', () => {
    const open = $('#rateBody').classList.toggle('hidden');
    $('#rateChevron').textContent = open ? '▸' : '▾';
  });
  $('#rateList').addEventListener('change', (e) => {
    if (!e.target.dataset || e.target.dataset.mrate == null) return;
    const v = parseFloat((e.target.value || '').toString().replace(',', '.'));
    if (isNaN(v)) return;
    cfg.rates.market[e.target.dataset.mrate] = v;
    patchOverrides({ rates: { market: { [e.target.dataset.mrate]: v } } });
    updateRateSummary();
    if (state.country === 'kr') updateDelivery();
    haptic('light');
  });

  $$('.unit').forEach(u => u.addEventListener('click', () => {
    state.powerUnit = u.dataset.unit;
    syncPowerUnit();
    persistInputs();
  }));

  // запоминать последние введённые поля (возраст, объём, мощность, цена, аукцион, город)
  $('#screenCalc').addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('#age, #volume, #power, #carPrice, #auction, #logCity')) {
      if (t.id === 'logCity') state.logisticsCity = t.value;
      persistInputs();
    }
  });
  // город логистики — держать state в синхроне (переживает перерисовку списка расходов)
  $('#expenseList').addEventListener('input', (e) => {
    if (e.target && e.target.id === 'logCity') state.logisticsCity = e.target.value;
  });

  // действия с расчётом (короткая версия — до этапов, полная — внизу)
  $('#result').addEventListener('click', async (e) => {
    if (!e.target.closest || !lastResult) return;
    const copyBtn = e.target.closest('#btnCopyShort, #btnCopyFull');
    const shareBtn = e.target.closest('#btnShareShort, #btnShareFull');
    if (copyBtn) {
      await copyCalcImage(copyBtn.id === 'btnCopyFull');
    }
    if (shareBtn) {
      const full = shareBtn.id === 'btnShareFull';
      haptic('medium');
      shareToChat(buildCopyText(lastResult, full), buildShareText(lastResult, full));
    }
  });

  $('#auction').addEventListener('change', (e) => {
    const idx = e.target.value;
    if (idx !== '') $('#delivery').value = CALC_DATA.auctions[idx].fob;
  });

  // настройки
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnBack').addEventListener('click', closeSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnResetSettings').addEventListener('click', () => {
    if (confirm('Сбросить все ручные настройки к значениям по умолчанию?')) {
      resetOverrides(); cfg = buildConfig(); fillSettings(); renderCountry(); renderRatesPanel();
      toast('Сброшено');
    }
  });
  $('#btnRefreshCbr').addEventListener('click', async () => {
    try { const f = await fetchCbr(); cfg = buildConfig(); fillSettings(); showCbrStatus(f); toast('Курсы ЦБ обновлены'); }
    catch (e) { toast('Не удалось обновить курсы'); }
  });
}

/* плавающая кнопка «свернуть клавиатуру» — появляется при фокусе на поле ввода */
function setupKeyboardDone() {
  const btn = $('#kbDone');
  if (!btn) return;
  const vv = window.visualViewport;
  const reposition = () => {
    if (!vv) return;
    const gap = window.innerHeight - vv.height - vv.offsetTop; // высота клавиатуры
    btn.style.bottom = Math.max(12, gap + 10) + 'px';
  };
  document.addEventListener('focusin', (e) => {
    if (e.target && e.target.matches && e.target.matches('input')) {
      btn.classList.remove('hidden');
      reposition();
    }
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || !a.matches || !a.matches('input')) btn.classList.add('hidden');
    }, 150);
  });
  if (vv) { vv.addEventListener('resize', reposition); vv.addEventListener('scroll', reposition); }
  // не забирать фокус у поля при нажатии
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  btn.addEventListener('click', () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    btn.classList.add('hidden');
  });
}

function haptic(style) { try { if (tg) tg.HapticFeedback.impactOccurred(style); } catch (e) {} }
function toast(msg) { if (tg && tg.showPopup) { try { tg.showPopup({ message: msg }); return; } catch(e){} } alert(msg); }

/* ============================ РАСЧЁТ ============================ */
function onCalculate() {
  haptic('medium');
  // свернуть клавиатуру, чтобы не мешала смотреть результат
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

  // применить и сохранить коммерческие курсы, введённые на главном экране
  const ratePatch = { rates: { market: {} } };
  $$('#rateList [data-mrate]').forEach(el => {
    const v = parseFloat((el.value || '').toString().replace(',', '.'));
    if (!isNaN(v)) { cfg.rates.market[el.dataset.mrate] = v; ratePatch.rates.market[el.dataset.mrate] = v; }
  });
  if (Object.keys(ratePatch.rates.market).length) patchOverrides(ratePatch);

  const expenses = $$('#expenseList [data-exp]').map((el, i) => ({
    key: (currentExpenseItems[i] || {}).key,
    label: (currentExpenseItems[i] || {}).label || '',
    short: (currentExpenseItems[i] || {}).short || (currentExpenseItems[i] || {}).label || '',
    value: parseFloat(el.value) || 0,
  }));

  const powerVal = num('#power');
  const input = {
    country: state.country,
    isElectric: state.isElectric,
    sanctioned: state.country === 'jp' && state.isSanctioned,
    age: $('#age').value,
    volumeCc: state.isElectric ? 0 : num('#volume'),
    powerHp: state.powerUnit === 'hp' ? powerVal : null,
    powerKw: state.powerUnit === 'kw' ? powerVal : null,
    carPrice: num('#carPrice'),
    deliveryForeign: num('#delivery'),
    bankFeePercent: num('#bankFee'),
    commission: num('#commission'),
    expenses,
    logisticsCity: ($('#logCity') ? $('#logCity').value : (state.logisticsCity || '')).trim(),
  };

  if (!input.carPrice) { toast('Укажите цену авто'); return; }
  if (!state.isElectric && !input.volumeCc) { toast('Укажите объём двигателя'); return; }
  if (!powerVal) { toast('Укажите мощность двигателя'); return; }

  persistInputs();   // запомнить последние введённые поля для этой страны
  lastInput = input; // сохраняем сырой input — он уходит в базу вместе с результатом
  const r = calculate(input, cfg);
  renderResult(r);
  return true;       // расчёт выполнен (используется для авто-копирования по Enter)
}

/* родительный падеж страны + флаг для подзаголовка */
const COUNTRY_GEN = { jp: 'Японии 🇯🇵', kr: 'Корее 🇰🇷', cn: 'Китаю 🇨🇳' };
const COUNTRY_UP = { jp: 'ЯПОНИИ', kr: 'КОРЕЕ', cn: 'КИТАЮ' };

/* строка курса для экрана */
function rateDisplay(c, m) {
  if (c === 'jp') return `¥100 = ${m.JPY100_ATB} ₽`;
  if (c === 'cn') return `¥ = ${m.CNY} ₽`;
  if (c === 'kr') return `₩1000 = ${m.KRW1000} ₽`;
  return '';
}
/* строка курса для копирования (компактная) */
function rateCopy(c, m) {
  if (c === 'jp') return `¥100=${m.JPY100_ATB}₽`;
  if (c === 'cn') return `¥=${m.CNY}₽`;
  if (c === 'kr') return `₩1000=${m.KRW1000}₽`;
  return '';
}

function renderResult(r) {
  const c = r.input.country;
  const m = cfg.rates.market;
  const cur = CUR[c];
  const foreignBlock = r.carCostRub + r.bankFee;
  const rfBlock = r.expensesSum + r.commission;

  const evRows = r.input.isElectric ? `
    <div class="row sub"><span class="k">Акциз (${Math.round(r.input.powerKw)} кВт)</span><span class="v">${fmt(r.excise)}</span></div>
    <div class="row sub"><span class="k">НДС ${Math.round(cfg.evVatPercent * 100)}%</span><span class="v">${fmt(r.vat)}</span></div>` : '';

  const expRows = r.expenses.filter(e => e.value > 0).map(e =>
    `<div class="row sub"><span class="k">${e.label}</span><span class="v">${fmt(e.value)}</span></div>`).join('');

  const stageRows = r.stages.filter(s => s.value > 0).map((s, i) =>
    `<div class="row"><span class="k">${i + 1}) ${s.label}</span><span class="v">${fmt(s.value)}</span></div>`).join('');

  // --- «утиль-ловушка»: предупреждение о пороге мощности (главный водораздел стоимости в 2026) ---
  const powerHpR = Math.round(r.input.powerHp || 0);
  let utilFlag = '';
  if (r.utilThresholdHp) {
    if (r.utilPreferentialApplied) {
      utilFlag = `<div class="row sub" style="margin:4px 0 8px;padding:8px 10px;border-radius:8px;border-left:3px solid #27ae60;background:rgba(39,174,96,.10);font-size:12.5px;line-height:1.4">✅ <b>${powerHpR} л.с.</b> — в пределах льготного порога ${r.utilThresholdHp} л.с. Утильсбор льготный: <b style="color:#27ae60">${fmt(r.utilFee)}</b>.</div>`;
    } else {
      const overpay = Math.max(0, r.utilFee - r.utilPreferentialFee);
      utilFlag = `<div class="row sub" style="margin:4px 0 8px;padding:8px 10px;border-radius:8px;border-left:3px solid #e74c3c;background:rgba(231,76,60,.10);font-size:12.5px;line-height:1.4">⚠️ <b>${powerHpR} л.с.</b> — выше льготного порога <b>${r.utilThresholdHp} л.с.</b> Утиль ${fmt(r.utilFee)} вместо льготных ${fmt(r.utilPreferentialFee)}. Переплата по утилю ≈ <b style="color:#e74c3c">${fmt(overpay)}</b>. Авто ≤${r.utilThresholdHp} л.с. попадает под льготу.</div>`;
    }
  }

  $('#result').innerHTML = `
    <div class="total">
      <div class="label">ИТОГО «под ключ»</div>
      <div class="value">${fmt(r.grandTotal)}</div>
    </div>

    <div class="sec-head"><span>Расходы по ${COUNTRY_GEN[c]}</span><span class="sec-sum">${fmt(foreignBlock)}</span></div>
    <div class="row sub"><span class="k">Цена авто</span><span class="v">${fmtNum(r.input.carPrice)} ${cur}</span></div>
    <div class="row sub"><span class="k">Доставка + фрахт</span><span class="v">${fmtNum(r.input.deliveryForeign)} ${cur}</span></div>
    <div class="row sub"><span class="k">Курс</span><span class="v">${rateDisplay(c, m)}</span></div>
    <div class="row sub"><span class="k">В рублях (итого)</span><span class="v">${fmt(r.carCostRub)}</span></div>
    ${r.bankFee > 0 ? `<div class="row sub"><span class="k">Комиссия банка (${r.bankFeePercent}%)</span><span class="v">${fmt(r.bankFee)}</span></div>` : ''}

    <div class="sec-head"><span>Таможенные платежи</span><span class="sec-sum">${fmt(r.customsTotal)}</span></div>
    <div class="row sub"><span class="k">Пошлина и таможенный сбор <span class="method-tag">(${r.dutyMethod})</span></span><span class="v">${fmt(r.duty + r.customsFee)}</span></div>
    ${evRows}
    <div class="row sub"><span class="k">Утильсбор (коэф. ${r.utilCoef})</span><span class="v">${fmt(r.utilFee)}</span></div>
    ${utilFlag}

    <div class="sec-head"><span>Услуги и расходы по РФ</span><span class="sec-sum">${fmt(rfBlock)}</span></div>
    ${expRows}
    <div class="row sub"><span class="k">Комиссия компании</span><span class="v">${r.commissionIndividual ? 'по запросу' : fmt(r.commission)}</span></div>
    ${r.commissionIndividual ? `<div class="row sub" style="margin:4px 0 8px;padding:8px 10px;border-radius:8px;border-left:3px solid #e67e22;background:rgba(230,126,34,.10);font-size:12.5px;line-height:1.4">ℹ️ Авто дороже 10 млн ₽ — <b>вознаграждение уточняется индивидуально</b>. Итог ниже — без вознаграждения.</div>` : ''}
    ${r.logistics > 0 ? `
    <div class="sec-head"><span>🚚 Логистика по РФ${r.logisticsCity ? ' — ' + escapeAttr(r.logisticsCity) : ''}</span><span class="sec-sum">${fmt(r.logistics)}</span></div>` : ''}

    <div class="row grand"><span class="k">ИТОГО под ключ</span><span class="v">${fmt(r.grandTotal)}</span></div>

    <div class="actions-cap">Без этапов оплаты:</div>
    <div class="result-actions">
      <button class="copy-btn" id="btnCopyShort">📋 Копировать</button>
      <button class="copy-btn send-btn" id="btnShareShort">📤 В чат</button>
    </div>

    <div class="section-title">Этапы оплаты</div>
    ${stageRows}

    <div class="actions-cap">Полный расчёт (с этапами):</div>
    <div class="result-actions">
      <button class="copy-btn" id="btnCopyFull">📋 Копировать</button>
      <button class="copy-btn send-btn" id="btnShareFull">📤 В чат</button>
    </div>

    <div id="baseSaveSlot"></div>
  `;
  lastResult = r;
  // в режиме «База» base.js дорисует сюда кнопку сохранения
  if (typeof onResultRendered === 'function') onResultRendered(r);
  // синхронизируем поле комиссии с фактически применённой ступенью (по цене авто)
  const commEl = $('#commission'); if (commEl) commEl.value = r.commissionIndividual ? 'по запросу' : r.commission;
  $('#result').classList.remove('hidden');
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* --- строки расчёта с разметкой (kind) — общий источник для текста и картинки ---
 * kind: title | div | divh | head (подытог секции) | item | grand (итого) | blank */
function buildTableLines(r, withStages) {
  const flags = { jp: '🇯🇵', kr: '🇰🇷', cn: '🇨🇳' };
  const ageShort = { '<3': '<3 лет', '3-5': '3-5 лет', '5-7': '5-7 лет', '>7': '>7 лет', '>3': '>3 лет' };
  const ageLabel = ageShort[r.input.age] || '';
  const params = r.input.isElectric
    ? `${ageLabel} · ${Math.round(r.input.powerKw)} кВт`
    : `${ageLabel} · ${fmtNum(r.input.volumeCc)} см³ · ${Math.round(r.input.powerHp)} л.с.`;

  const money = (n) => fmtNum(n).replace(/ /g, ' ') + ' ₽';
  const c = r.input.country;
  const mk = cfg.rates.market;
  const cur = CUR[c];

  // блоки расходов с подытогами
  const sections = [];
  const foreignItems = [
    ['  Цена авто', fmtNum(r.input.carPrice) + ' ' + cur],
    ['  Доставка+фрахт', fmtNum(r.input.deliveryForeign) + ' ' + cur],
    ['  Курс', rateCopy(c, mk)],
    ['  В рублях', money(r.carCostRub)],
  ];
  if (r.bankFee > 0) foreignItems.push([`  Банк ${r.bankFeePercent}%`, money(r.bankFee)]);
  sections.push({ head: ['РАСХОДЫ ПО ' + COUNTRY_UP[c], money(r.carCostRub + r.bankFee)], items: foreignItems });

  const customsItems = [['  Пошлина+сбор', money(r.duty + r.customsFee)]];
  if (r.input.isElectric) { customsItems.push(['  Акциз', money(r.excise)]); customsItems.push(['  НДС ' + Math.round(cfg.evVatPercent * 100) + '%', money(r.vat)]); }
  customsItems.push([`  Утиль (${r.utilCoef})`, money(r.utilFee)]);
  sections.push({ head: ['ТАМОЖНЯ', money(r.customsTotal)], items: customsItems });

  const rfItems = r.expenses.filter(e => e.value > 0).map(e => ['  ' + (e.short || e.label), money(e.value)]);
  rfItems.push(['  Комиссия', r.commissionIndividual ? 'по запросу' : money(r.commission)]);
  sections.push({ head: ['РАСХОДЫ ПО РФ', money(r.expensesSum + r.commission)], items: rfItems });

  // логистика по РФ — отдельным подытогом, город отдельной строкой
  if (r.logistics > 0) {
    const logItems = r.logisticsCity ? [['  Город', r.logisticsCity]] : [];
    sections.push({ head: ['ЛОГИСТИКА ПО РФ', money(r.logistics)], items: logItems });
  }

  // линии-разделители на всю ширину таблицы (копируется картинкой, поэтому длина не мешает)
  const W = 30;
  const line = (l, v) => (l.length + v.length + 1 > W) ? l + ' ' + v : l + ' '.repeat(W - l.length - v.length) + v;
  const thin = '─'.repeat(W);
  const heavy = '━'.repeat(W);

  const out = [];
  out.push({ text: '🚗 WT — Расчёт авто', kind: 'title' });
  out.push({ text: `${flags[c]} ${params}`, kind: 'title' });
  sections.forEach(sec => {
    out.push({ text: thin, kind: 'div' });
    out.push({ text: line(sec.head[0], sec.head[1]), kind: 'head' });
    out.push({ text: thin, kind: 'div' });
    sec.items.forEach(([l, v]) => out.push({ text: line(l, v), kind: 'item' }));
  });
  out.push({ text: heavy, kind: 'divh' });
  out.push({ text: line('ИТОГО ПОД КЛЮЧ', money(r.grandTotal)), kind: 'grand' });
  out.push({ text: heavy, kind: 'divh' });

  if (withStages !== false) {
    const stageLines = r.stages.filter(s => s.value > 0)
      .map((s, i) => `${i + 1}) ${s.short || s.label} — ${money(s.value)}`);
    out.push({ text: '', kind: 'blank' });
    out.push({ text: 'Этапы оплаты:', kind: 'item' });
    stageLines.forEach(s => out.push({ text: s, kind: 'item' }));
  }
  return out;
}

/* --- текст расчёта в код-блоке (для копирования текстом / отправки в Telegram) --- */
function buildCopyText(r, withStages) {
  return '```\n' + buildTableLines(r, withStages).map(o => o.text).join('\n') + '\n```';
}

/* --- отправка расчёта в чат ---
 * Если есть бэкенд бота — отправляем отформатированную таблицу (как при копировании)
 * через savePreparedInlineMessage + shareMessage. Иначе — чистый текст через t.me/share. */
async function shareToChat(tableText, shareText) {
  const tbl = tableText.replace(/```/g, '').replace(/^\s+|\s+$/g, ''); // таблица без ```
  if (BACKEND_URL && tg && tg.initData && tg.shareMessage &&
      tg.isVersionAtLeast && tg.isVersionAtLeast('8.0')) {
    try {
      const resp = await fetch(BACKEND_URL.replace(/\/$/, '') + '/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, text: tbl }),
      });
      const data = await resp.json();
      if (data && data.id) { tg.shareMessage(data.id); return; }
    } catch (e) { /* упадём в запасной вариант ниже */ }
  }
  // запасной вариант: чистый формат через t.me/share
  const url = 'https://t.me/share/url?url=' + encodeURIComponent(shareText);
  if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
  else if (navigator.share) navigator.share({ text: shareText }).catch(() => {});
  else window.open(url, '_blank');
}

/* --- текст для ОТПРАВКИ в чат (без код-блока: чистый список, читается в обычном шрифте) --- */
function buildShareText(r, withStages) {
  const c = r.input.country;
  const m = cfg.rates.market;
  const cur = CUR[c];
  const ageShort = { '<3': '<3 лет', '3-5': '3-5 лет', '5-7': '5-7 лет', '>7': '>7 лет', '>3': '>3 лет' };
  const flags = { jp: '🇯🇵', kr: '🇰🇷', cn: '🇨🇳' };
  const params = r.input.isElectric
    ? `${ageShort[r.input.age] || ''} · ${Math.round(r.input.powerKw)} кВт`
    : `${ageShort[r.input.age] || ''} · ${fmtNum(r.input.volumeCc)} см³ · ${Math.round(r.input.powerHp)} л.с.`;
  const money = (n) => fmtNum(n) + ' ₽';

  let t = `🚗 WT — Расчёт авто\n${flags[c]} ${params}\n\n`;
  t += `📦 Расходы по ${COUNTRY_GEN[c]}: ${money(r.carCostRub + r.bankFee)}\n`;
  t += `• Цена авто: ${fmtNum(r.input.carPrice)} ${cur}\n`;
  t += `• Доставка + фрахт: ${fmtNum(r.input.deliveryForeign)} ${cur}\n`;
  t += `• Курс: ${rateCopy(c, m)}\n`;
  t += `• В рублях: ${money(r.carCostRub)}\n`;
  if (r.bankFee > 0) t += `• Комиссия банка ${r.bankFeePercent}%: ${money(r.bankFee)}\n`;
  t += `\n🛃 Таможенные платежи: ${money(r.customsTotal)}\n`;
  t += `• Пошлина и таможенный сбор: ${money(r.duty + r.customsFee)}\n`;
  if (r.input.isElectric) { t += `• Акциз: ${money(r.excise)}\n• НДС ${Math.round(cfg.evVatPercent * 100)}%: ${money(r.vat)}\n`; }
  t += `• Утильсбор: ${money(r.utilFee)}\n`;
  t += `\n🇷🇺 Услуги и расходы по РФ: ${money(r.expensesSum + r.commission)}\n`;
  r.expenses.forEach(e => { t += `• ${e.label}: ${money(e.value)}\n`; });
  t += `• Комиссия компании: ${r.commissionIndividual ? 'по запросу (авто > 10 млн ₽)' : money(r.commission)}\n`;
  if (r.logistics > 0) t += `\n🚚 Логистика по РФ${r.logisticsCity ? ' (' + r.logisticsCity + ')' : ''}: ${money(r.logistics)}\n`;
  t += `\n💰 ИТОГО ПОД КЛЮЧ: ${money(r.grandTotal)}\n`;
  if (withStages !== false) {
    t += `\nЭтапы оплаты:\n`;
    r.stages.filter(s => s.value > 0).forEach((s, i) => { t += `${i + 1}) ${s.label} — ${money(s.value)}\n`; });
  }
  return t;
}

/* --- таблица картинкой ---
 * В МАКС/WhatsApp нет моноширинного шрифта, поэтому текстовая таблица съезжает.
 * Рисуем её в PNG (моноширинный шрифт на canvas) — картинка выглядит ровно
 * в любом мессенджере. */
function renderTableToBlob(lines) {
  return new Promise((resolve) => {
    try {
      const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
      const fs = 30, lh = 42, padX = 30, padY = 28;
      const mono = '"SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", ui-monospace, monospace';
      const fontFor = (bold) => `${bold ? 'bold ' : ''}${fs}px ${mono}`;
      // цвет и насыщенность по типу строки
      const isBold = (k) => k === 'head' || k === 'grand';
      const colorFor = (k) =>
        k === 'head'  ? '#1f9d57' :   // подытоги секций — зелёным
        k === 'grand' ? '#2563eb' :   // итого под ключ — синим
        k === 'div'   ? '#c2c7cf' :   // тонкие линии — светло-серым
        '#111111';                    // остальное — почти чёрным
      const meas = document.createElement('canvas').getContext('2d');
      let maxW = 0;
      lines.forEach(o => {
        meas.font = fontFor(isBold(o.kind));
        const w = meas.measureText(o.text).width; if (w > maxW) maxW = w;
      });
      const W = Math.ceil(maxW) + padX * 2;
      const H = lines.length * lh + padY * 2;
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * scale);
      cv.height = Math.round(H * scale);
      const ctx = cv.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      lines.forEach((o, i) => {
        ctx.font = fontFor(isBold(o.kind));
        ctx.fillStyle = colorFor(o.kind);
        ctx.fillText(o.text, padX, padY + i * lh);
      });
      cv.toBlob((b) => resolve(b), 'image/png');
    } catch (e) { resolve(null); }
  });
}

/* --- скопировать текущий расчёт картинкой (с запасным вариантом текстом) ---
 * full=true — полный расчёт с этапами оплаты. */
async function copyCalcImage(full) {
  if (!lastResult) return false;
  // сначала пробуем картинкой (ровно в МАКС/WhatsApp), иначе — текстом
  const okImg = await copyTableAsImage(buildTableLines(lastResult, full));
  if (okImg) {
    haptic('medium');
    toast('✅ Таблица скопирована картинкой — вставьте в чат');
    return true;
  }
  const ok = await copyToClipboard(buildCopyText(lastResult, full));
  haptic(ok ? 'medium' : 'light');
  toast(ok ? '✅ Скопировано — вставьте в чат' : 'Не удалось скопировать');
  return ok;
}

async function copyTableAsImage(lines) {
  if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) return false;
  // Safari/iOS принимает Promise<Blob> в ClipboardItem прямо в обработчике клика
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderTableToBlob(lines) })]);
    return true;
  } catch (e) {
    try {
      const blob = await renderTableToBlob(lines);
      if (!blob) return false;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    } catch (e2) { return false; }
  }
}

/* --- копирование в буфер обмена с запасным вариантом --- */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }
}

function hideResult() { $('#result').classList.add('hidden'); }

/* ============================ НАСТРОЙКИ ============================ */
function openSettings() { fillSettings(); showScreen('screenSettings'); }
function closeSettings() { showScreen('screenCalc'); }

function fillSettings() {
  $$('[data-rate]').forEach(el => {
    const [grp, key] = el.dataset.rate.split('.');
    el.value = String(cfg.rates[grp][key]).replace('.', ',');
  });
  $$('[data-ev]').forEach(el => { el.value = String(cfg[el.dataset.ev]).replace('.', ','); });
}

function saveSettings() {
  const parseComma = (s) => parseFloat((s || '').toString().replace(',', '.'));
  const patch = { rates: { cbr: {}, market: {} } };
  $$('[data-rate]').forEach(el => {
    const [grp, key] = el.dataset.rate.split('.');
    const v = parseComma(el.value);
    if (!isNaN(v)) patch.rates[grp][key] = v;
  });
  $$('[data-ev]').forEach(el => {
    const v = parseComma(el.value);
    if (!isNaN(v)) patch[el.dataset.ev] = v;
  });
  patchOverrides(patch);
  cfg = buildConfig();
  renderCountry();      // отразить новые ставки на главном экране
  renderRatesPanel();   // и панель курсов
  toast('Настройки сохранены');
  closeSettings();
}

document.addEventListener('DOMContentLoaded', init);

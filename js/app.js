/* =========================================================================
 *  app.js — логика интерфейса Mini App
 * ========================================================================= */
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const inTelegram = !!(tg && tg.initData !== undefined && tg.platform && tg.platform !== 'unknown');

/* --- состояние --- */
const state = {
  country: 'jp',
  isElectric: false,
  isSanctioned: false,  // санкционное авто (Япония)
  isNotDvfo: false,     // не из ДВФО → нужна врем. регистрация (+15 000 ₽)
  powerUnit: 'hp',
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
  { key: 'KRW_per_USDT', label: 'вон за 1 USDT', step: 1 },
  { key: 'USDT_RUB', label: 'USDT → ₽', step: 0.01 },
];

/* --- утилиты --- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const num = (el) => { const v = parseFloat(($(el).value || '').toString().replace(',', '.')); return isNaN(v) ? 0 : v; };
const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');

let cfg = buildConfig();
let lastCopyText = '';
let currentExpenseItems = [];

/* ============================ ИНИЦИАЛИЗАЦИЯ ============================ */
function init() {
  if (tg) { tg.ready(); tg.expand(); }
  renderCountry();
  renderAuctions();
  renderRatesPanel();
  bindEvents();
  loadCbr();
  setupMainButton();
  setupKeyboardDone();
}

/* --- кнопка «Рассчитать» --- */
function setupMainButton() {
  if (inTelegram) {
    tg.MainButton.setText('Рассчитать стоимость').show();
    tg.MainButton.onClick(onCalculate);
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
  $('#rateSummary').textContent = `¥100 ${m.JPY100_ATB} · CNY ${m.CNY} · USDT ${m.USDT_RUB}`;
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
  box.innerHTML = items.map((it, i) => `
    <div class="exp-item">
      <span class="exp-label">${it.label}</span>
      <input type="number" inputmode="numeric" data-exp="${i}" value="${it.value}">
    </div>`).join('');
  $('#commission').value = preset.commission;
  $('#bankFee').value = String(preset.bankFeePercent != null ? preset.bankFeePercent : 0).replace('.', ',');
}

/* ============================ СОБЫТИЯ ============================ */
function bindEvents() {
  $$('#countryTabs .seg').forEach(b => b.addEventListener('click', () => {
    state.country = b.dataset.country;
    haptic('light');
    renderCountry();
    hideResult();
  }));

  $('#isElectric').addEventListener('change', (e) => {
    state.isElectric = e.target.checked;
    renderCountry();
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
    $$('.unit').forEach(x => x.classList.toggle('active', x === u));
  }));

  // копирование расчёта (кнопка появляется внутри результата)
  $('#result').addEventListener('click', async (e) => {
    if (e.target && e.target.id === 'btnCopy') {
      const ok = await copyToClipboard(lastCopyText);
      haptic(ok ? 'medium' : 'light');
      toast(ok ? '✅ Расчёт скопирован — вставьте в чат' : 'Не удалось скопировать');
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
  };

  if (!input.carPrice) { toast('Укажите цену авто'); return; }
  if (!state.isElectric && !input.volumeCc) { toast('Укажите объём двигателя'); return; }
  if (!powerVal) { toast('Укажите мощность двигателя'); return; }

  const r = calculate(input, cfg);
  renderResult(r);
}

/* родительный падеж страны + флаг для подзаголовка */
const COUNTRY_GEN = { jp: 'Японии 🇯🇵', kr: 'Корее 🇰🇷', cn: 'Китаю 🇨🇳' };
const COUNTRY_UP = { jp: 'ЯПОНИИ', kr: 'КОРЕЕ', cn: 'КИТАЮ' };

/* строка курса для экрана */
function rateDisplay(c, m) {
  if (c === 'jp') return `¥100 = ${m.JPY100_ATB} ₽`;
  if (c === 'cn') return `¥ = ${m.CNY} ₽`;
  if (c === 'kr') return `${fmtNum(m.KRW_per_USDT)} ₩ = 1 USDT · 1 USDT = ${m.USDT_RUB} ₽`;
  return '';
}
/* строка курса для копирования (компактная) */
function rateCopy(c, m) {
  if (c === 'jp') return `¥100=${m.JPY100_ATB}₽`;
  if (c === 'cn') return `¥=${m.CNY}₽`;
  if (c === 'kr') return `${fmtNum(m.KRW_per_USDT)}₩/USDT · USDT=${m.USDT_RUB}₽`;
  return '';
}

function renderResult(r) {
  const c = r.input.country;
  const m = cfg.rates.market;
  const cur = CUR[c];
  const foreignBlock = r.carCostRub + r.bankFee;
  const rfBlock = r.expensesSum + r.commission;

  const evRows = r.input.isElectric ? `
    <div class="row sub"><span class="k">Акциз (${fmtNum(r.input.powerHp)} л.с.)</span><span class="v">${fmt(r.excise)}</span></div>
    <div class="row sub"><span class="k">НДС 20%</span><span class="v">${fmt(r.vat)}</span></div>` : '';

  const expRows = r.expenses.map(e =>
    `<div class="row sub"><span class="k">${e.label}</span><span class="v">${fmt(e.value)}</span></div>`).join('');

  const stageRows = r.stages.filter(s => s.value > 0).map((s, i) =>
    `<div class="row"><span class="k">${i + 1}) ${s.label}</span><span class="v">${fmt(s.value)}</span></div>`).join('');

  $('#result').innerHTML = `
    <div class="total">
      <div class="label">ИТОГО «под ключ»</div>
      <div class="value">${fmt(r.grandTotal)}</div>
    </div>

    <div class="sec-head"><span>Расходы по ${COUNTRY_GEN[c]}</span><span class="sec-sum">${fmt(foreignBlock)}</span></div>
    <div class="row sub"><span class="k">Цена авто + доставка</span><span class="v">${fmtNum(r.foreignTotal)} ${cur}</span></div>
    <div class="row sub"><span class="k">Курс</span><span class="v">${rateDisplay(c, m)}</span></div>
    <div class="row sub"><span class="k">В рублях</span><span class="v">${fmt(r.carCostRub)}</span></div>
    ${r.bankFee > 0 ? `<div class="row sub"><span class="k">Комиссия банка (${r.bankFeePercent}%)</span><span class="v">${fmt(r.bankFee)}</span></div>` : ''}

    <div class="sec-head"><span>Таможенные платежи</span><span class="sec-sum">${fmt(r.customsTotal)}</span></div>
    <div class="row sub"><span class="k">Пошлина и таможенный сбор <span class="method-tag">(${r.dutyMethod})</span></span><span class="v">${fmt(r.duty + r.customsFee)}</span></div>
    ${evRows}
    <div class="row sub"><span class="k">Утильсбор (коэф. ${r.utilCoef})</span><span class="v">${fmt(r.utilFee)}</span></div>

    <div class="sec-head"><span>Услуги и расходы по РФ</span><span class="sec-sum">${fmt(rfBlock)}</span></div>
    ${expRows}
    <div class="row sub"><span class="k">Комиссия компании</span><span class="v">${fmt(r.commission)}</span></div>

    <div class="row grand"><span class="k">ИТОГО под ключ</span><span class="v">${fmt(r.grandTotal)}</span></div>

    <div class="section-title">Этапы оплаты</div>
    ${stageRows}

    <button class="copy-btn" id="btnCopy">📋 Скопировать расчёт для клиента</button>
  `;
  lastCopyText = buildCopyText(r);
  $('#result').classList.remove('hidden');
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* --- сборка текста расчёта (клиентская короткая версия, код-блок) --- */
function buildCopyText(r) {
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
    ['  Авто+доставка', fmtNum(r.foreignTotal) + ' ' + cur],
    ['  Курс', rateCopy(c, mk)],
    ['  В рублях', money(r.carCostRub)],
  ];
  if (r.bankFee > 0) foreignItems.push([`  Банк ${r.bankFeePercent}%`, money(r.bankFee)]);
  sections.push({ head: ['РАСХОДЫ ПО ' + COUNTRY_UP[c], money(r.carCostRub + r.bankFee)], items: foreignItems });

  const customsItems = [['  Пошлина+сбор', money(r.duty + r.customsFee)]];
  if (r.input.isElectric) { customsItems.push(['  Акциз', money(r.excise)]); customsItems.push(['  НДС 20%', money(r.vat)]); }
  customsItems.push([`  Утиль (${r.utilCoef})`, money(r.utilFee)]);
  sections.push({ head: ['ТАМОЖНЯ', money(r.customsTotal)], items: customsItems });

  const rfItems = r.expenses.map(e => ['  ' + (e.short || e.label), money(e.value)]);
  rfItems.push(['  Комиссия', money(r.commission)]);
  sections.push({ head: ['РАСХОДЫ ПО РФ', money(r.expensesSum + r.commission)], items: rfItems });

  // фикс. ширина 30; подытоги — ЗАГЛАВНЫМИ + тонкие линии-разделители, итог — толстой линией
  const W = 30;
  const line = (l, v) => (l.length + v.length + 1 > W) ? l + ' ' + v : l + ' '.repeat(W - l.length - v.length) + v;
  const thin = '─'.repeat(W);
  const heavy = '━'.repeat(W);

  let body = '';
  sections.forEach(sec => {
    // подытог обрамлён линиями сверху и снизу — выделяется отдельной полосой
    body += thin + '\n' + line(sec.head[0], sec.head[1]) + '\n' + thin + '\n';
    sec.items.forEach(([l, v]) => { body += line(l, v) + '\n'; });
  });

  const stageLines = r.stages.filter(s => s.value > 0)
    .map((s, i) => `${i + 1}) ${s.short || s.label} — ${money(s.value)}`);

  return '```\n'
    + `🚗 WT — Расчёт авто\n`
    + `${flags[c]} ${params}\n`
    + body
    + heavy + '\n'
    + line('ИТОГО ПОД КЛЮЧ', money(r.grandTotal)) + '\n'
    + heavy + '\n\n'
    + 'Этапы оплаты:\n'
    + stageLines.join('\n') + '\n'
    + '```';
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
function openSettings() { fillSettings(); $('#screenCalc').classList.add('hidden'); $('#screenSettings').classList.remove('hidden'); if (inTelegram) tg.MainButton.hide(); }
function closeSettings() { $('#screenSettings').classList.add('hidden'); $('#screenCalc').classList.remove('hidden'); if (inTelegram) tg.MainButton.show(); }

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

/* =========================================================================
 *  app.js — логика интерфейса Mini App
 * ========================================================================= */
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const inTelegram = !!(tg && tg.initData !== undefined && tg.platform && tg.platform !== 'unknown');

/* --- состояние --- */
const state = {
  country: 'jp',
  isElectric: false,
  powerUnit: 'hp',
};

const CUR = { jp: '¥', cn: '¥', kr: '₩' };

/* --- утилиты --- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const num = (el) => { const v = parseFloat(($(el).value || '').toString().replace(',', '.')); return isNaN(v) ? 0 : v; };
const fmt = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');

let cfg = buildConfig();
let lastCopyText = '';

/* ============================ ИНИЦИАЛИЗАЦИЯ ============================ */
function init() {
  if (tg) { tg.ready(); tg.expand(); }
  renderCountry();
  renderAuctions();
  bindEvents();
  loadCbr();
  setupMainButton();
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
  // банк и аукцион — только Япония
  $('#fieldBank').classList.toggle('hidden', state.country !== 'jp');
  $('#fieldAuction').classList.toggle('hidden', state.country !== 'jp');
  // объём — скрыт для электрокара
  $('#fieldVolume').classList.toggle('hidden', state.isElectric);
  // возраст
  renderAgeOptions();
  // расходы по РФ + комиссия из пресета
  renderExpenses();
}

function renderAgeOptions() {
  const opts = state.isElectric ? CALC_DATA.ageOptionsEv : CALC_DATA.ageOptions;
  $('#age').innerHTML = opts.map(o => `<option value="${o.id}">${o.label}</option>`).join('');
}

function renderAuctions() {
  $('#auction').innerHTML =
    '<option value="">— выбрать аукцион —</option>' +
    CALC_DATA.auctions.map((a, i) => `<option value="${i}">${a.name} — ${fmtNum(a.fob)} ¥</option>`).join('');
}

function renderExpenses() {
  const preset = cfg.expensePresets[state.country];
  const box = $('#expenseList');
  box.innerHTML = preset.items.map((it, i) => `
    <div class="exp-item">
      <span class="exp-label">${it.label}</span>
      <input type="number" inputmode="numeric" data-exp="${i}" value="${it.value}">
    </div>`).join('');
  $('#commission').value = preset.commission;
  $('#bankFee').value = preset.bankFeePercent != null ? preset.bankFeePercent : 0;
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
      resetOverrides(); cfg = buildConfig(); fillSettings(); renderExpenses();
      toast('Сброшено');
    }
  });
  $('#btnRefreshCbr').addEventListener('click', async () => {
    try { const f = await fetchCbr(); cfg = buildConfig(); fillSettings(); showCbrStatus(f); toast('Курсы ЦБ обновлены'); }
    catch (e) { toast('Не удалось обновить курсы'); }
  });
}

function haptic(style) { try { if (tg) tg.HapticFeedback.impactOccurred(style); } catch (e) {} }
function toast(msg) { if (tg && tg.showPopup) { try { tg.showPopup({ message: msg }); return; } catch(e){} } alert(msg); }

/* ============================ РАСЧЁТ ============================ */
function onCalculate() {
  haptic('medium');
  // свернуть клавиатуру, чтобы не мешала смотреть результат
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const preset = cfg.expensePresets[state.country];
  const expenses = $$('#expenseList [data-exp]').map((el, i) => ({
    label: preset.items[i].label, value: parseFloat(el.value) || 0,
  }));

  const powerVal = num('#power');
  const input = {
    country: state.country,
    isElectric: state.isElectric,
    age: $('#age').value,
    volumeCc: state.isElectric ? 0 : num('#volume'),
    powerHp: state.powerUnit === 'hp' ? powerVal : null,
    powerKw: state.powerUnit === 'kw' ? powerVal : null,
    carPrice: num('#carPrice'),
    deliveryForeign: num('#delivery'),
    bankFeePercent: num('#bankFee'),
    bank: $('#bank').value,
    commission: num('#commission'),
    expenses,
  };

  if (!input.carPrice) { toast('Укажите цену авто'); return; }
  if (!state.isElectric && !input.volumeCc) { toast('Укажите объём двигателя'); return; }
  if (!powerVal) { toast('Укажите мощность двигателя'); return; }

  const r = calculate(input, cfg);
  renderResult(r);
}

function renderResult(r) {
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

    <div class="row"><span class="k">Цена авто + доставка</span><span class="v">${fmt(r.carCostRub)}</span></div>
    ${r.bankFee > 0 ? `<div class="row sub"><span class="k">Комиссия банка за перевод (${r.bankFeePercent}%)</span><span class="v">${fmt(r.bankFee)}</span></div>` : ''}
    <div class="row"><span class="k">Таможенная стоимость (ЦБ)</span><span class="v">${fmt(r.customsValueRub)}</span></div>

    <div class="section-title">Таможенные платежи</div>
    <div class="row sub"><span class="k">Пошлина <span class="method-tag">(${r.dutyMethod})</span></span><span class="v">${fmt(r.duty)}</span></div>
    ${evRows}
    <div class="row sub"><span class="k">Таможенный сбор</span><span class="v">${fmt(r.customsFee)}</span></div>
    <div class="row sub"><span class="k">Утильсбор (коэф. ${r.utilCoef})</span><span class="v">${fmt(r.utilFee)}</span></div>

    <div class="section-title">Услуги и расходы по РФ</div>
    ${expRows}
    <div class="row sub"><span class="k">Комиссия компании</span><span class="v">${fmt(r.commission)}</span></div>

    <div class="row grand"><span class="k">ИТОГО</span><span class="v">${fmt(r.grandTotal)}</span></div>

    <div class="section-title">Этапы оплаты</div>
    ${stageRows}

    <button class="copy-btn" id="btnCopy">📋 Скопировать расчёт</button>
  `;
  lastCopyText = buildCopyText(r);
  $('#result').classList.remove('hidden');
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* --- сборка текста расчёта (клиентская короткая версия, код-блок) --- */
function buildCopyText(r) {
  const flags = { jp: '🇯🇵', kr: '🇰🇷', cn: '🇨🇳' };
  const ageOpts = r.input.isElectric ? CALC_DATA.ageOptionsEv : CALC_DATA.ageOptions;
  const ageLabel = (ageOpts.find(o => o.id === r.input.age) || {}).label || '';
  const params = r.input.isElectric
    ? `${ageLabel} · ${Math.round(r.input.powerKw)} кВт`
    : `${ageLabel} · ${fmtNum(r.input.volumeCc)} см³ · ${Math.round(r.input.powerHp)} л.с.`;

  const money = (n) => fmtNum(n).replace(/ /g, ' ') + ' ₽';
  const rows = [
    ['Авто + доставка', money(r.carCostRub + r.bankFee)],
    ['Таможенные платежи', money(r.customsTotal)],
    ['Услуги и оформление', money(r.expensesSum)],
    ['Комиссия', money(r.commission)],
  ];
  const totalRow = ['ИТОГО под ключ', money(r.grandTotal)];

  // ширина столбца для выравнивания значений по правому краю
  const w = Math.max(...rows.concat([totalRow]).map(([l, v]) => l.length + v.length)) + 3;
  const line = (l, v) => l + ' '.repeat(Math.max(1, w - l.length - v.length)) + v;
  const div = '━'.repeat(w);

  return '```\n'
    + `🚗 WT — Расчёт авто\n`
    + `${flags[r.input.country]} ${params}\n`
    + `${div}\n`
    + rows.map(([l, v]) => line(l, v)).join('\n') + '\n'
    + `${div}\n`
    + line(totalRow[0], totalRow[1]) + '\n'
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
    el.value = cfg.rates[grp][key];
  });
  $$('[data-ev]').forEach(el => { el.value = cfg[el.dataset.ev]; });
}

function saveSettings() {
  const patch = { rates: { cbr: {}, market: {} } };
  $$('[data-rate]').forEach(el => {
    const [grp, key] = el.dataset.rate.split('.');
    const v = parseFloat(el.value);
    if (!isNaN(v)) patch.rates[grp][key] = v;
  });
  $$('[data-ev]').forEach(el => {
    const v = parseFloat(el.value);
    if (!isNaN(v)) patch[el.dataset.ev] = v;
  });
  patchOverrides(patch);
  cfg = buildConfig();
  toast('Настройки сохранены');
  closeSettings();
}

document.addEventListener('DOMContentLoaded', init);

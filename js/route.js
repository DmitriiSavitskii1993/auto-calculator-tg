/* =========================================================================
 *  route.js — раздел «Маршруты».
 *
 *  Китай: граница Уссурийск или Хоргос, растаможка в РФ (пошлина для физлица
 *  тем же calculate(), что и в основном калькуляторе) или в Бишкеке (пошлина
 *  и брокер Киргизии — одной суммой в долларах, утильсбор РФ — нашим движком).
 *  Логистика до Москвы/Питера — в долларах, у б/у через Хоргос — фикс в юанях.
 *  Брокер «под ключ» — в рублях.
 *  Корея: считается как в основном калькуляторе.
 *
 *  Коллегам из ROUTE_ONLY_IDS приложение показывает только этот раздел.
 * ========================================================================= */

// Telegram ID коллег, которым доступен только этот раздел (свой ID бот
// подскажет по команде /id)
const ROUTE_ONLY_IDS = [485810934];

const ROUTE_KEY = 'wt_route_inputs_v1';
const ROUTE_RATE_FIELDS = [
  { key: 'CNY', label: '¥ (CNY) → ₽' },
  { key: 'USD', label: '$ → ₽' },
];
const ROUTE_BORDER = { ussuriysk: 'Уссурийск', khorgos: 'Хоргос' };
const ROUTE_CITY = { msk: 'Москва', spb: 'Питер' };

const routeState = {
  country: 'cn', border: 'ussuriysk', customs: 'rf', city: 'msk', condition: 'used',
  isElectric: false, powerUnit: 'hp', util2027: false,
};
let routeLast = null;   // { lines, plain } последнего расчёта — для копирования и отправки

function isRouteOnly() {
  const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  return !!(u && ROUTE_ONLY_IDS.indexOf(Number(u.id)) !== -1);
}

/* --- расчёт (чистая функция, без DOM) ---
 * inp = { country, carPrice, deliveryForeign, border, customs, city, condition,
 *         kgDutyUsd, isElectric, age, volumeCc, powerHp, powerKw } */
function calculateRoute(inp, conf) {
  const engineInput = {
    country: inp.country, isElectric: !!inp.isElectric, age: inp.age,
    volumeCc: inp.isElectric ? 0 : (inp.volumeCc || 0),
    powerHp: inp.powerHp, powerKw: inp.powerKw,
    carPrice: inp.carPrice,
    util2027: !!inp.util2027,
  };

  if (inp.country === 'kr') {
    const p = conf.expensePresets.kr;
    const r = calculate(Object.assign(engineInput, {
      deliveryForeign: koreaDeliveryWon(inp.carPrice, conf),
      bankFeePercent: p.bankFeePercent || 0,
      commission: p.commission, commissionManual: false,
      expenses: p.items.map((i) => ({ key: i.key, label: i.label, short: i.short || i.label, value: i.value })),
    }), conf);
    return { country: 'kr', r, total: r.grandTotal };
  }

  const R = conf.routeCn || CALC_DATA.routeCn;
  const viaKg = inp.customs === 'kg';
  const border = viaKg ? 'khorgos' : inp.border;
  // б/у через Хоргос: одна сумма в юанях за всю дорогу до Москвы/Питера
  // (вместо долларовых ставок, включая Хоргос → Бишкек). Платится в Китай
  // вместе с машиной — поэтому входит в расходы по Китаю и под комиссию банка.
  const usedKhorgos = border === 'khorgos' && inp.condition === 'used';
  // Доставка 15 000 ¥ — только до Уссурийска. Логистику Хоргоса движку
  // доставкой не передаём: иначе она попала бы в таможенную стоимость.
  const r = calculate(Object.assign(engineInput, {
    deliveryForeign: border === 'ussuriysk' ? (inp.deliveryForeign || 0) : 0,
    bankFeePercent: R.bankFeePercent,
    commission: 0, commissionManual: true, expenses: [],
  }), conf);
  const usd = conf.rates.market.USD;
  // Бишкек: пошлину платим там, но утильсбор РФ — всё равно наш
  const customs = viaKg ? r.utilFee : r.customsTotal;
  const kgTransitUsd = viaKg && !usedKhorgos ? R.kgTransitUsd : 0;
  const kgDutyUsd = viaKg ? (inp.kgDutyUsd || 0) : 0;
  const kgUsd = kgTransitUsd + kgDutyUsd;
  const logisticsCny = usedKhorgos ? R.usedKhorgosLogisticsCny : 0;
  const logisticsUsd = usedKhorgos ? 0 : (viaKg ? R.kgLogisticsUsd : R.rfLogisticsUsd)[inp.city];
  const logisticsRub = usedKhorgos ? logisticsCny * conf.rates.market.CNY : logisticsUsd * usd;
  const logisticsBankFee = usedKhorgos ? logisticsRub * R.bankFeePercent / 100 : 0;
  const carBlock = r.carCostRub + r.bankFee + (usedKhorgos ? logisticsRub + logisticsBankFee : 0);
  const broker = R.brokerRub[border + (viaKg ? '_kg' : '_rf')];
  const total = carBlock + customs + kgUsd * usd + (usedKhorgos ? 0 : logisticsRub) + broker;
  return {
    country: 'cn', r, viaKg, border, city: inp.city, usd, usedKhorgos,
    carBlock, customs,
    kgTransitUsd, kgDutyUsd, kgUsd, kgRub: kgUsd * usd,
    logisticsUsd, logisticsCny, logisticsRub, logisticsBankFee,
    broker, total,
  };
}

/* --- результат секциями: из них собираются и экран, и таблица для клиента --- */
function routeSections(x, conf) {
  const r = x.r;
  const money = (n) => fmtNum(n) + ' ₽';
  const usd = (n) => '$' + fmtNum(n);
  const age = { '<3': '<3 лет', '3-5': '3-5 лет', '5-7': '5-7 лет', '>7': '>7 лет', '>3': '>3 лет' }[r.input.age] || '';
  const params = r.input.isElectric
    ? `${age} · ${Math.round(r.input.powerKw)} кВт`
    : `${age} · ${fmtNum(r.input.volumeCc)} см³ · ${Math.round(r.input.powerHp)} л.с.`;
  const m = conf.rates.market;
  const S = [];

  if (x.country === 'kr') {
    const foreign = [['Цена авто', fmtNum(r.input.carPrice) + ' ₩'], ['Доставка+фрахт', fmtNum(r.input.deliveryForeign) + ' ₩'],
      ['Курс', rateCopy('kr', m)], ['В рублях', money(r.carCostRub)]];
    if (r.bankFee > 0) foreign.push([`Банк ${r.bankFeePercent}%`, money(r.bankFee)]);
    S.push({ head: ['РАСХОДЫ ПО КОРЕЕ', money(r.carCostRub + r.bankFee)], items: foreign });
    S.push({ head: ['ТАМОЖНЯ', money(r.customsTotal)], items: routeCustomsItems(r, conf, money) });
    const rf = r.expenses.filter((e) => e.value > 0).map((e) => [e.short || e.label, money(e.value)]);
    rf.push(['Комиссия', r.commissionIndividual ? 'по запросу' : money(r.commission)]);
    S.push({ head: ['РАСХОДЫ ПО РФ', money(r.expensesSum + r.commission)], items: rf });
    return { title: '🇰🇷 Корея → Владивосток', params, sections: S, totalLabel: 'ИТОГО ПОД КЛЮЧ' };
  }

  const foreign = [['Цена авто', fmtNum(r.input.carPrice) + ' ¥']];
  if (r.input.deliveryForeign) foreign.push(['До Уссурийска', fmtNum(r.input.deliveryForeign) + ' ¥']);
  if (x.usedKhorgos) foreign.push(['Логистика до ' + (x.city === 'msk' ? 'Москвы' : 'Питера'), fmtNum(x.logisticsCny) + ' ¥']);
  const inRub = r.carCostRub + (x.usedKhorgos ? x.logisticsRub : 0);
  const bank = r.bankFee + x.logisticsBankFee;
  foreign.push(['Курс', rateCopy('cn', m)], ['В рублях', money(inRub)]);
  if (bank > 0) foreign.push([`Банк ${r.bankFeePercent}%`, money(bank)]);
  S.push({ head: ['РАСХОДЫ ПО КИТАЮ', money(x.carBlock)], items: foreign });

  const route = ROUTE_BORDER[x.border] + (x.viaKg ? ' → Бишкек' : '') + ' → ' + ROUTE_CITY[x.city];
  if (x.viaKg) {
    const kg = [];
    if (x.kgTransitUsd) kg.push(['Хоргос → Бишкек', usd(x.kgTransitUsd)]);
    kg.push(['Пошлина+брокер КР', x.kgDutyUsd ? usd(x.kgDutyUsd) : 'не указано']);
    kg.push(['Курс', '$=' + m.USD + '₽']);
    S.push({ head: ['БИШКЕК', money(x.kgRub)], items: kg });
    S.push({ head: ['УТИЛЬСБОР РФ', money(x.customs)], items: routeUtilItems(r, money) });
  } else {
    S.push({ head: ['ТАМОЖНЯ РФ', money(x.customs)], items: routeCustomsItems(r, conf, money) });
  }
  if (!x.usedKhorgos) {
    S.push({ head: ['ЛОГИСТИКА', money(x.logisticsRub)], items: [
      [(x.viaKg ? 'Бишкек' : ROUTE_BORDER[x.border]) + ' → ' + ROUTE_CITY[x.city], usd(x.logisticsUsd)],
      ['Курс', '$=' + m.USD + '₽']] });
  }
  S.push({ head: ['БРОКЕР', money(x.broker)], items: [['Услуги под ключ', money(x.broker)]] });
  return { title: '🇨🇳 ' + route + (x.border === 'khorgos' ? (x.usedKhorgos ? ' · б/у' : ' · новый') : ''), params, sections: S, totalLabel: 'ИТОГО ДО ' + (x.city === 'msk' ? 'МОСКВЫ' : 'ПИТЕРА') };
}

function routeCustomsItems(r, conf, money) {
  const items = [['Пошлина+сбор', money(r.duty + r.customsFee)]];
  if (r.input.isElectric) {
    items.push(['Акциз', money(r.excise)]);
    items.push(['НДС ' + Math.round(conf.evVatPercent * 100) + '%', money(r.vat)]);
  }
  return items.concat(routeUtilItems(r, money));
}

/* Утиль: по ставке 2027 — так и подписываем; иначе у коммерческого — сноска,
 * сколько он будет стоить в 2027 году (льготный не индексируется). */
function routeUtilItems(r, money) {
  if (r.utilUsesNext) return [[`Утиль ${r.utilNextYear} (${r.utilCoef})`, money(r.utilFee)]];
  const items = [[`Утиль (${r.utilCoef})`, money(r.utilFee)]];
  if (r.utilFeeNext) items.push([`↳ утиль ${r.utilNextYear}`, money(r.utilFeeNext)]);
  return items;
}

/* Таблица в том же формате, что и в основном калькуляторе: kind управляет
 * цветом и жирностью на картинке. */
function routeLines(view, total) {
  const W = 30;
  const line = (l, v) => (l.length + v.length + 1 > W) ? l + ' ' + v : l + ' '.repeat(W - l.length - v.length) + v;
  const thin = '─'.repeat(W);
  const heavy = '━'.repeat(W);
  const out = [{ text: '🚗 WT — Расчёт авто', kind: 'title' }, { text: view.title, kind: 'title' }];
  if (view.params) out.push({ text: view.params, kind: 'title' });
  view.sections.forEach((s) => {
    out.push({ text: thin, kind: 'div' });
    out.push({ text: line(s.head[0], s.head[1]), kind: 'head' });
    out.push({ text: thin, kind: 'div' });
    s.items.forEach(([l, v]) => out.push({ text: line('  ' + l, v), kind: 'item' }));
  });
  out.push({ text: heavy, kind: 'divh' });
  out.push({ text: line(view.totalLabel, fmtNum(total) + ' ₽'), kind: 'grand' });
  out.push({ text: heavy, kind: 'divh' });
  return out;
}

function routePlainText(view, total) {
  const L = ['🚗 WT — Расчёт авто', view.title];
  if (view.params) L.push(view.params);
  view.sections.forEach((s) => {
    L.push('', s.head[0] + ': ' + s.head[1]);
    s.items.forEach(([l, v]) => L.push('• ' + l + ': ' + v));
  });
  L.push('', view.totalLabel + ': ' + fmtNum(total) + ' ₽');
  return L.join('\n');
}

/* --- форма --- */
function routeNum(sel) {
  const el = $(sel);
  const v = parseFloat(((el && el.value) || '').toString().replace(/\s/g, '').replace(',', '.'));
  return isNaN(v) ? 0 : v;
}

function routeRender() {
  const s = routeState;
  const isCn = s.country === 'cn';
  if (s.border === 'ussuriysk') s.customs = 'rf';   // через Уссурийск — только таможня РФ
  const viaKg = isCn && s.customs === 'kg';

  $$('#routeCountry .seg').forEach((b) => b.classList.toggle('active', b.dataset.v === s.country));
  $$('#routeBorder .seg').forEach((b) => b.classList.toggle('active', b.dataset.v === s.border));
  $$('#routeCustoms .seg').forEach((b) => b.classList.toggle('active', b.dataset.v === s.customs));
  $$('#routeCity .seg').forEach((b) => b.classList.toggle('active', b.dataset.v === s.city));
  $$('#routeCondition .seg').forEach((b) => b.classList.toggle('active', b.dataset.v === s.condition));
  $$('#routePowerUnit .unit').forEach((b) => b.classList.toggle('active', b.dataset.unit === s.powerUnit));
  const kgBtn = $('#routeCustoms [data-v="kg"]');
  if (kgBtn) kgBtn.disabled = s.border === 'ussuriysk';

  $('#routeCur').textContent = isCn ? '¥' : '₩';
  $('#routeCnBlock').classList.toggle('hidden', !isCn);
  $('#routeKgBlock').classList.toggle('hidden', !viaKg);
  const usedKhorgos = isCn && s.border === 'khorgos' && s.condition === 'used';
  $('#routeDutyBlock').classList.toggle('hidden', false);
  $('#routeDutyTitle').textContent = viaKg ? 'Для расчёта утильсбора РФ' : 'Для расчёта пошлины (физлицо)';
  $('#routeDeliveryField').classList.toggle('hidden', s.border !== 'ussuriysk');
  $('#routeConditionField').classList.toggle('hidden', s.border !== 'khorgos');
  $('#routeVolumeField').classList.toggle('hidden', s.isElectric);
  $('#routeIsElectric').checked = s.isElectric;
  $('#routeUtil2027').checked = s.util2027;

  const R = cfg.routeCn || CALC_DATA.routeCn;
  const prices = viaKg ? R.kgLogisticsUsd : R.rfLogisticsUsd;
  $$('#routeCity .seg').forEach((b) => {
    b.textContent = ROUTE_CITY[b.dataset.v] + (usedKhorgos ? '' : ' $' + fmtNum(prices[b.dataset.v]));
  });
  const brokerKey = (viaKg ? 'khorgos' : s.border) + (viaKg ? '_kg' : '_rf');
  $('#routeBrokerHint').textContent = 'Брокер под ключ: ' + fmtNum(R.brokerRub[brokerKey]) + ' ₽' +
    (usedKhorgos ? ' · логистика б/у до Москвы/Питера ' + fmtNum(R.usedKhorgosLogisticsCny) + ' ¥'
      : (viaKg ? ' · Хоргос → Бишкек $' + fmtNum(R.kgTransitUsd) : ''));

  const ageSel = $('#routeAge');
  const opts = s.isElectric ? CALC_DATA.ageOptionsEv : CALC_DATA.ageOptions;
  const prev = ageSel.value;
  ageSel.innerHTML = opts.map((o) => `<option value="${o.id}">${o.label}</option>`).join('');
  if (opts.some((o) => o.id === prev)) ageSel.value = prev;
}

function routeRenderRates() {
  const m = cfg.rates.market;
  $('#routeRates').innerHTML = ROUTE_RATE_FIELDS.map((f) =>
    `<label>${f.label}<input type="text" inputmode="decimal" data-rrate="${f.key}" value="${String(m[f.key] == null ? '' : m[f.key]).replace('.', ',')}"></label>`
  ).join('');
  routeRateSummary();
}

/* курсы в свёрнутом заголовке — видно, по каким считаем, не раскрывая */
function routeRateSummary() {
  const v = (k) => {
    const el = $('#routeRates [data-rrate="' + k + '"]');
    return el && el.value ? el.value : '—';
  };
  $('#routeRateSummary').textContent = '¥ ' + v('CNY') + ' · $ ' + v('USD');
}

function routeApplyRates() {
  const patch = {};
  $$('#routeRates [data-rrate]').forEach((el) => {
    const v = parseFloat((el.value || '').replace(',', '.'));
    if (!isNaN(v) && v > 0) { cfg.rates.market[el.dataset.rrate] = v; patch[el.dataset.rrate] = v; }
  });
  if (Object.keys(patch).length) {
    patchOverrides({ rates: { market: patch } });
    if (typeof renderRatesPanel === 'function') renderRatesPanel();
  }
}

function routeSave() {
  const data = Object.assign({}, routeState, {
    price: $('#routePrice').value, delivery: $('#routeDelivery').value, kgDuty: $('#routeKgDuty').value,
    age: $('#routeAge').value, volume: $('#routeVolume').value, power: $('#routePower').value,
  });
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify(data)); } catch (e) {}
}

function routeRestore() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(ROUTE_KEY) || 'null'); } catch (e) {}
  const R = cfg.routeCn || CALC_DATA.routeCn;
  $('#routeDelivery').value = R.deliveryForeign;
  if (!d) return;
  ['country', 'border', 'customs', 'city', 'condition', 'isElectric', 'powerUnit', 'util2027'].forEach((k) => {
    if (d[k] !== undefined) routeState[k] = d[k];
  });
  routeState.country = 'cn';   // вкладка Кореи пока скрыта
  routeRender();
  if (d.price) $('#routePrice').value = d.price;
  if (d.delivery) $('#routeDelivery').value = d.delivery;
  if (d.kgDuty) $('#routeKgDuty').value = d.kgDuty;
  if (d.volume) $('#routeVolume').value = d.volume;
  if (d.power) $('#routePower').value = d.power;
  if (d.age) $('#routeAge').value = d.age;
}

function onRouteCalculate() {
  haptic('medium');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  routeApplyRates();

  const s = routeState;
  const viaKg = s.country === 'cn' && s.customs === 'kg';
  const power = routeNum('#routePower');
  const inp = {
    country: s.country, border: s.border, customs: s.customs, city: s.city, condition: s.condition,
    util2027: s.util2027,
    carPrice: routeNum('#routePrice'), deliveryForeign: routeNum('#routeDelivery'),
    kgDutyUsd: routeNum('#routeKgDuty'),
    isElectric: s.isElectric, age: $('#routeAge').value,
    volumeCc: routeNum('#routeVolume'),
    powerHp: s.powerUnit === 'hp' ? power : null,
    powerKw: s.powerUnit === 'kw' ? power : null,
  };
  if (!inp.carPrice) { toast('Укажите цену авто'); return; }
  // объём и мощность нужны всегда: от них и пошлина РФ, и утильсбор при Бишкеке
  if (!s.isElectric && !inp.volumeCc) { toast('Укажите объём двигателя'); return; }
  if (!power) { toast('Укажите мощность'); return; }
  if (s.country === 'cn' && !cfg.rates.market.USD) { toast('Укажите курс доллара'); return; }
  routeSave();

  const x = calculateRoute(inp, cfg);
  const view = routeSections(x, cfg);
  routeLast = { lines: routeLines(view, x.total), plain: routePlainText(view, x.total) };

  const rows = view.sections.map((sec) =>
    `<div class="sec-head"><span>${esc(sec.head[0])}</span><span class="sec-sum">${esc(sec.head[1])}</span></div>` +
    sec.items.map(([l, v]) => `<div class="row sub"><span class="k">${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join('')
  ).join('');
  const kgWarn = viaKg && !inp.kgDutyUsd
    ? '<p class="hint">⚠️ Пошлина и брокер в Бишкеке не указаны — в итоге их нет.</p>' : '';
  const el = $('#routeResult');
  el.innerHTML =
    `<div class="total"><div class="label">${esc(view.totalLabel)}</div><div class="value">${fmt(x.total)}</div>` +
    `<div class="label">${esc(view.title)}</div></div>` + kgWarn + rows +
    `<div class="row grand"><span class="k">${esc(view.totalLabel)}</span><span class="v">${fmt(x.total)}</span></div>` +
    '<div class="result-actions" style="margin-top:14px">' +
      '<button class="copy-btn" data-ract="copy">📋 Копировать</button>' +
      '<button class="copy-btn send-btn" data-ract="share">📤 В чат</button>' +
    '</div>';
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function routeCopy() {
  if (!routeLast) return;
  const text = routeLast.lines.map((o) => o.text).join('\n');
  if (await copyTableAsImage(routeLast.lines)) {
    haptic('medium'); toast('✅ Таблица скопирована картинкой — вставьте в чат'); return;
  }
  const ok = await copyToClipboard('```\n' + text + '\n```');
  haptic(ok ? 'medium' : 'light');
  toast(ok ? '✅ Скопировано — вставьте в чат' : 'Не удалось скопировать');
}

function initRoute() {
  const screen = $('#screenRoute');
  if (!screen) return;
  routeRenderRates();
  routeRender();
  routeRestore();
  routeRender();

  screen.addEventListener('click', (e) => {
    const seg = e.target.closest('.seg[data-v]');
    if (seg && !seg.disabled) {
      const group = seg.parentElement.id;
      const key = { routeCountry: 'country', routeBorder: 'border', routeCustoms: 'customs',
        routeCity: 'city', routeCondition: 'condition' }[group];
      if (key) {
        routeState[key] = seg.dataset.v;
        haptic('light');
        routeRender();
        routeSave();
        $('#routeResult').classList.add('hidden');
      }
      return;
    }
    const unit = e.target.closest('#routePowerUnit .unit');
    if (unit) {
      routeState.powerUnit = unit.dataset.unit;
      routeRender();
      return;
    }
    const act = e.target.closest('[data-ract]');
    if (act && routeLast) {
      if (act.dataset.ract === 'copy') routeCopy();
      else {
        haptic('medium');
        shareToChat('```\n' + routeLast.lines.map((o) => o.text).join('\n') + '\n```', routeLast.plain);
      }
    }
  });
  $('#routeUtil2027').addEventListener('change', (e) => {
    routeState.util2027 = e.target.checked;
    routeSave();
    $('#routeResult').classList.add('hidden');
  });
  $('#routeIsElectric').addEventListener('change', (e) => {
    routeState.isElectric = e.target.checked;
    routeState.powerUnit = e.target.checked ? 'kw' : 'hp';
    routeRender();
    $('#routeResult').classList.add('hidden');
  });
  screen.addEventListener('input', (e) => {
    $('#routeResult').classList.add('hidden');
    if (e.target.closest('#routeRates')) routeRateSummary();
  });
  $('#routeRateToggle').addEventListener('click', () => {
    const closed = $('#routeRateBody').classList.toggle('hidden');
    $('#routeRateChevron').textContent = closed ? '▸' : '▾';
  });

  if (!inTelegram) {
    const btn = document.createElement('button');
    btn.className = 'calc-btn';
    btn.textContent = 'Рассчитать';
    btn.addEventListener('click', onRouteCalculate);
    screen.appendChild(btn);
  }

  if (isRouteOnly()) {
    window.routeOnly = true;
    const tabs = $('#modeTabs'); if (tabs) tabs.remove();
    const settings = $('#btnSettings'); if (settings) settings.remove();
  }
}

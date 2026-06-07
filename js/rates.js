/* =========================================================================
 *  rates.js — курсы валют и пользовательские настройки
 *    • автозагрузка курсов ЦБ РФ (cbr-xml-daily.ru, CORS-разрешён)
 *    • ручные переопределения курсов/ставок/расходов (localStorage)
 * ========================================================================= */

const STORE_KEY = 'calc_overrides_v1';
const CBR_KEY   = 'calc_cbr_cache_v1';
const CBR_URL   = 'https://www.cbr-xml-daily.ru/daily_json.js';

/* --- глубокое слияние объектов (массивы заменяются целиком) --- */
function deepMerge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (over && typeof over === 'object' && base && typeof base === 'object') {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
    return out;
  }
  return over === undefined ? base : over;
}

/* --- чтение / запись ручных переопределений --- */
function getOverrides() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch (e) { return {}; }
}
function setOverrides(obj) {
  localStorage.setItem(STORE_KEY, JSON.stringify(obj));
}
function patchOverrides(patch) {
  const cur = getOverrides();
  const next = deepMerge(cur, patch);
  setOverrides(next);
  return next;
}
function resetOverrides() {
  localStorage.removeItem(STORE_KEY);
}

/* --- итоговая конфигурация: данные по умолчанию + ручные правки --- */
function buildConfig() {
  const cfg = deepMerge(CALC_DATA, getOverrides());
  // rates: defaultRates + кэш ЦБ + ручные правки rates
  const cbrCache = getCbrCache();
  cfg.rates = deepMerge(CALC_DATA.defaultRates, {});
  if (cbrCache) cfg.rates.cbr = deepMerge(cfg.rates.cbr, cbrCache.rates);
  const ov = getOverrides();
  if (ov.rates) cfg.rates = deepMerge(cfg.rates, ov.rates);
  return cfg;
}

/* --- кэш курсов ЦБ --- */
function getCbrCache() {
  try { return JSON.parse(localStorage.getItem(CBR_KEY)); }
  catch (e) { return null; }
}
function setCbrCache(obj) {
  localStorage.setItem(CBR_KEY, JSON.stringify(obj));
}

/* --- загрузка актуальных курсов ЦБ --- */
async function fetchCbr() {
  const res = await fetch(CBR_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('ЦБ недоступен: ' + res.status);
  const data = await res.json();
  const v = data.Valute;
  const per1 = (code) => v[code].Value / v[code].Nominal;
  const rates = {
    USD: round(per1('USD'), 4),
    EUR: round(per1('EUR'), 4),
    JPY: round(per1('JPY'), 4),
    KRW: round(per1('KRW'), 5),
    CNY: round(per1('CNY'), 4),
  };
  const cache = { rates, date: data.Date, fetchedAt: Date.now() };
  setCbrCache(cache);
  return cache;
}

function round(n, d) { const p = Math.pow(10, d); return Math.round(n * p) / p; }

// экспорт
if (typeof window !== 'undefined') {
  Object.assign(window, {
    buildConfig, getOverrides, setOverrides, patchOverrides, resetOverrides,
    fetchCbr, getCbrCache, deepMerge,
  });
}

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
  saveOverridesToCloud(obj);
}
function patchOverrides(patch) {
  const cur = getOverrides();
  const next = deepMerge(cur, patch);
  setOverrides(next);
  return next;
}
function resetOverrides() {
  localStorage.removeItem(STORE_KEY);
  if (cloudAvailable()) { try { window.Telegram.WebApp.CloudStorage.removeItem(CLOUD_KEY, function () {}); } catch (e) {} }
}

/* --- облачное хранилище Telegram (CloudStorage) ---
 * localStorage в WebView Telegram нередко очищается между сессиями, поэтому курсы
 * «сбрасывались». CloudStorage привязан к аккаунту, переживает очистку кэша и
 * синхронизируется между устройствами. Доступно с Bot API 6.9. */
const CLOUD_KEY = 'overrides_v1';
function cloudAvailable() {
  return !!(typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp
    && window.Telegram.WebApp.CloudStorage
    && window.Telegram.WebApp.isVersionAtLeast && window.Telegram.WebApp.isVersionAtLeast('6.9'));
}
function saveOverridesToCloud(obj) {
  if (!cloudAvailable()) return;
  try { window.Telegram.WebApp.CloudStorage.setItem(CLOUD_KEY, JSON.stringify(obj), function () {}); }
  catch (e) {}
}
function loadOverridesFromCloud() {
  return new Promise(function (resolve) {
    if (!cloudAvailable()) { resolve(null); return; }
    try {
      window.Telegram.WebApp.CloudStorage.getItem(CLOUD_KEY, function (err, val) {
        if (err || !val) { resolve(null); return; }
        try { resolve(JSON.parse(val)); } catch (e) { resolve(null); }
      });
    } catch (e) { resolve(null); }
  });
}
/* влить облачные правки в локальные (без обратной записи в облако) */
function mergeCloudOverrides(cloudObj) {
  if (!cloudObj) return;
  const merged = deepMerge(getOverrides(), cloudObj);
  localStorage.setItem(STORE_KEY, JSON.stringify(merged));
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
    cloudAvailable, saveOverridesToCloud, loadOverridesFromCloud, mergeCloudOverrides,
  });
}

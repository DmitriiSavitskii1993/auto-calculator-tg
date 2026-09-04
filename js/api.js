/* =========================================================================
 *  api.js — общение с сервисом базы авто (wtcars).
 *
 *  Вход по подписи initData Telegram: обмениваем её на JWT и держим токен в
 *  localStorage. Токен живёт 30 дней; при 401 молча меняем его на новый и
 *  повторяем запрос один раз — пользователь ничего не замечает.
 * ========================================================================= */

const WT_API_BASE = 'https://publiosmm.ru/wtapi';
const WT_TOKEN_KEY = 'wt_api_token_v1';

/* У fetch нет таймаута по умолчанию: если соединение зависло (например,
 * VPN или прокси перехватил домен и молча держит сокет), запрос не вернётся
 * никогда, и экран останется на «Загружаю…». Обрываем сами и говорим правду. */
const WT_TIMEOUT_MS = 25000;
const WT_UPLOAD_TIMEOUT_MS = 90000;   // фото и распознавание — дольше

let _wtToken = null;
let _wtAuthPromise = null;   // чтобы параллельные запросы не логинились наперегонки

function wtGetToken() {
  if (_wtToken) return _wtToken;
  try { _wtToken = localStorage.getItem(WT_TOKEN_KEY) || null; } catch (e) {}
  return _wtToken;
}
function wtSetToken(t) {
  _wtToken = t;
  try { t ? localStorage.setItem(WT_TOKEN_KEY, t) : localStorage.removeItem(WT_TOKEN_KEY); }
  catch (e) {}
}

/* Доступна ли база: нужна подписанная initData, а её выдаёт только Telegram. */
function wtAvailable() {
  return !!(tg && tg.initData && tg.initData.length > 0);
}

class WtApiError extends Error {
  constructor(status, detail) {
    super(detail || ('Ошибка ' + status));
    this.status = status;
  }
}

/* fetch с обрывом по таймауту. Сообщение делаем человеческим: чаще всего
 * это не «сервер лежит», а VPN или прокси, который перехватил домен. */
async function wtRawFetch(url, opts, timeoutMs) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, timeoutMs || WT_TIMEOUT_MS);
  try {
    return await fetch(url, ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts);
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      throw new WtApiError(0,
        'Сервер не ответил за ' + Math.round((timeoutMs || WT_TIMEOUT_MS) / 1000) + ' с. ' +
        'Обычно виноват VPN или прокси — попробуйте отключить его и повторить.');
    }
    throw new WtApiError(0, 'Нет связи с сервером. Проверьте интернет и VPN.');
  } finally {
    clearTimeout(timer);
  }
}

async function wtLogin() {
  if (!wtAvailable()) throw new WtApiError(0, 'База работает только внутри Telegram');
  if (_wtAuthPromise) return _wtAuthPromise;

  _wtAuthPromise = (async () => {
    const res = await wtRawFetch(WT_API_BASE + '/auth/miniapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ init_data: tg.initData }),
    }, WT_TIMEOUT_MS);
    if (!res.ok) {
      wtSetToken(null);
      throw new WtApiError(res.status, res.status === 403
        ? 'Telegram не подтвердил вход' : 'Не удалось войти в базу');
    }
    const data = await res.json();
    wtSetToken(data.token);
    return data;
  })();

  try { return await _wtAuthPromise; }
  finally { _wtAuthPromise = null; }
}

/* Основной вызов. body — объект (уйдёт JSON) либо FormData (уйдёт как есть). */
async function wtFetch(path, { method = 'GET', body = null, query = null, retry = true } = {}) {
  let url = WT_API_BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.append(k, v);
    });
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }

  let token = wtGetToken();
  if (!token) token = (await wtLogin()).token;

  const headers = { Authorization: 'Bearer ' + token };
  let payload = null;
  if (body instanceof FormData) {
    payload = body;                       // Content-Type проставит браузер (boundary)
  } else if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await wtRawFetch(url, { method, headers, body: payload },
    body instanceof FormData ? WT_UPLOAD_TIMEOUT_MS : WT_TIMEOUT_MS);

  if (res.status === 401 && retry) {      // токен протух — перелогиниться и повторить
    wtSetToken(null);
    await wtLogin();
    return wtFetch(path, { method, body, query, retry: false });
  }
  if (!res.ok) {
    let detail = 'Ошибка ' + res.status;
    try {
      const j = await res.json();
      if (j && j.detail) {
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      }
    } catch (e) {}
    throw new WtApiError(res.status, detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* --- методы --- */
const wtApi = {
  health: () => wtFetch('/health'),
  listCars: (filters) => wtFetch('/cars', { query: filters }),
  getCar: (id) => wtFetch('/cars/' + id),
  createCar: (payload) => wtFetch('/cars', { method: 'POST', body: payload }),
  updateCar: (id, patch) => wtFetch('/cars/' + id, { method: 'PATCH', body: patch }),
  deleteCar: (id) => wtFetch('/cars/' + id, { method: 'DELETE' }),
  /* пересчёт рублёвых сумм карточки по свежим курсам (цена в валюте не меняется) */
  recalcCar: (id, payload) => wtFetch('/cars/' + id + '/recalc', { method: 'POST', body: payload }),
  uploadPhotos: (carId, files) => {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f, f.name || 'photo.jpg'));
    return wtFetch('/cars/' + carId + '/photos', { method: 'POST', body: fd });
  },
  deletePhoto: (carId, photoId) =>
    wtFetch('/cars/' + carId + '/photos/' + photoId, { method: 'DELETE' }),
  /* распознавание скрина: файл + необязательные страна/ссылка на drom.ru */
  extract: (file, { country, dromUrl } = {}) => {
    const fd = new FormData();
    fd.append('file', file, file.name || 'screenshot.jpg');
    if (country) fd.append('country', country);
    if (dromUrl) fd.append('drom_url', dromUrl);
    return wtFetch('/extract', { method: 'POST', body: fd });
  },
  /* Ссылка на фото приходит от сервера уже подписанной и относительной.
   * width — просим миниатюру: оригиналы весят по 1.5–2 МБ, и десяток их
   * на одном экране просто не догружается на мобильном или через VPN. */
  photoUrl: (relative, width) => {
    const rel = relative || '';
    const abs = rel.startsWith('http') ? rel : WT_API_BASE.replace(/\/wtapi$/, '') + rel;
    if (!width) return abs;
    return abs + (abs.includes('?') ? '&' : '?') + 'w=' + width;
  },
};

if (typeof window !== 'undefined') {
  Object.assign(window, { wtApi, wtFetch, wtLogin, wtAvailable, WtApiError, WT_API_BASE });
}

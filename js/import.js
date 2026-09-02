/* =========================================================================
 *  import.js — пакетная загрузка авто из CSV-шаблона.
 *
 *  Зачем отдельный модуль: пока распознавание скринов не подключено (нет
 *  ключа Anthropic), данные вносятся руками — но по одной машине через форму
 *  это долго. CSV позволяет залить сразу пачку.
 *
 *  Принцип тот же, что и везде в проекте: расчёт НЕ дублируется. Для каждой
 *  строки собирается ровно такой же объект input, какой строит onCalculate(),
 *  и вызывается настоящий calculate() из calc.js. Поэтому импортированная
 *  карточка и посчитанная руками дают одинаковые цифры.
 * ========================================================================= */

/* --- разбор CSV ---------------------------------------------------------
 * Свой парсер, а не split(','): Excel экспортирует с ';', заворачивает поля
 * с разделителями в кавычки и удваивает кавычки внутри. */

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && counts[ch] !== undefined) counts[ch]++;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ';');
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');            // BOM от Excel
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // "" → литеральная кавычка
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim() !== '') rows.push(row);

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/* Читаем файл, подстраиваясь под кодировку: Excel на Windows часто отдаёт
 * cp1251, и тогда UTF-8 даёт символы-замены вместо кириллицы. */
function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('не удалось прочитать файл'));
    reader.onload = () => {
      const buf = reader.result;
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) {
        try { text = new TextDecoder('windows-1251').decode(buf); } catch (e) {}
      }
      resolve(text);
    };
    reader.readAsArrayBuffer(file);
  });
}

/* --- сопоставление колонок ---------------------------------------------
 * Принимаем и русские, и английские заголовки, регистр и пробелы не важны. */

const COLUMN_ALIASES = {
  country:       ['страна', 'country'],
  make:          ['марка', 'make', 'brand'],
  model:         ['модель', 'model'],
  trim:          ['комплектация', 'trim', 'badge'],
  year:          ['год', 'year'],
  month:         ['месяц', 'month'],
  mileage_km:    ['пробег', 'пробег_км', 'пробег км', 'mileage', 'mileage_km'],
  volume_cc:     ['объем', 'объём', 'объем_см3', 'объём_см3', 'объем см3', 'объём см3', 'volume', 'volume_cc'],
  power_hp:      ['мощность', 'мощность_лс', 'мощность лс', 'лс', 'power_hp', 'hp'],
  power_kw:      ['мощность_квт', 'мощность квт', 'квт', 'power_kw', 'kw'],
  is_electric:   ['электрокар', 'электро', 'ev', 'is_electric'],
  fuel:          ['топливо', 'fuel'],
  transmission:  ['кпп', 'коробка', 'transmission'],
  drive:         ['привод', 'drive'],
  body:          ['кузов', 'body'],
  color:         ['цвет', 'color'],
  auction_grade: ['оценка', 'оценка_аукциона', 'grade', 'auction_grade'],
  interior_grade:['оценка_салона', 'оценка салона', 'салон', 'interior_grade'],
  lot_number:    ['лот', 'номер_лота', 'lot', 'lot_number'],
  auction_name:  ['аукцион', 'auction', 'auction_name'],
  price:         ['цена', 'цена_валюта', 'цена валюта', 'price'],
  delivery:      ['доставка', 'доставка_валюта', 'доставка валюта', 'delivery', 'freight'],
  age:           ['возраст', 'age'],
  sanctioned:    ['санкционное', 'санкции', 'sanctioned'],
  not_dvfo:      ['не_из_двфо', 'не из двфо', 'двфо', 'not_dvfo'],
  logistics_rf:  ['логистика_рф', 'логистика рф', 'логистика', 'logistics_rf'],
  city:          ['город', 'city'],
  drom_url:      ['drom', 'drom_url', 'ссылка_drom', 'ссылка drom', 'ссылка'],
  notes:         ['заметки', 'примечание', 'notes'],
};

function normHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/["']/g, '');
}

function mapHeaders(headerRow) {
  const map = {};
  const unknown = [];
  headerRow.forEach((raw, idx) => {
    const h = normHeader(raw);
    if (!h) return;
    const hit = Object.keys(COLUMN_ALIASES).find((key) =>
      COLUMN_ALIASES[key].some((alias) => normHeader(alias) === h));
    if (hit) map[hit] = idx; else unknown.push(raw.trim());
  });
  return { map, unknown };
}

/* --- нормализация значений --------------------------------------------- */

const YES = ['да', 'yes', 'true', '1', 'y', '+', 'истина'];

function cell(row, map, key) {
  const idx = map[key];
  if (idx === undefined) return '';
  return String(row[idx] == null ? '' : row[idx]).trim();
}
function asBool(v) { return YES.includes(String(v).trim().toLowerCase()); }
function asNum(v) {
  if (v === '' || v == null) return null;
  // «1 200 000», «1200000», «1 200,5» — убираем пробелы/неразрывные, запятая → точка
  const n = parseFloat(String(v).replace(/[\s  ]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}
function asInt(v) { const n = asNum(v); return n == null ? null : Math.round(n); }

const COUNTRY_MAP = {
  jp: 'jp', япония: 'jp', японии: 'jp', japan: 'jp',
  kr: 'kr', корея: 'kr', кореи: 'kr', korea: 'kr',
  cn: 'cn', китай: 'cn', китая: 'cn', china: 'cn',
};
const BODY_MAP = {
  седан: 'sedan', внедорожник: 'suv', кроссовер: 'suv', джип: 'suv', универсал: 'wagon',
  хэтчбек: 'hatchback', хетчбек: 'hatchback', купе: 'coupe', минивэн: 'minivan',
  пикап: 'pickup', фургон: 'van', кабриолет: 'convertible',
};
const DRIVE_MAP = {
  передний: 'FWD', перед: 'FWD', задний: 'RWD', зад: 'RWD',
  полный: 'AWD', awd: 'AWD', '4wd': '4WD', '4х4': '4WD', '4x4': '4WD',
};
const TRANS_MAP = {
  автомат: 'AT', акпп: 'AT', вариатор: 'CVT', робот: 'DCT', механика: 'MT', мкпп: 'MT',
};
const FUEL_MAP = {
  бензин: 'petrol', дизель: 'diesel', гибрид: 'hybrid', электро: 'ev',
  электрический: 'ev', газ: 'lpg',
};

function mapEnum(value, dict, allowed) {
  const v = String(value || '').trim();
  if (!v) return null;
  const low = v.toLowerCase();
  if (dict[low]) return dict[low];
  const upper = v.toUpperCase();
  if (allowed && allowed.includes(upper)) return upper;
  if (allowed && allowed.includes(low)) return low;
  return null;
}

/* --- сборка расчёта для одной строки ------------------------------------
 * Повторяет то, что делают currentPreset()/renderExpenses()/updateDelivery()
 * для формы, но без DOM. */

function presetFor(country, sanctioned) {
  return cfg.expensePresets[(country === 'jp' && sanctioned) ? 'jp_sanctioned' : country];
}

function expensesFor(country, notDvfo, logisticsOverride) {
  const preset = presetFor(country, false);
  const items = preset.items.map((it) => ({
    key: it.key, label: it.label, short: it.short || it.label, value: it.value,
  }));
  if (country === 'jp' && notDvfo) {
    items.push({
      key: 'tempreg', label: 'Справка о врем. регистрации (не из ДВФО)',
      short: 'Справка врем.рег.', value: cfg.tempRegFee,
    });
  }
  if (logisticsOverride != null) {
    const log = items.find((i) => i.key === 'rf_logistics');
    if (log) log.value = logisticsOverride;
  }
  return items;
}

function deliveryFor(country, sanctioned, carPrice, auctionIndex, explicitDelivery) {
  if (country === 'cn') return presetFor(country, false).fixedDeliveryForeign || 0;
  if (country === 'kr') return koreaDeliveryWon(carPrice, cfg);
  if (country === 'jp' && sanctioned) {
    const f = cfg.jpSanctionedFreight || { base: 490000, pct: 0.05 };
    return Math.round(f.base + f.pct * carPrice);
  }
  if (explicitDelivery != null) return explicitDelivery;
  if (auctionIndex != null && CALC_DATA.auctions[auctionIndex]) return CALC_DATA.auctions[auctionIndex].fob;
  return 0;
}

function findAuctionIndex(name) {
  if (!name) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
  const target = norm(name);
  if (!target) return null;
  let hit = null;
  CALC_DATA.auctions.forEach((a, i) => { if (hit === null && norm(a.name) === target) hit = i; });
  return hit;
}

/* Разбирает строку CSV → {vehicle, input, errors, warnings} */
function buildRow(row, map, lineNo) {
  const errors = [];
  const warnings = [];
  const get = (k) => cell(row, map, k);

  const country = COUNTRY_MAP[get('country').toLowerCase()] || null;
  if (!country) errors.push(`страна: «${get('country')}» — ожидается jp / kr / cn`);

  const isElectric = asBool(get('is_electric')) || mapEnum(get('fuel'), FUEL_MAP, []) === 'ev';
  const sanctioned = country === 'jp' && asBool(get('sanctioned'));
  const notDvfo = country === 'jp' && asBool(get('not_dvfo'));

  const carPrice = asNum(get('price'));
  if (!carPrice) errors.push('цена: пусто или не число');

  const volumeCc = asInt(get('volume_cc'));
  if (!isElectric && !volumeCc) errors.push('объём: обязателен для ДВС');

  const powerHp = asInt(get('power_hp'));
  const powerKw = asInt(get('power_kw'));
  if (!powerHp && !powerKw) errors.push('мощность: укажите л.с. или кВт');

  const year = asInt(get('year'));
  const month = asInt(get('month'));

  // возраст: явная колонка приоритетнее, иначе считаем от года выпуска
  let age = get('age');
  const validAges = (isElectric ? CALC_DATA.ageOptionsEv : CALC_DATA.ageOptions).map((o) => o.id);
  if (age && !validAges.includes(age)) {
    warnings.push(`возраст «${age}» не из списка (${validAges.join(', ')}) — вычислен по году`);
    age = '';
  }
  if (!age) {
    if (!year) errors.push('возраст: укажите колонку «возраст» или «год»');
    else {
      const prevElectric = state.isElectric;
      state.isElectric = isElectric;           // ageBandFrom смотрит на state
      age = ageBandFrom(year, month);
      state.isElectric = prevElectric;
    }
  }

  const auctionIndex = country === 'jp' && !sanctioned ? findAuctionIndex(get('auction_name')) : null;
  if (country === 'jp' && !sanctioned && get('auction_name') && auctionIndex === null) {
    warnings.push(`аукцион «${get('auction_name')}» не найден в справочнике — доставка из колонки/0`);
  }

  const explicitDelivery = asNum(get('delivery'));
  const deliveryForeign = errors.length ? 0
    : deliveryFor(country, sanctioned, carPrice, auctionIndex, explicitDelivery);

  const logisticsOverride = asNum(get('logistics_rf'));
  const city = get('city');

  const input = {
    country,
    isElectric,
    sanctioned,
    age,
    volumeCc: isElectric ? 0 : (volumeCc || 0),
    powerHp: powerHp || null,
    powerKw: powerKw || null,
    carPrice: carPrice || 0,
    deliveryForeign,
    bankFeePercent: country ? (presetFor(country, sanctioned).bankFeePercent || 0) : 0,
    commission: 0,                 // ступенчатая, calculate() посчитает по цене
    expenses: country ? expensesFor(country, notDvfo, logisticsOverride) : [],
    logisticsCity: city,
  };

  const vehicle = {
    make: get('make') || null,
    model: get('model') || null,
    trim: get('trim') || null,
    year: year,
    mileage_km: asInt(get('mileage_km')),
    body: mapEnum(get('body'), BODY_MAP, ['sedan','suv','wagon','hatchback','coupe','minivan','pickup','van','convertible','other']),
    drive: mapEnum(get('drive'), DRIVE_MAP, ['FWD','RWD','AWD','4WD']),
    transmission: mapEnum(get('transmission'), TRANS_MAP, ['AT','MT','CVT','DCT','AMT','other']),
    fuel: isElectric ? 'ev' : mapEnum(get('fuel'), FUEL_MAP, ['petrol','diesel','hybrid','phev','ev','lpg','other']),
    color: get('color') || null,
    auction_grade: get('auction_grade') || null,
    interior_grade: get('interior_grade') || null,
    lot_number: get('lot_number') || null,
    auction_name: auctionIndex != null ? CALC_DATA.auctions[auctionIndex].name : (get('auction_name') || null),
    drom_url: get('drom_url') || null,
    notes: get('notes') || null,
    price_foreign: carPrice,
    currency: { jp: 'JPY', kr: 'KRW', cn: 'CNY' }[country] || null,
    source_type: 'manual',
  };

  if (!vehicle.make || !vehicle.model) errors.push('марка и модель обязательны');

  return { lineNo, vehicle, input, errors, warnings };
}

/* --- разбор всего файла ------------------------------------------------- */

function parseImport(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('в файле нет строк с данными (нужна шапка + хотя бы одна строка)');

  const { map, unknown } = mapHeaders(rows[0]);
  const missing = ['country', 'make', 'model', 'price'].filter((k) => map[k] === undefined);
  if (missing.length) {
    const names = missing.map((k) => COLUMN_ALIASES[k][0]);
    throw new Error('в шапке не хватает обязательных колонок: ' + names.join(', '));
  }

  const parsed = rows.slice(1).map((r, i) => buildRow(r, map, i + 2));
  return { parsed, unknownColumns: unknown };
}

if (typeof window !== 'undefined') {
  Object.assign(window, {
    parseCsv, parseImport, buildRow, readCsvFile, mapHeaders,
    expensesFor, deliveryFor, findAuctionIndex,
  });
}

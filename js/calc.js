/* =========================================================================
 *  calc.js — движок расчёта стоимости авто «под ключ»
 *
 *  Логика реверс-инженерена из таблицы и сверена на 3 примерах:
 *    • Япония  : пошлина 89 627 ₽, утиль 5 200 ₽  (660 см³, 117 кВт, 3–5 лет)
 *    • Китай   : пошлина 954 681 ₽, утиль 3 400 ₽  (2000 см³, 115 кВт, <3 лет)
 *    • Корея   : электрокар (коммерческий ввоз: пошлина 15% + акциз + НДС 20%)
 *
 *  Ключевые принципы:
 *    – ТАМОЖЕННАЯ СТОИМОСТЬ считается по курсу ЦБ РФ (для пошлины/НДС).
 *    – РЕАЛЬНЫЙ ПЛАТЁЖ за авто считается по рыночному курсу (что платит клиент).
 *    – Утильсбор = базовая ставка × коэффициент из таблицы (объём+мощность+возраст).
 * ========================================================================= */

/* --- Вспомогательные конвертеры л.с. <-> кВт --- */
function hpToKw(hp) { return hp * 0.7355; }
function kwToHp(kw) { return kw / 0.7355; }

/* --- Перевод цены авто в рубли по РЫНОЧНОМУ курсу (реальный платёж) --- */
function priceToRub(country, amountForeign, rates) {
  switch (country) {
    case 'jp':
      return amountForeign * rates.market.JPY100_ATB / 100;  // ¥ → ₽ (курс за 100 JPY, АТБ)
    case 'cn':
      return amountForeign * rates.market.CNY;     // ¥ (CNY) → ₽
    case 'kr':
      return amountForeign * rates.market.KRW1000 / 1000; // ₩ → ₽ (прямой курс за 1000 вон, платёжный агент)
    default:
      return amountForeign;
  }
}

/* --- Доставка+фрахт по Корее по стоимости авто у дилера (вон) --- */
function koreaDeliveryWon(carPriceWon, cfg) {
  const tiers = (cfg && cfg.koreaDelivery) || CALC_DATA.koreaDelivery;
  const row = tiers.find(t => carPriceWon <= t.maxWon);
  return row ? row.won : 0;
}

/* --- Перевод цены авто в рубли по курсу ЦБ (таможенная стоимость) --- */
function priceToRubCbr(country, amountForeign, rates) {
  switch (country) {
    case 'jp': return amountForeign * rates.cbr.JPY;  // курс за 1 йену
    case 'cn': return amountForeign * rates.cbr.CNY;
    case 'kr': return amountForeign * rates.cbr.KRW;  // курс за 1 вону
    default:   return amountForeign;
  }
}

/* --- Поиск коэффициента утильсбора ---
 * Льготный коэффициент (0.17/0.26 → 3400/5200) применяется, если мощность ≤ порога
 * (160 л.с. для ДВС, 80 л.с. для электрокара). Выше порога — по таблице двс/лп или эл/лп. */
function findUtilCoef(cfg, isElectric, volumeCc, powerKw, powerHp, isOlderThan3) {
  const pref = cfg.utilPreferentialCoef || { new: 0.17, old: 0.26 };
  const thrHp = isElectric
    ? (cfg.utilPreferentialHp ? cfg.utilPreferentialHp.ev : 80)
    : (cfg.utilPreferentialHp ? cfg.utilPreferentialHp.ice : 160);

  // льготный утиль — мощность в пределах порога (включительно)
  if (powerHp <= thrHp) return isOlderThan3 ? pref.old : pref.new;

  // выше порога — детальная таблица коэффициентов.
  // ищем по НИЖНЕЙ границе мощности (устойчиво к округлению кВт и стыкам диапазонов)
  if (isElectric) {
    const cand = cfg.utilEv.filter(r => powerKw >= r.kMin);
    const row = cand.length ? cand[cand.length - 1] : cfg.utilEv[cfg.utilEv.length - 1];
    return isOlderThan3 ? row.cOld : row.cNew;
  }
  const band = cfg.utilIce.filter(r => volumeCc >= r.vMin && volumeCc <= r.vMax);
  const cand = band.filter(r => powerKw >= r.kMin);
  const row = (cand.length ? cand[cand.length - 1] : band[band.length - 1])
           || cfg.utilIce[cfg.utilIce.length - 1];
  return isOlderThan3 ? row.cOld : row.cNew;
}

/* --- Таможенный сбор за оформление (по таможенной стоимости в ₽) --- */
function findCustomsFee(cfg, customsValueRub) {
  const row = cfg.customsFee.find(r => customsValueRub <= r.valMaxRub);
  return row ? row.fee : cfg.customsFee[cfg.customsFee.length - 1].fee;
}

/* --- Расчёт пошлины (и сопутствующих платежей) ---
 * Возвращает { duty, excise, vat, customsFee, total, method } */
function calcDutyBlock(cfg, p) {
  const cbrEur = cfg.rates.cbr.EUR;
  const customsFee = findCustomsFee(cfg, p.customsValueRub);

  // --- Электрокар: пошлина 15% + акциз + НДС 22% (СТП, физлицо, 2026) ---
  if (p.isElectric) {
    const duty   = cfg.evDutyPercent * p.customsValueRub;
    // акциз: НК РФ ст.193 — ставка за 0.75 кВт, база = мощность(кВт) / 0.75
    const exciseUnits = p.powerKw / 0.75;
    const exRow  = cfg.exciseEv.find(r => exciseUnits <= r.unitMax) || cfg.exciseEv[cfg.exciseEv.length - 1];
    const excise = exRow.rub * exciseUnits;
    const vat    = cfg.evVatPercent * (p.customsValueRub + duty + excise);
    return {
      duty, excise, vat, customsFee,
      total: duty + excise + vat + customsFee,
      // пошлина EV — процент от рублёвой таможенной стоимости, в евро не считается
      dutyEur: null, dutyEurPerCc: null,
      exciseUnits,                          // база акциза: кВт / 0.75
      exciseRubPerUnit: exRow.rub,          // ставка НК РФ за единицу
      method: `Электрокар: пошлина ${(cfg.evDutyPercent * 100).toFixed(0)}% + акциз + НДС ${(cfg.evVatPercent * 100).toFixed(0)}%`,
    };
  }

  // --- Менее 3 лет: max(% от стоимости, €/см³) ---
  if (p.age === '<3') {
    const b = cfg.dutyUnder3.find(r => p.customsValueEur <= r.valMaxEur)
           || cfg.dutyUnder3[cfg.dutyUnder3.length - 1];
    const byPercent = b.percent * p.customsValueRub;
    const byCc      = b.eurPerCc * p.volumeCc * cbrEur;
    const duty = Math.max(byPercent, byCc);
    const wonByPercent = byPercent >= byCc;
    return {
      duty, excise: 0, vat: 0, customsFee,
      total: duty + customsFee,
      // если победила ставка €/см³ — пошлина по природе своей в евро,
      // и её надо хранить в евро: иначе при смене курса ЦБ карточку
      // не пересчитать точно, останется только рублёвый слепок
      dutyEur: wonByPercent ? null : b.eurPerCc * p.volumeCc,
      dutyEurPerCc: wonByPercent ? null : b.eurPerCc,
      exciseUnits: null, exciseRubPerUnit: null,
      method: wonByPercent
        ? `${(b.percent * 100).toFixed(0)}% от стоимости`
        : `${b.eurPerCc} €/см³`,
    };
  }

  // --- Старше 3 лет: только ставка €/см³ по возрасту и объёму ---
  const tbl = cfg.dutyOver3[p.age] || cfg.dutyOver3['3-5'];
  const b = tbl.find(r => p.volumeCc <= r.ccMax) || tbl[tbl.length - 1];
  const duty = b.eurPerCc * p.volumeCc * cbrEur;
  return {
    duty, excise: 0, vat: 0, customsFee,
    total: duty + customsFee,
    dutyEur: b.eurPerCc * p.volumeCc,   // ставка ЕТС задана в евро — храним в евро
    dutyEurPerCc: b.eurPerCc,
    exciseUnits: null, exciseRubPerUnit: null,
    method: `${b.eurPerCc} €/см³`,
  };
}

/* =========================================================================
 *  Главная функция расчёта
 *  input = {
 *    country: 'jp'|'kr'|'cn',
 *    isElectric: bool,
 *    age: '<3'|'3-5'|'5-7'|'>7'  (для EV: '<3'|'>3'),
 *    volumeCc, powerKw | powerHp,
 *    carPrice,            // цена авто в валюте страны (аукцион/дилер)
 *    deliveryForeign,     // доставка по стране + фрахт, в валюте страны
 *    bank,                // 'ATB'|'VTB' (для Японии — какой курс)
 *    commission,          // комиссия компании, ₽
 *    expenses: [{label, value}],  // расходы по РФ, ₽
 *  }
 *  cfg = { ...CALC_DATA, rates }  (с применёнными переопределениями)
 * ========================================================================= */
/* --- Комиссия компании (= депозит) по стоимости авто в рублях и стране.
 * Возвращает ₽ по ступеням commissionTiers; для санкционной Японии — фикс;
 * null — если таблицы нет (тогда используется ручное поле). --- */
function commissionFor(cfg, country, isSanctioned, carPriceRub) {
  if (country === 'jp' && isSanctioned) return cfg.commissionSanctioned || 150000;
  const tiers = (cfg.commissionTiers || {})[country];
  if (!tiers || !tiers.length) return null;
  for (const t of tiers) { if (carPriceRub <= t.maxRub) return t.rub; }
  return 'individual'; // свыше верхнего порога (10 млн ₽) — уточняется индивидуально
}

function calculate(input, cfg) {
  cfg = cfg || {};
  cfg = Object.assign({}, CALC_DATA, cfg);
  cfg.rates = cfg.rates || CALC_DATA.defaultRates;

  // --- мощность: нормализуем кВт/л.с. ---
  let powerKw = input.powerKw, powerHp = input.powerHp;
  if (powerKw == null && powerHp != null) powerKw = hpToKw(powerHp);
  if (powerHp == null && powerKw != null) powerHp = kwToHp(powerKw);
  powerKw = powerKw || 0; powerHp = powerHp || 0;

  const volumeCc = input.volumeCc || 0;
  const isOlderThan3 = input.age !== '<3';

  // --- цена авто + доставка/фрахт ---
  const foreignTotal = (input.carPrice || 0) + (input.deliveryForeign || 0);

  // реальный платёж за авто (рыночный курс)
  const carCostRub = priceToRub(input.country, foreignTotal, cfg.rates);
  // комиссия банка за перевод средств за границу (% от платежа за авто+логистику)
  const bankFeePercent = Number(input.bankFeePercent) || 0;
  const bankFee = carCostRub * bankFeePercent / 100;
  // таможенная стоимость (курс ЦБ)
  const customsValueRub = priceToRubCbr(input.country, foreignTotal, cfg.rates);
  const customsValueEur = customsValueRub / cfg.rates.cbr.EUR;

  // --- пошлина / акциз / НДС / сбор ---
  const duty = calcDutyBlock(cfg, {
    isElectric: !!input.isElectric,
    age: input.age,
    volumeCc, powerHp, powerKw,
    customsValueRub, customsValueEur,
  });

  // --- утильсбор ---
  const utilCoef = findUtilCoef(cfg, !!input.isElectric, volumeCc, powerKw, powerHp, isOlderThan3);
  const utilFee = cfg.utilBase * utilCoef;
  // порог льготного утиля + «сколько был бы льготный» — для предупреждения в UI («утиль-ловушка»)
  const _prefCoef = cfg.utilPreferentialCoef || { new: 0.17, old: 0.26 };
  const _prefHp = cfg.utilPreferentialHp || { ice: 160, ev: 80 };
  const utilThresholdHp = input.isElectric ? _prefHp.ev : _prefHp.ice;
  const utilPreferentialApplied = powerHp <= utilThresholdHp;
  const utilPreferentialFee = cfg.utilBase * (isOlderThan3 ? _prefCoef.old : _prefCoef.new);

  // --- расходы по РФ (логистику по РФ выносим отдельной строкой) ---
  const allExpenses = input.expenses || [];
  const logisticsItem = allExpenses.find(e => e && e.key === 'rf_logistics');
  const logistics = logisticsItem ? (Number(logisticsItem.value) || 0) : 0;
  const logisticsCity = (input.logisticsCity || '').trim();
  const expenses = allExpenses.filter(e => !(e && e.key === 'rf_logistics')); // услуги без логистики
  const expensesSum = expenses.reduce((s, e) => s + (Number(e.value) || 0), 0);
  // Комиссия компании (= депозит): ступенчато по стоимости авто в рублях (рыночный курс).
  // commissionManual — брокер задал сумму под конкретную сделку (скидка, спецусловия):
  // тогда ступени не применяются и берётся то, что введено в поле.
  // Если таблицы ступеней нет — тоже ручное поле (обратная совместимость).
  const carPriceRub = priceToRub(input.country, input.carPrice || 0, cfg.rates);
  const commissionManual = !!input.commissionManual;
  const tieredCommission = commissionManual
    ? null
    : commissionFor(cfg, input.country, !!input.sanctioned, carPriceRub);
  const commissionIndividual = tieredCommission === 'individual';   // авто > 10 млн ₽
  const commission = commissionIndividual ? 0
    : (tieredCommission != null ? tieredCommission : (Number(input.commission) || 0));

  // суммарные платежи государству (пошлина+акциз+НДС+сбор+утиль)
  const customsTotal = duty.total + utilFee;
  // все расходы по РФ (таможня + услуги + логистика)
  const rfExpenses = customsTotal + expensesSum + logistics;
  // итого «под ключ»
  const grandTotal = carCostRub + bankFee + rfExpenses + commission;

  return {
    input: { ...input, powerKw, powerHp, volumeCc },
    foreignTotal,
    carCostRub,
    bankFeePercent,
    bankFee,
    customsValueRub,
    customsValueEur,
    /* --- суммы в исходной валюте, ДО перевода в рубли ---
     * Рубли зависят от курса на день расчёта, валютные величины — нет.
     * Храним их, чтобы карточку можно было точно пересчитать на любой
     * другой курс, а не хранить рублёвый слепок с «примерными» цифрами. */
    currency: { jp: 'JPY', kr: 'KRW', cn: 'CNY' }[input.country] || null,
    carPriceForeign: input.carPrice || 0,       // цена авто в валюте страны
    deliveryForeign: input.deliveryForeign || 0, // доставка + фрахт в валюте
    // foreignTotal (цена + доставка в валюте) уже отдаётся выше
    dutyEur: duty.dutyEur,                      // пошлина в евро (ставка ЕТС €/см³)
    dutyEurPerCc: duty.dutyEurPerCc,            // сама ставка, €/см³
    exciseUnits: duty.exciseUnits,              // база акциза EV (кВт / 0.75)
    exciseRubPerUnit: duty.exciseRubPerUnit,
    duty: duty.duty,
    dutyMethod: duty.method,
    excise: duty.excise,
    vat: duty.vat,
    customsFee: duty.customsFee,
    utilFee,
    utilCoef,
    utilThresholdHp,           // порог льготного утиля, л.с. (160 ДВС / 80 EV)
    utilPreferentialApplied,   // попал ли под льготу (мощность ≤ порога)
    utilPreferentialFee,       // сколько был бы утиль при льготе (для показа переплаты)
    customsTotal,        // всё, что уходит на таможне
    expenses,            // услуги по РФ без логистики
    expensesSum,
    logistics,           // логистика по РФ (вынесена отдельно)
    logisticsCity,       // город доставки по РФ
    commission,
    commissionIndividual,   // true, если авто > 10 млн ₽ (комиссия «по запросу»)
    commissionManual,       // true, если сумма задана вручную, а не ступенью
    rfExpenses,
    grandTotal,
    // этапы оплаты
    stages: [
      { label: 'Депозит (р/с)', short: 'Депозит', value: commission },
      { label: 'Оплата за авто + комиссия банка (инвойс)', short: 'Авто (инвойс)', value: carCostRub + bankFee },
      { label: 'Пошлина / тамож. сбор / утиль (квитанция)', short: 'Пошлина/утиль', value: duty.duty + duty.customsFee + utilFee + duty.excise + duty.vat },
      { label: 'Остальные тамож. платежи и вывоз (физ. карта/счёт)', short: 'Остальное+вывоз', value: expensesSum },
      { label: 'Логистика по РФ' + (logisticsCity ? ' (' + logisticsCity + ')' : ''), short: 'Логистика РФ', value: logistics },
    ],
  };
}

// экспорт
if (typeof window !== 'undefined') {
  window.calculate = calculate;
  window.hpToKw = hpToKw;
  window.kwToHp = kwToHp;
  window.koreaDeliveryWon = koreaDeliveryWon;
}
if (typeof module !== 'undefined') module.exports = { calculate, hpToKw, kwToHp, koreaDeliveryWon };

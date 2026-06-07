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
function priceToRub(country, amountForeign, rates, opts) {
  opts = opts || {};
  switch (country) {
    case 'jp': {
      // санкционные авто оплачиваются по более дорогому курсу йены
      const rate = opts.sanctioned ? rates.market.JPY100_sanctioned : rates.market.JPY100_ATB;
      return amountForeign * rate / 100;          // ¥ → ₽ (курс за 100 JPY)
    }
    case 'cn':
      return amountForeign * rates.market.CNY;     // ¥ (CNY) → ₽
    case 'kr':
      return amountForeign / rates.market.KRW_per_USDT * rates.market.USDT_RUB; // ₩ → USDT → ₽
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

/* --- Поиск коэффициента утильсбора --- */
function findUtilCoef(cfg, isElectric, volumeCc, powerKw, isOlderThan3) {
  if (isElectric) {
    const row = cfg.utilEv.find(r => powerKw >= r.kMin && powerKw <= r.kMax)
             || cfg.utilEv[cfg.utilEv.length - 1];
    return isOlderThan3 ? row.cOld : row.cNew;
  }
  const row = cfg.utilIce.find(r =>
    volumeCc >= r.vMin && volumeCc <= r.vMax &&
    powerKw  >= r.kMin && powerKw  <= r.kMax
  ) || cfg.utilIce[cfg.utilIce.length - 1];
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

  // --- Электрокар: коммерческий ввоз (пошлина 15% + акциз + НДС 20%) ---
  if (p.isElectric) {
    const duty   = cfg.evDutyPercent * p.customsValueRub;
    const exRow  = cfg.exciseEv.find(r => p.powerHp <= r.hpMax) || cfg.exciseEv[cfg.exciseEv.length - 1];
    const excise = exRow.rub * p.powerHp;
    const vat    = cfg.evVatPercent * (p.customsValueRub + duty + excise);
    return {
      duty, excise, vat, customsFee,
      total: duty + excise + vat + customsFee,
      method: 'Электрокар: пошлина 15% + акциз + НДС 20%',
    };
  }

  // --- Менее 3 лет: max(% от стоимости, €/см³) ---
  if (p.age === '<3') {
    const b = cfg.dutyUnder3.find(r => p.customsValueEur <= r.valMaxEur)
           || cfg.dutyUnder3[cfg.dutyUnder3.length - 1];
    const byPercent = b.percent * p.customsValueRub;
    const byCc      = b.eurPerCc * p.volumeCc * cbrEur;
    const duty = Math.max(byPercent, byCc);
    return {
      duty, excise: 0, vat: 0, customsFee,
      total: duty + customsFee,
      method: byPercent >= byCc
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
  const carCostRub = priceToRub(input.country, foreignTotal, cfg.rates, { sanctioned: input.sanctioned });
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
    volumeCc, powerHp,
    customsValueRub, customsValueEur,
  });

  // --- утильсбор ---
  const utilCoef = findUtilCoef(cfg, !!input.isElectric, volumeCc, powerKw, isOlderThan3);
  const utilFee = cfg.utilBase * utilCoef;

  // --- расходы по РФ ---
  const expenses = input.expenses || [];
  const expensesSum = expenses.reduce((s, e) => s + (Number(e.value) || 0), 0);
  const commission = Number(input.commission) || 0;

  // суммарные платежи государству (пошлина+акциз+НДС+сбор+утиль)
  const customsTotal = duty.total + utilFee;
  // все расходы по РФ (таможня + услуги)
  const rfExpenses = customsTotal + expensesSum;
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
    duty: duty.duty,
    dutyMethod: duty.method,
    excise: duty.excise,
    vat: duty.vat,
    customsFee: duty.customsFee,
    utilFee,
    utilCoef,
    customsTotal,        // всё, что уходит на таможне
    expenses,
    expensesSum,
    commission,
    rfExpenses,
    grandTotal,
    // этапы оплаты
    stages: [
      { label: 'Депозит (р/с)', value: commission },
      { label: 'Оплата за авто + комиссия банка (инвойс)', value: carCostRub + bankFee },
      { label: 'Пошлина / тамож. сбор / утиль (квитанция)', value: duty.duty + duty.customsFee + utilFee + duty.excise + duty.vat },
      { label: 'Остальные тамож. платежи и вывоз (физ. карта/счёт)', value: expensesSum },
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

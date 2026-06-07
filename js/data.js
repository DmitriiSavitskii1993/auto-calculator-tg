/* =========================================================================
 *  data.js — справочные данные калькулятора растаможки авто
 *  Источник: Google-таблица «тут» (КАЛЬКУЛЯТОР АВТО).
 *  Все значения вынесены сюда, чтобы их можно было править в одном месте
 *  и переопределять через админ-панель (см. rates.js / app.js).
 * ========================================================================= */

const CALC_DATA = {

  /* --- Курсы валют по умолчанию (правятся в настройках / тянутся с ЦБ) --- */
  defaultRates: {
    // ЦБ РФ — используются для расчёта таможенной стоимости (пошлина/НДС)
    cbr: {
      USD: 73.47,
      EUR: 85.56,
      JPY: 0.4593,   // за 1 йену (в таблице 45.93 за 100)
      KRW: 0.04806,  // за 1 вону (в таблице 48.06 за 1000)
      CNY: 10.85,
    },
    // Рыночные курсы — по ним реально платим инвойс за авто
    market: {
      USD: 79.20,         // Доллар продажа
      JPY100_ATB: 49.70,  // курс 100 JPY (АТБ банк / SWIFT) — для всех авто
      CNY: 10.93,         // Юань продажа SWIFT
      KRW_per_USDT: 1443, // сколько вон за 1 USDT
      USDT_RUB: 77.60,    // рублей за 1 USDT
    },
  },

  /* --- Базовая ставка утильсбора (₽). Коэффициент берётся из таблиц ниже --- */
  utilBase: 20000,

  /* --- Сбор за временную регистрацию (если авто НЕ из ДВФО), ₽ --- */
  tempRegFee: 15000,

  /* --- Фрахт для САНКЦИОННЫХ авто из Японии (¥): база + % от цены авто --- */
  jpSanctionedFreight: { base: 490000, pct: 0.05 },

  /* --- Доставка+фрахт по Корее по стоимости авто у дилера (вон) --- */
  koreaDelivery: [
    { maxWon: 50000000,  won: 1500000 }, // до 50 млн вон
    { maxWon: 100000000, won: 1000000 }, // до 100 млн вон
    { maxWon: Infinity,  won: 0 },        // свыше 100 млн вон
  ],

  /* --- Коэффициенты утильсбора для ДВС (объём см³ × мощность кВт × возраст) ---
   * Полная таблица из листа калькулятора. coefNew — авто до 3 лет, coefOld — старше 3.
   * util = utilBase × coef. Для обычных авто физлица это 0.17 / 0.26 (3400 / 5200 ₽). */
  utilIce: [
    { vMin:0,    vMax:1000,   kMin:0,      kMax:51.48,  cNew:0.17,  cOld:0.26 },
    { vMin:0,    vMax:1000,   kMin:51.49,  kMax:73.55,  cNew:0.17,  cOld:0.26 },
    { vMin:0,    vMax:1000,   kMin:73.56,  kMax:95.61,  cNew:0.17,  cOld:0.26 },
    { vMin:0,    vMax:1000,   kMin:95.62,  kMax:117.68, cNew:0.17,  cOld:0.26 },
    { vMin:0,    vMax:1000,   kMin:117.69, kMax:139.75, cNew:15.36, cOld:28.44 },
    { vMin:0,    vMax:1000,   kMin:139.76, kMax:161.81, cNew:15.84, cOld:29.28 },
    { vMin:0,    vMax:1000,   kMin:161.82, kMax:183.88, cNew:16.2,  cOld:30.12 },
    { vMin:0,    vMax:1000,   kMin:183.89, kMax:999999, cNew:17.28, cOld:30.12 },
    { vMin:1001, vMax:2000,   kMin:0,      kMax:117.68, cNew:0.17,  cOld:0.26 },
    { vMin:1001, vMax:2000,   kMin:117.69, kMax:139.75, cNew:45,    cOld:74.64 },
    { vMin:1001, vMax:2000,   kMin:139.76, kMax:161.81, cNew:47.64, cOld:79.2 },
    { vMin:1001, vMax:2000,   kMin:161.82, kMax:183.88, cNew:50.52, cOld:83.88 },
    { vMin:1001, vMax:2000,   kMin:183.89, kMax:205.94, cNew:57.12, cOld:91.92 },
    { vMin:1001, vMax:2000,   kMin:205.95, kMax:228,     cNew:64.56, cOld:100.56 },
    { vMin:1001, vMax:2000,   kMin:228.01, kMax:250.07, cNew:72.96, cOld:110.16 },
    { vMin:1001, vMax:2000,   kMin:250.08, kMax:272.13, cNew:83.16, cOld:120.6 },
    { vMin:1001, vMax:2000,   kMin:272.14, kMax:294.2,  cNew:94.8,  cOld:132 },
    { vMin:1001, vMax:2000,   kMin:294.21, kMax:316.26, cNew:108,   cOld:144.6 },
    { vMin:1001, vMax:2000,   kMin:316.27, kMax:338.33, cNew:123.24,cOld:158.4 },
    { vMin:1001, vMax:2000,   kMin:338.34, kMax:367.75, cNew:140.4, cOld:173.4 },
    { vMin:1001, vMax:2000,   kMin:367.76, kMax:999999, cNew:160.08,cOld:189.84 },
    { vMin:2001, vMax:3000,   kMin:0,      kMax:117.68, cNew:0.17,  cOld:0.26 },
    { vMin:2001, vMax:3000,   kMin:117.69, kMax:139.75, cNew:115.34,cOld:172.8 },
    { vMin:2001, vMax:3000,   kMin:139.76, kMax:161.81, cNew:118.2, cOld:175.08 },
    { vMin:2001, vMax:3000,   kMin:161.82, kMax:183.88, cNew:120.12,cOld:177.6 },
    { vMin:2001, vMax:3000,   kMin:183.89, kMax:205.94, cNew:126,   cOld:183 },
    { vMin:2001, vMax:3000,   kMin:205.95, kMax:228,     cNew:131.04,cOld:188.52 },
    { vMin:2001, vMax:3000,   kMin:228.01, kMax:250.07, cNew:136.32,cOld:193.68 },
    { vMin:2001, vMax:3000,   kMin:250.08, kMax:272.13, cNew:141.72,cOld:199.08 },
    { vMin:2001, vMax:3000,   kMin:272.14, kMax:294.2,  cNew:147.48,cOld:204.72 },
    { vMin:2001, vMax:3000,   kMin:294.21, kMax:316.26, cNew:153.36,cOld:210.48 },
    { vMin:2001, vMax:3000,   kMin:316.27, kMax:338.33, cNew:159.48,cOld:216.36 },
    { vMin:2001, vMax:3000,   kMin:338.34, kMax:367.75, cNew:165.84,cOld:222.36 },
    { vMin:2001, vMax:3000,   kMin:367.76, kMax:999999, cNew:172.44,cOld:228.6 },
    { vMin:3001, vMax:3500,   kMin:0,      kMax:117.68, cNew:129.2, cOld:197.81 },
    { vMin:3001, vMax:3500,   kMin:117.69, kMax:139.75, cNew:131.76,cOld:200.04 },
    { vMin:3001, vMax:3500,   kMin:139.76, kMax:161.81, cNew:134.4, cOld:202.2 },
    { vMin:3001, vMax:3500,   kMin:161.82, kMax:183.88, cNew:137.16,cOld:204.36 },
    { vMin:3001, vMax:3500,   kMin:183.89, kMax:205.94, cNew:140.52,cOld:207.24 },
    { vMin:3001, vMax:3500,   kMin:205.95, kMax:228,     cNew:144,   cOld:212.4 },
    { vMin:3001, vMax:3500,   kMin:228.01, kMax:250.07, cNew:151.92,cOld:217.8 },
    { vMin:3001, vMax:3500,   kMin:250.08, kMax:272.13, cNew:160.32,cOld:224.28 },
    { vMin:3001, vMax:3500,   kMin:272.14, kMax:294.2,  cNew:169.2, cOld:231.6 },
    { vMin:3001, vMax:3500,   kMin:294.21, kMax:316.26, cNew:178.44,cOld:237.96 },
    { vMin:3001, vMax:3500,   kMin:316.27, kMax:338.33, cNew:188.28,cOld:245.04 },
    { vMin:3001, vMax:3500,   kMin:338.34, kMax:367.75, cNew:198.6, cOld:252.48 },
    { vMin:3001, vMax:3500,   kMin:367.76, kMax:999999, cNew:209.52,cOld:260.04 },
    { vMin:3501, vMax:999999, kMin:0,      kMax:117.68, cNew:164.53,cOld:216.29 },
    { vMin:3501, vMax:999999, kMin:117.69, kMax:139.75, cNew:167.28,cOld:219.48 },
    { vMin:3501, vMax:999999, kMin:139.76, kMax:161.81, cNew:170.16,cOld:222.84 },
    { vMin:3501, vMax:999999, kMin:161.82, kMax:183.88, cNew:173.04,cOld:226.2 },
    { vMin:3501, vMax:999999, kMin:183.89, kMax:205.94, cNew:176.52,cOld:231.36 },
    { vMin:3501, vMax:999999, kMin:205.95, kMax:228,     cNew:180,   cOld:236.64 },
    { vMin:3501, vMax:999999, kMin:228.01, kMax:250.07, cNew:186.36,cOld:249.6 },
    { vMin:3501, vMax:999999, kMin:250.08, kMax:272.13, cNew:192.88,cOld:263.4 },
    { vMin:3501, vMax:999999, kMin:272.14, kMax:294.2,  cNew:199.68,cOld:277.92 },
    { vMin:3501, vMax:999999, kMin:294.21, kMax:316.26, cNew:206.64,cOld:293.16 },
    { vMin:3501, vMax:999999, kMin:316.27, kMax:338.33, cNew:213.84,cOld:309.36 },
    { vMin:3501, vMax:999999, kMin:338.34, kMax:367.75, cNew:221.28,cOld:326.4 },
    { vMin:3501, vMax:999999, kMin:367.76, kMax:999999, cNew:229.08,cOld:344.28 },
  ],

  /* --- Коэффициенты утильсбора для электрокаров (мощность кВт), ставки 2026 --- */
  utilEv: [
    { kMin:0,      kMax:58.84,  cNew:0.17,   cOld:0.26 },
    { kMin:58.85,  kMax:73.55,  cNew:49.56,  cOld:82.08 },
    { kMin:73.56,  kMax:95.61,  cNew:65.88,  cOld:95.64 },
    { kMin:95.62,  kMax:117.68, cNew:78,     cOld:111.36 },
    { kMin:117.69, kMax:139.75, cNew:92.4,   cOld:129.72 },
    { kMin:139.76, kMax:161.81, cNew:109.68, cOld:151.2 },
    { kMin:161.82, kMax:183.88, cNew:129.96, cOld:176.16 },
    { kMin:183.89, kMax:205.94, cNew:153.96, cOld:205.2 },
    { kMin:205.95, kMax:999999, cNew:182.4,  cOld:239.04 },
  ],

  /* --- Ставки пошлины для авто МЕНЕЕ 3 лет (физлицо, ЕТС) ---
   * Считается от таможенной стоимости в ЕВРО: max(percent×стоимость, eurPerCc×объём).
   * Границы valMaxEur — верхняя граница стоимости в евро для брекета. */
  dutyUnder3: [
    { valMaxEur:8500,    percent:0.54, eurPerCc:2.5 },
    { valMaxEur:16700,   percent:0.48, eurPerCc:3.5 },
    { valMaxEur:42300,   percent:0.48, eurPerCc:5.5 },
    { valMaxEur:84500,   percent:0.48, eurPerCc:7.5 },
    { valMaxEur:169000,  percent:0.48, eurPerCc:15 },
    { valMaxEur:Infinity,percent:0.48, eurPerCc:20 },
  ],

  /* --- Ставки пошлины €/см³ для авто СТАРШЕ 3 лет (по возрасту и объёму) --- */
  dutyOver3: {
    '3-5': [
      { ccMax:1000, eurPerCc:1.5 },
      { ccMax:1500, eurPerCc:1.7 },
      { ccMax:1800, eurPerCc:2.5 },
      { ccMax:2300, eurPerCc:2.7 },
      { ccMax:3000, eurPerCc:3.0 },
      { ccMax:Infinity, eurPerCc:3.6 },
    ],
    // 5–7 лет и старше 7 — ставки выше (одинаковые)
    '5-7': [
      { ccMax:1000, eurPerCc:3.0 },
      { ccMax:1500, eurPerCc:3.2 },
      { ccMax:1800, eurPerCc:3.5 },
      { ccMax:2300, eurPerCc:4.8 },
      { ccMax:3000, eurPerCc:5.0 },
      { ccMax:Infinity, eurPerCc:5.7 },
    ],
    '>7': [
      { ccMax:1000, eurPerCc:3.0 },
      { ccMax:1500, eurPerCc:3.2 },
      { ccMax:1800, eurPerCc:3.5 },
      { ccMax:2300, eurPerCc:4.8 },
      { ccMax:3000, eurPerCc:5.0 },
      { ccMax:Infinity, eurPerCc:5.7 },
    ],
  },

  /* --- Таможенный сбор за оформление (₽) по таможенной стоимости в ₽ --- */
  customsFee: [
    { valMaxRub:200000,   fee:1067 },
    { valMaxRub:450000,   fee:2134 },
    { valMaxRub:1200000,  fee:4269 },
    { valMaxRub:2700000,  fee:11746 },
    { valMaxRub:4200000,  fee:16524 },
    { valMaxRub:5500000,  fee:21344 },
    { valMaxRub:7000000,  fee:27540 },
    { valMaxRub:Infinity, fee:30000 },
  ],

  /* --- Акциз для электрокаров (коммерческий ввоз), ₽ за 1 л.с. --- */
  exciseEv: [
    { hpMax:90,       rub:0 },
    { hpMax:150,      rub:61 },
    { hpMax:200,      rub:583 },
    { hpMax:300,      rub:955 },
    { hpMax:400,      rub:1628 },
    { hpMax:500,      rub:1685 },
    { hpMax:Infinity, rub:1740 },
  ],
  evDutyPercent: 0.15, // пошлина 15% от инвойса (электрокар, коммерческий ввоз)
  evVatPercent: 0.20,  // НДС 20%

  /* --- Возрастные категории (для UI) --- */
  ageOptions: [
    { id:'<3',  label:'Менее 3 лет' },
    { id:'3-5', label:'От 3 до 5 лет' },
    { id:'5-7', label:'От 5 до 7 лет' },
    { id:'>7',  label:'Старше 7 лет' },
  ],
  ageOptionsEv: [
    { id:'<3', label:'Электрокар до 3 лет' },
    { id:'>3', label:'Электрокар старше 3 лет' },
  ],

  /* --- Пресеты расходов по РФ для каждой страны (₽), правятся в настройках --- */
  expensePresets: {
    jp: {
      label: 'Япония 🇯🇵',
      currency: 'JPY',
      commission: 50000,
      bankFeePercent: 1.5, // % банка за перевод средств за границу (Япония)

      items: [
        { key:'broker',   label:'Услуги брокера / СБКТС / ЭПТС / Лаборатория', value:50000 },
        { key:'tech',     label:'Справка на техническое средство', value:550 },
        { key:'svh',      label:'СВХ (хранение и ПРР)', value:3000 },
        { key:'export',   label:'Вывоз в ТК', value:5000 },
      ],
    },
    // Япония — САНКЦИОННОЕ авто: фрахт по формуле (490000+5%), СВХ 50000. Курс/банк как обычно.
    jp_sanctioned: {
      label: 'Япония 🇯🇵 (санкции)',
      currency: 'JPY',
      commission: 50000,
      bankFeePercent: 1.5,
      items: [
        { key:'broker',   label:'Услуги брокера / СБКТС / ЭПТС / Лаборатория', value:50000 },
        { key:'tech',     label:'Справка на техническое средство', value:550 },
        { key:'svh',      label:'СВХ (хранение и ПРР)', value:50000 },
        { key:'export',   label:'Вывоз в ТК', value:5000 },
      ],
    },
    kr: {
      label: 'Корея 🇰🇷',
      currency: 'KRW',
      commission: 100000,
      bankFeePercent: 0,   // Корея — без комиссии банка за перевод

      items: [
        { key:'svh',      label:'СВХ ПРР', value:32000 },
        { key:'expertise',label:'Экспертиза ТС / осмотр на складе', value:4000 },
        { key:'reg',      label:'Справка о врем. регистрации', value:5000 },
        { key:'fast',     label:'Быстрый выпуск (минимум платного СВХ)', value:5000 },
        { key:'lab',      label:'ИЛ / СБКТС / ЭПТС', value:25000 },
        { key:'broker',   label:'Услуги брокера / вывоз с СВХ / стоянка', value:22000 },
        { key:'export',   label:'Вывоз в ТК', value:5000 },
      ],
    },
    cn: {
      label: 'Китай 🇨🇳',
      currency: 'CNY',
      commission: 100000,
      bankFeePercent: 2.5,       // % банка за перевод средств за границу
      fixedDeliveryForeign: 15000, // доставка+транзит всегда 15 000 ¥ (CNY)

      items: [
        { key:'ptd',      label:'Оформление ПТД', value:18000 },
        { key:'svh',      label:'СВХ (хранение и ПРР)', value:13000 },
        { key:'lab',      label:'СБКТС и ЭПТС (Лаборатория)', value:25000 },
        { key:'transit',  label:'Оформление транзитной декларации', value:17000 },
        { key:'expertise',label:'Экспертиза ТС', value:2000 },
        { key:'export',   label:'Вывоз в ТК / доставка к дому', value:10000 },
      ],
    },
  },

  /* --- FOB-прайсы аукционов Японии (¥). Доставка по Японии + фрахт. --- */
  auctions: [
    { name:'CAA CHUBU', fob:124150 },
    { name:'CAA GIFU', fob:124150 },
    { name:'CAA TOKYO', fob:132950 },
    { name:'CAA TOHOKU', fob:147950 },
    { name:'IAA OSAKA', fob:129650 },
    { name:'JU MIE', fob:134300 },
    { name:'JU HOKKAIDO (HAKODATE)', fob:171300 },
    { name:'JU HOKKAIDO (KITAMI)', fob:176300 },
    { name:'JU CHIBA', fob:126900 },
    { name:'JU SAITAMA', fob:126900 },
    { name:'JU OITA', fob:152272 },
    { name:'JU NARA', fob:142300 },
    { name:'JU MIYAGI', fob:127494 },
    { name:'JU MIYAGI (AKITA YARD)', fob:141300 },
    { name:'JU MIYAZAKI', fob:161800 },
    { name:'JU TOYAMA', fob:103810 },
    { name:'JU YAMAGUCHI', fob:146080 },
    { name:'JU YAMAGATA', fob:145098 },
    { name:'JU YAMANASHI', fob:143650 },
    { name:'JU GIFU', fob:121500 },
    { name:'JU SHIMANE', fob:172000 },
    { name:'JU HOKKAIDO (OBIHIRO)', fob:169300 },
    { name:'JU HIROSHIMA', fob:149600 },
    { name:'JU AICHI', fob:118100 },
    { name:'JU NIIGATA', fob:117579 },
    { name:'JU HOKKAIDO (ASAHIKAWA)', fob:169300 },
    { name:'JU HOKKAIDO (SAPPORO)', fob:166300 },
    { name:'JU TOKYO', fob:126900 },
    { name:'JU TOCHIGI', fob:134103 },
    { name:'JU OKINAWA', fob:178200 },
    { name:'JU KUMAMOTO', fob:164000 },
    { name:'JU ISHIKAWA', fob:117017 },
    { name:'JU KANAGAWA', fob:128800 },
    { name:'JU FUKUI', fob:115927 },
    { name:'JU FUKUOKA', fob:143950 },
    { name:'JU FUKUOKA (KAGOSHIMA)', fob:161800 },
    { name:'JU FUKUSHIMA', fob:126392 },
    { name:'JU AKITA', fob:140162 },
    { name:'JU GUNMA', fob:129100 },
    { name:'JU HOKKAIDO (TOMAKOMAI)', fob:166300 },
    { name:'JU IBARAKI', fob:134103 },
    { name:'JU HOKKAIDO (KUSHIRO)', fob:173300 },
    { name:'JU NAGASAKI', fob:191500 },
    { name:'JU NAGANO', fob:130798 },
    { name:'JU AOMORI', fob:154000 },
    { name:'JU SHIZUOKA', fob:134300 },
    { name:'JU SHIZUOKA (HAMAMATSU)', fob:134300 },
    { name:'KCAA MINAMI KYUSHU', fob:159900 },
    { name:'KCAA YAMAGUCHI', fob:146080 },
    { name:'KCAA KYOTO', fob:124150 },
    { name:'KCAA FUKUOKA', fob:143950 },
    { name:'LAA SHIKOKU', fob:152400 },
    { name:'LAA OKAYAMA', fob:136400 },
    { name:'LAA OKAYAMA (SATELLITE TOTTORI)', fob:157400 },
    { name:'LUM NAGOYA', fob:131000 },
    { name:'LUM TOKYO', fob:136500 },
    { name:'LUM FUKUOKA', fob:154650 },
    { name:'LUM HOKKAIDO', fob:174000 },
    { name:'LUM KOBE NYUSATSU', fob:136533 },
    { name:'NAA NAGOYA', fob:119200 },
    { name:'NAA OSAKA', fob:125832 },
    { name:'NAA TOKYO', fob:129900 },
    { name:'NAA TOKYO (TOHOKU)', fob:142400 },
    { name:'NAA FUKUOKA', fob:145050 },
    { name:'ORIX SENDAI', fob:138498 },
    { name:'ORIX ATSUGI', fob:136500 },
    { name:'ORIX KOBE', fob:133533 },
    { name:'ORIX FUKUOKA', fob:151650 },
    { name:'SAA SAPPORO', fob:165200 },
    { name:'SAA HAMAMATSU', fob:136500 },
    { name:'TAA CHUBU', fob:124150 },
    { name:'TAA CHUBU (HOKURIKU)', fob:124150 },
    { name:'TAA CHUBU (SHIZUOKA SATELLITE)', fob:140350 },
    { name:'TAA KYUSHU', fob:151712 },
    { name:'TAA HYOGO', fob:131883 },
    { name:'TAA HYOGO (KITA KOBE)', fob:137383 },
    { name:'TAA HOKKAIDO', fob:172350 },
    { name:'TAA MINAMI KYUSHU', fob:165950 },
    { name:'TAA MINAMI KYUSHU (KAGOSHIMA YARD)', fob:167850 },
    { name:'TAA SHIKOKU', fob:157350 },
    { name:'TAA SHIKOKU (EHIME)', fob:168350 },
    { name:'TAA HIROSHIMA', fob:153550 },
    { name:'TAA TOHOKU', fob:135747 },
    { name:'TAA TOHOKU (SENDAI)', fob:136848 },
    { name:'TAA YOKOHAMA', fob:132950 },
    { name:'TAA YOKOHAMA (ATSUGI)', fob:146850 },
    { name:'TAA KINKI', fob:130782 },
    { name:'TAA KINKI (KYOTO YARD)', fob:137850 },
    { name:'TAA KINKI (SHIGA YARD)', fob:147350 },
    { name:'TAA KANTOU', fob:132950 },
    { name:'TAA KANTO (NORTH KANTO YARD)', fob:132950 },
    { name:'TAA KANTO (SAITAMA SATELLITE)', fob:134850 },
    { name:'TAA KANTOU (TAMA YARD)', fob:146850 },
    { name:'TAA KANTO (SHINKO YARD)', fob:132950 },
    { name:'USS HAA KOBE', fob:128033 },
    { name:'USS HAA KOBE (SHIKOKU)', fob:153000 },
    { name:'USS JAA', fob:129100 },
    { name:'USS R NAGOYA', fob:120300 },
    { name:'USS KYUSHU', fob:145659 },
    { name:'USS KYUSHU (KAGOSHIMA)', fob:164000 },
    { name:'USS HOKURIKU', fob:111500 },
    { name:'USS NAGOYA', fob:120300 },
    { name:'USS SAITAMA', fob:129100 },
    { name:'USS OSAKA', fob:126932 },
    { name:'USS OKAYAMA', fob:144100 },
    { name:'USS NIIGATA', fob:119779 },
    { name:'USS SAPPORO', fob:168500 },
    { name:'USS TOKYO', fob:129100 },
    { name:'USS TOHOKU', fob:142056 },
    { name:'USS YOKOHAMA', fob:129100 },
    { name:'USS KOBE', fob:127703 },
    { name:'USS FUKUOKA', fob:146150 },
    { name:'USS FUKUOKA (KAGOSHIMA YARD)', fob:164000 },
    { name:'USS GUNMA', fob:129100 },
    { name:'USS SHIZUOKA', fob:136500 },
    { name:'ZIP OSAKA', fob:127670 },
    { name:'ZIP TOKYO', fob:129100 },
    { name:'ARAI BAYSIDE IMPORTS', fob:130200 },
    { name:'ARAI BAYSIDE JDM', fob:129100 },
    { name:'ARAI BAYSIDE (Sendai Yard) IMPORTS', fob:134600 },
    { name:'ARAI BAYSIDE (Sendai Yard) JDM', fob:133500 },
    { name:'ARAI BAYSIDE (Chiba Sakura Yard) IMPORTS', fob:139600 },
    { name:'ARAI BAYSIDE (Chiba Sakura Yard) JDM', fob:138500 },
    { name:'ARAI BAYSIDE (Okinawa Yard) IMPORTS', fob:187100 },
    { name:'ARAI BAYSIDE (Okinawa Yard) JDM', fob:186000 },
    { name:'ARAI BAYSIDE (Fukuoka Yard) IMPORTS', fob:152600 },
    { name:'ARAI BAYSIDE (Fukuoka Yard) JDM', fob:151500 },
    { name:'ARAI BAYSIDE (Kansai Yard) IMPORTS', fob:132600 },
    { name:'ARAI BAYSIDE (Kansai Yard) JDM', fob:131500 },
    { name:'ARAI BAYSIDE VENUE 2 (Плавучий остров) IMPORTS', fob:135150 },
    { name:'ARAI BAYSIDE VENUE 2 (Плавучий остров) JDM', fob:134050 },
    { name:'ARAI SENDAI', fob:132998 },
    { name:'ARAI OYAMA IMPORTS', fob:130200 },
    { name:'ARAI OYAMA JDM', fob:129100 },
    { name:'ARAI OYAMA TSUKUBA YARD', fob:136500 },
    { name:'ISUZU KYUSHU', fob:147862 },
    { name:'ISUZU KOBE', fob:128033 },
    { name:'ZERO CHUBU', fob:117000 },
    { name:'ZERO SENDAI', fob:129698 },
    { name:'ZERO HOKKAIDO', fob:165200 },
    { name:'ZERO CHIBA', fob:128700 },
    { name:'ZERO HAKATA', fob:152200 },
    { name:'ZERO OSAKA', fob:123650 },
    { name:'ZERO SHOUNAN', fob:129350 },
    { name:'HERO', fob:128000 },
    { name:'BAYAUC', fob:127670 },
    { name:'HONDA KYUSHU', fob:147312 },
    { name:'HONDA SENDAI', fob:131450 },
    { name:'HONDA HOKKAIDO', fob:167950 },
    { name:'HONDA NAGOYA', fob:119750 },
    { name:'HONDA TOKYO', fob:128550 },
    { name:'HONDA TOKYO OGAWA/SAITAMA', fob:128550 },
    { name:'HONDA TOKYO GOTEMBA/SHIZUOKA', fob:142250 },
    { name:'HONDA TOKYO MITSUKE/NIIGATA', fob:128550 },
    { name:'HONDA KANSAI', fob:127483 },
    { name:'MIRIVE SAITAMA', fob:130750 },
    { name:'MIRIVE OSAKA', fob:128582 },
    { name:'MIRIVE AICHI', fob:121950 },
    { name:'NPS SENDAI', fob:138498 },
    { name:'NPS OSAKA', fob:133500 },
    { name:'NPS GIFU', fob:127000 },
    { name:'NPS TOKYO', fob:136500 },
    { name:'NPS TOCHIGI', fob:145850 },
    { name:'NPS FUKUOKA', fob:151650 },
    { name:'NPS TOMAKOMAI', fob:174000 },
    { name:'NISSAN OSAKA', fob:132432 },
  ],
};

// Доступ из других файлов (браузер + возможный импорт в боте)
if (typeof window !== 'undefined') window.CALC_DATA = CALC_DATA;
if (typeof module !== 'undefined') module.exports = CALC_DATA;

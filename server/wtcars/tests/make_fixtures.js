/* Гоняет НАСТОЯЩИЙ js/calc.js под Node и выдаёт фикстуры расчётов.
 *
 * Смысл: бэкенд проверяется на том, что реально отдаёт боевой движок,
 * а не на выдуманном JSON. Если calc.js меняется — перегенерировать:
 *
 *     node server/wtcars/tests/make_fixtures.js > server/wtcars/tests/fixtures.json
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');

// calc.js обращается к глобальному CALC_DATA — кладём его в global до импорта
global.CALC_DATA = require(path.join(ROOT, 'js/data.js'));
const { calculate } = require(path.join(ROOT, 'js/calc.js'));

const rates = {
  cbr: { USD: 73.47, EUR: 85.56, JPY: 0.4593, KRW: 0.04806, CNY: 10.85 },
  market: { USD: 79.20, JPY100_ATB: 49.70, CNY: 10.93, KRW1000: 53.78 },
};
const cfg = Object.assign({}, global.CALC_DATA, { rates });

const preset = (k) => global.CALC_DATA.expensePresets[k];
const expensesFrom = (k) => preset(k).items.map((i) => ({
  key: i.key, label: i.label, short: i.short || i.label, value: i.value,
}));

const cases = [
  {
    name: 'JP 150 л.с. — под льготу',
    vehicle: { make: 'Toyota', model: 'Corolla Fielder', year: 2021, month: 6,
               mileage_km: 48000, body: 'wagon', drive: 'FWD', transmission: 'CVT',
               fuel: 'petrol', auction_grade: '4.5', lot_number: '30215',
               auction_name: 'USS Tokyo', color: 'белый',
               price_foreign: 1200000, currency: 'JPY' },
    input: {
      country: 'jp', isElectric: false, sanctioned: false, age: '3-5',
      volumeCc: 1500, powerHp: 150, powerKw: null,
      carPrice: 1200000, deliveryForeign: 126900,
      bankFeePercent: preset('jp').bankFeePercent, commission: 0,
      expenses: expensesFrom('jp'), logisticsCity: 'Новосибирск',
    },
  },
  {
    name: 'JP 200 л.с. — утиль-ловушка',
    vehicle: { make: 'Toyota', model: 'Harrier', year: 2020, month: 3,
               mileage_km: 62000, body: 'suv', drive: 'AWD', transmission: 'AT',
               fuel: 'petrol', auction_grade: '4', lot_number: '44120',
               price_foreign: 2600000, currency: 'JPY' },
    input: {
      country: 'jp', isElectric: false, sanctioned: false, age: '5-7',
      volumeCc: 2500, powerHp: 200, powerKw: null,
      carPrice: 2600000, deliveryForeign: 126900,
      bankFeePercent: preset('jp').bankFeePercent, commission: 0,
      expenses: expensesFrom('jp'), logisticsCity: 'Москва',
    },
  },
  {
    name: 'KR электрокар',
    vehicle: { make: 'Hyundai', model: 'Ioniq 5', year: 2023, month: 1,
               mileage_km: 21000, body: 'suv', drive: 'AWD', transmission: 'AT',
               fuel: 'ev', lot_number: 'KR-9981',
               price_foreign: 38000000, currency: 'KRW' },
    input: {
      country: 'kr', isElectric: true, sanctioned: false, age: '<3',
      volumeCc: 0, powerHp: null, powerKw: 160,
      carPrice: 38000000, deliveryForeign: 1500000,
      bankFeePercent: preset('kr').bankFeePercent, commission: 0,
      expenses: expensesFrom('kr'), logisticsCity: 'Владивосток',
    },
  },
];

const out = cases.map((c) => ({
  name: c.name,
  vehicle: c.vehicle,
  calc_input: c.input,
  calc_result: calculate(c.input, cfg),
  rates: { cbr: rates.cbr, market: rates.market,
           cbr_date: '2026-08-28T11:30:00+03:00', calc_version: 'local-test' },
}));

console.error('--- сводка фикстур ---');
out.forEach((o) => {
  const r = o.calc_result;
  console.error(
    `${o.name.padEnd(28)} итого=${Math.round(r.grandTotal).toLocaleString('ru-RU')} ₽  ` +
    `утиль=${Math.round(r.utilFee).toLocaleString('ru-RU')}  льгота=${r.utilPreferentialApplied}  ` +
    `валюта=${r.currency} ${r.carPriceForeign.toLocaleString('ru-RU')}  ` +
    `пошлина=${r.dutyEur != null ? r.dutyEur.toFixed(0) + ' €' : '% от стоимости'}`
  );
});

process.stdout.write(JSON.stringify(out, null, 2));

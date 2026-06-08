/* =========================================================================
 *  bot.js — Telegram-бот, открывающий Mini App с калькулятором.
 *  Запуск:  npm install && npm start
 *  Нужны переменные окружения (см. .env.example):
 *    BOT_TOKEN  — токен от @BotFather
 *    WEBAPP_URL — адрес размещённого Mini App (например, GitHub Pages)
 * ========================================================================= */
require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('❌ Укажите BOT_TOKEN и WEBAPP_URL в файле .env');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Кнопка-меню (слева от поля ввода) открывает Mini App
bot.api.setChatMenuButton({
  menu_button: { type: 'web_app', text: 'Калькулятор', web_app: { url: WEBAPP_URL } },
}).catch((e) => console.warn('Не удалось установить menu button:', e.message));

const welcome =
  '🚗 *Калькулятор стоимости авто из-за рубежа*\n\n' +
  'Рассчитайте цену авто «под ключ» при ввозе из 🇯🇵 Японии, 🇰🇷 Кореи и 🇨🇳 Китая ' +
  '(включая электрокары): пошлина, утильсбор, таможенный сбор, расходы по РФ и комиссия.\n\n' +
  'Нажмите кнопку ниже, чтобы открыть калькулятор 👇';

bot.command('start', async (ctx) => {
  const kb = new InlineKeyboard().webApp('🧮 Открыть калькулятор', WEBAPP_URL);
  const msg = await ctx.reply(welcome, { parse_mode: 'Markdown', reply_markup: kb });
  // закрепляем сообщение с кнопкой, чтобы калькулятор всегда был в закрепе сверху чата
  try {
    await ctx.api.pinChatMessage(ctx.chat.id, msg.message_id, { disable_notification: true });
  } catch (e) {
    console.warn('Не удалось закрепить сообщение:', e.message);
  }
});

bot.command('calc', async (ctx) => {
  const kb = new InlineKeyboard().webApp('🧮 Открыть калькулятор', WEBAPP_URL);
  await ctx.reply('Открыть калькулятор:', { reply_markup: kb });
});

// Приём данных из Mini App (если решите отправлять расчёт обратно в чат)
bot.on('message:web_app_data', async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    await ctx.reply('✅ Расчёт получен:\n' + (data.text || JSON.stringify(data)));
  } catch (e) {
    await ctx.reply('Получены данные из приложения.');
  }
});

bot.catch((err) => console.error('Ошибка бота:', err));

bot.start({ onStart: (info) => console.log(`🤖 Бот @${info.username} запущен`) });

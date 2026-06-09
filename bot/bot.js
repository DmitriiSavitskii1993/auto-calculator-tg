/* =========================================================================
 *  bot.js — Telegram-бот, открывающий Mini App с калькулятором.
 *  Запуск:  npm install && npm start
 *  Нужны переменные окружения (см. .env.example):
 *    BOT_TOKEN  — токен от @BotFather
 *    WEBAPP_URL — адрес размещённого Mini App (например, GitHub Pages)
 * ========================================================================= */
require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const crypto = require('crypto');

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

/* --- Проверка подписи initData из Telegram Mini App (возвращает user или null) --- */
function checkInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calcHash !== hash) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (e) { return null; }
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* --- HTTP-сервер: /prepare готовит форматированное сообщение для отправки в чат --- */
const http = require('http');
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET') { res.writeHead(200); return res.end('Bot is running'); }

  if (req.method === 'POST' && req.url === '/prepare') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { initData, text } = JSON.parse(body || '{}');
        const user = checkInitData(initData);
        if (!user) { res.writeHead(403); return res.end(JSON.stringify({ error: 'bad initData' })); }
        const result = {
          type: 'article',
          id: 'calc' + user.id + '_' + body.length,
          title: 'Расчёт авто',
          input_message_content: { message_text: '<pre>' + escapeHtml(text || '') + '</pre>', parse_mode: 'HTML' },
        };
        const prepared = await bot.api.savePreparedInlineMessage(user.id, result, {
          allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: prepared.id }));
      } catch (e) {
        console.error('prepare error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('HTTP-сервер на порту ' + PORT));

bot.start({ onStart: (info) => console.log(`🤖 Бот @${info.username} запущен`) });

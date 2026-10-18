/* =========================================================================
 *  bot.js — Telegram-бот, открывающий Mini App с калькулятором.
 *  Запуск:  npm install && npm start
 *  Нужны переменные окружения (см. .env.example):
 *    BOT_TOKEN  — токен от @BotFather
 *    WEBAPP_URL — адрес размещённого Mini App (например, GitHub Pages)
 * ========================================================================= */
require('dotenv').config();
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

/* Режим получения сообщений.
 *   polling  — опрос Telegram (по умолчанию; так удобно запускать локально);
 *   webhook  — Telegram сам стучится к нам. На сервере нужен именно он:
 *              webhook исключителен, и как только он установлен, Telegram
 *              перестаёт отдавать сообщения любому другому экземпляру бота. */
const BOT_MODE = process.env.BOT_MODE === 'webhook' ? 'webhook' : 'polling';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_PATH = '/tg';

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('❌ Укажите BOT_TOKEN и WEBAPP_URL в файле .env');
  process.exit(1);
}
if (BOT_MODE === 'webhook' && !WEBHOOK_URL) {
  console.error('❌ Для режима webhook нужен WEBHOOK_URL');
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

/* --- Пост клиенту через Telegram Business ---
 * Отправку делает сервис базы (wtcars): у него фото и карточки. Webhook у бота
 * один, поэтому нужные события бот пересылает туда. Ключ выводится из токена
 * бота — он одинаковый у обоих сервисов, отдельный секрет не нужен. */
const WTAPI_INTERNAL_URL = process.env.WTAPI_INTERNAL_URL || 'http://127.0.0.1:8082/wtapi/internal/tg';
const INTERNAL_TOKEN = crypto.createHmac('sha256', BOT_TOKEN).update('wtcars-internal').digest('hex');
const SELF_LABEL = '📥 Прислать мне';
const CANCEL_LABEL = '✖️ Отмена';

async function relay(event) {
  const res = await fetch(WTAPI_INTERNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('wtcars ' + res.status + ': ' + (await res.text()).slice(0, 200));
}

bot.use(async (ctx, next) => {
  const conn = ctx.update.business_connection;
  if (!conn) return next();
  try {
    await relay({ kind: 'business_connection', connection: conn });
    const rights = conn.rights || {};
    const canReply = rights.can_reply !== undefined ? rights.can_reply : conn.can_reply;
    const text = !conn.is_enabled
      ? 'Бот отключён от Telegram для бизнеса — посты будут приходить сюда, пересылайте их вручную.'
      : canReply
        ? '✅ Бот подключён к Telegram для бизнеса. Теперь «📤 Пост» в базе отправляет альбом клиенту от вашего имени.'
        : 'Бот подключён, но без права отвечать. Включите «Отвечать на сообщения» в настройках бота в Telegram для бизнеса.';
    await ctx.api.sendMessage(conn.user_chat_id, text);
  } catch (e) { console.error('business_connection:', e.message); }
});

/* Отправка альбома идёт дольше 10 с, после которых Telegram считает webhook
 * упавшим и присылает событие повторно — клиент получил бы пост дважды.
 * Поэтому на событие отвечаем сразу, а отправку ведём в фоне. */
function relayInBackground(ctx, event, failText) {
  relay(event).catch((e) => {
    console.error(event.kind + ':', e.message);
    ctx.reply(failText).catch(() => {});
  });
}

bot.on('message:users_shared', (ctx) => {
  const us = ctx.message.users_shared;
  relayInBackground(ctx,
    { kind: 'users_shared', actor_id: ctx.from.id, request_id: us.request_id, users: us.users || [] },
    'Не удалось отправить пост, попробуйте ещё раз из карточки.');
});

bot.hears([SELF_LABEL, CANCEL_LABEL], (ctx) => {
  relayInBackground(ctx,
    { kind: ctx.message.text === SELF_LABEL ? 'send_self' : 'cancel', actor_id: ctx.from.id },
    'Сервер базы не ответил, попробуйте ещё раз.');
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
    // Свежесть: отклоняем initData старше суток (анти-replay, если строка утечёт в логи/HAR/прокси).
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch (e) { return null; }
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* --- HTTP-сервер: /prepare готовит форматированное сообщение для отправки в чат --- */
const http = require('http');
const PORT = process.env.PORT || 3000;
const handleWebhook = BOT_MODE === 'webhook' ? webhookCallback(bot, 'http') : null;

http.createServer((req, res) => {
  // Приём обновлений от Telegram — до заголовков CORS: это не браузер.
  // Секрет подтверждает, что стучится действительно Telegram, а не тот, кто
  // подобрал адрес.
  if (handleWebhook && req.method === 'POST' && req.url === WEBHOOK_PATH) {
    if (WEBHOOK_SECRET && req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
      res.writeHead(401); return res.end();
    }
    return handleWebhook(req, res);
  }

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

/* Сторож webhook. Чужая копия бота в режиме опроса (старый деплой, локальный
 * запуск) при старте снимает webhook и забирает события себе — тогда выбор
 * клиента и подключение Business сюда не доходят. Возвращаем webhook сразу:
 * пока он стоит, Telegram отказывает опросу, и чужая копия отваливается. */
const WEBHOOK_OPTS = {
  secret_token: WEBHOOK_SECRET || undefined,
  // business_message сюда намеренно не входит: переписка с клиентами боту не нужна
  allowed_updates: ['message', 'callback_query', 'business_connection'],
};

async function guardWebhook() {
  try {
    const info = await bot.api.getWebhookInfo();
    if (info.url !== WEBHOOK_URL) {
      console.warn(`⚠️ webhook снят (было: "${info.url}") — чужая копия бота? Ставлю обратно`);
      await bot.api.setWebhook(WEBHOOK_URL, WEBHOOK_OPTS);
    }
  } catch (e) { console.error('проверка webhook:', e.message); }
}

if (BOT_MODE === 'webhook') {
  // init() нужен до приёма обновлений: без него grammy не знает, кто он такой.
  bot.init()
    .then(() => bot.api.setWebhook(WEBHOOK_URL, WEBHOOK_OPTS))
    .then(() => {
      console.log(`🤖 Бот @${bot.botInfo.username} принимает обновления по webhook`);
      setInterval(guardWebhook, 60 * 1000);
    })
    .catch((e) => { console.error('Не удалось установить webhook:', e.message); process.exit(1); });
} else {
  bot.start({
    allowed_updates: ['message', 'callback_query', 'business_connection'],
    onStart: (info) => console.log(`🤖 Бот @${info.username} запущен опросом`),
  });
}

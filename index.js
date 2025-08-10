require('dotenv').config();
const fs = require('fs-extra');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID || 0);
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS;
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 10000);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 3);

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const PENDING_FILE = path.join(__dirname, 'pending.json');
const DELIVERS_FILE = path.join(__dirname, 'delivers.json');

if (!fs.existsSync(ORDERS_FILE)) fs.writeJSONSync(ORDERS_FILE, []);
if (!fs.existsSync(PENDING_FILE)) fs.writeJSONSync(PENDING_FILE, {});
if (!fs.existsSync(DELIVERS_FILE)) fs.writeJSONSync(DELIVERS_FILE, {});

const ordersList = fs.readJSONSync(ORDERS_FILE);
let pending = fs.readJSONSync(PENDING_FILE);
let delivers = fs.readJSONSync(DELIVERS_FILE);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function todayDate() {
  return new Date().toISOString().slice(0,10);
}

function incDeliverCount(chatId) {
  const today = todayDate();
  if (!delivers[chatId] || delivers[chatId].date !== today) {
    delivers[chatId] = { date: today, count: 0 };
  }
  delivers[chatId].count += 1;
  fs.writeJSONSync(DELIVERS_FILE, delivers, { spaces: 2 });
}

function canReceive(chatId) {
  const today = todayDate();
  if (!delivers[chatId] || delivers[chatId].date !== today) return true;
  return delivers[chatId].count < DAILY_LIMIT;
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "أهلاً! أرسل رقم الطلب (Order ID) الذي وصلك من المتجر.");
});

bot.on('message', (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // Admin status
    if (msg.from && msg.from.id === OWNER_ID && text.startsWith('/status')) {
      const pendList = Object.entries(pending).map(([u,v]) => `${u} => order:${v.orderId} chat:${v.chatId}`).join('\n') || 'لا يوجد طلبات معلقة';
      bot.sendMessage(chatId, `الطلبات المعلقة:\n${pendList}`);
      return;
    }

    // If text is numeric order id
    if (/^\d+$/.test(text)) {
      const orderId = text;
      const exists = ordersList.some(o => o.order_id === orderId);
      if (!exists) {
        bot.sendMessage(chatId, "❌ رقم الطلب غير موجود أو لم يتم اعتماده. تواصل مع البائع.");
        return;
      }
      pending[`__temp__${chatId}`] = { orderId, step: 'waiting_username', ts: Date.now() };
      fs.writeJSONSync(PENDING_FILE, pending, { spaces: 2 });
      bot.sendMessage(chatId, "✅ الطلب معتمد. الآن أرسل اسم حساب Steam (username) الذي تحاول تسجيل الدخول به.");
      return;
    }

    const tempKey = `__temp__${chatId}`;
    if (pending[tempKey] && pending[tempKey].step === 'waiting_username') {
      const orderId = pending[tempKey].orderId;
      const username = text.trim();
      pending[username.toLowerCase()] = { orderId, chatId, username, requestedAt: Date.now() };
      delete pending[tempKey];
      fs.writeJSONSync(PENDING_FILE, pending, { spaces: 2 });
      bot.sendMessage(chatId, `📌 تم تسجيل الطلب لرقم ${orderId} باسم الحساب ${username}.\n📩 انتظر قليلاً حتى يصلنا كود Steam Guard على الإيميل المربوط بالحساب.`);
      return;
    }

    if (/^\d{4,8}$/.test(text)) {
      bot.sendMessage(chatId, "شكراً. الكود يرسل أوتوماتيكاً عندما يصل من البريد.");
      return;
    }

  } catch (err) {
    console.error('msg handler err', err);
  }
});

const imapConfig = {
  imap: {
    user: GMAIL_USER,
    password: GMAIL_APP_PASS,
    host: IMAP_HOST,
    port: IMAP_PORT,
    tls: true,
    authTimeout: 3000
  }
};

async function startImapLoop() {
  try {
    const connection = await Imap.connect(imapConfig);
    await connection.openBox('INBOX');
    console.log('IMAP connected, starting poll loop...');

    setInterval(async () => {
      try {
        const searchCriteria = ['UNSEEN', ['FROM', 'noreply@steampowered.com']];
        const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: true };
        const results = await connection.search(searchCriteria, fetchOptions);
        if (!results || !results.length) return;
        for (const res of results) {
          const raw = (res.parts || []).filter(p => p.which === 'TEXT').map(p => p.body).join('\n');
          const parsed = await simpleParser(raw);
          const body = (parsed.text || parsed.html || '').toString();
          const lower = body.toLowerCase();
          if (lower.includes('change') && (lower.includes('email') || lower.includes('password') || lower.includes('reset'))) {
            console.log('Ignored: change email/password message');
            continue;
          }
          const m = body.match(/\b\d{4,8}\b/);
          if (!m) continue;
          const code = m[0];
          console.log('Found code:', code);
          let sentTo = null;
          const keys = Object.keys(pending).filter(k => !k.startsWith('__temp__'));
          for (const uname of keys) {
            if (body.toLowerCase().includes(uname.toLowerCase())) {
              sentTo = pending[uname].chatId;
              if (canReceive(sentTo)) {
                bot.sendMessage(sentTo, `🔐 كود تسجيل الدخول لـ Steam: ${code}\n(لا تشارك الكود مع أي شخص)`);
                incDeliverCount(sentTo);
                delete pending[uname];
                fs.writeJSONSync(PENDING_FILE, pending, { spaces: 2 });
              } else {
                bot.sendMessage(sentTo, `⚠️ وصلت للحد اليومي (${DAILY_LIMIT}) لطلبات الكود. تواصل مع البائع.`);
              }
              break;
            }
          }
          if (!sentTo) {
            const nonTemp = Object.entries(pending).filter(([k,v]) => !k.startsWith('__temp__'));
            if (nonTemp.length === 1) {
              const [uname, info] = nonTemp[0];
              const buyer = info.chatId;
              if (canReceive(buyer)) {
                bot.sendMessage(buyer, `🔐 كود تسجيل الدخول لـ Steam: ${code}\n(لا تشارك الكود مع أي شخص)`);
                incDeliverCount(buyer);
                delete pending[uname];
                fs.writeJSONSync(PENDING_FILE, pending, { spaces: 2 });
              } else {
                bot.sendMessage(buyer, `⚠️ وصلت للحد اليومي (${DAILY_LIMIT}) لطلبات الكود. تواصل مع البائع.`);
              }
            } else {
              console.log('No match for this code or multiple pending.');
              if (OWNER_ID) {
                bot.sendMessage(OWNER_ID, `📩 وصل كود (${code}) لكن لم أستطع مطابقته لأي طلب معلّق. نص الرسالة:\n${body.substring(0,400)}`);
              }
            }
          }
        }
      } catch (err) {
        console.error('IMAP poll error', err);
      }
    }, POLL_INTERVAL);

  } catch (err) {
    console.error('IMAP connect error', err);
    setTimeout(startImapLoop, 10000);
  }
}

bot.on('polling_error', (err) => console.error('Polling error', err));
bot.on('error', (err) => console.error('Bot error', err));
startImapLoop();
console.log('Bot started, IMAP monitor started.');

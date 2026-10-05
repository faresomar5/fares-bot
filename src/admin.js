/**
 * admin.js — لوحة المطور (/admin)
 *
 * تحتوي:
 *  - التحقق من هوية المطور (OWNER_ID + ADMIN_IDS)
 *  - رسالة /start المخصصة (نص + أزرار ديناميكية) محفوظة في JSON
 *  - إذاعة للمشتركين في تيليجرام
 *  - إذاعة للأرقام المربوطة (واتساب)
 *  - إحصائيات كاملة
 *  - إدارة أزرار /start (إضافة بحالتين: اسم الزر ثم محتوى الرسالة، وحذف)
 *  - 13 أمر مطور مميز مع حماية guard
 *
 * كل شيء يُحفظ في data/devtools.json وينجو من إعادة التشغيل.
 */
import fs from 'node:fs';
import path from 'node:path';
import telegraf from 'telegraf';
const { Markup } = telegraf;
import { CONFIG } from './config.js';
import { store } from './store.js';
import {
  sessions,
  getSock,
  isConnected,
  stopSession,
  globalStats
} from './wa.js';
import { escapeHtml, cleanPhone, fmtUptime, fmtBytes, chunkText, delay, randInt } from './utils.js';

/* ==========================================================
 *  التخزين الدائم (JSON)
 * ========================================================== */
const FILE = path.join(CONFIG.DATA_DIR, 'devtools.json');

let db = {
  startMessage: null, // نص /start المخصص (null = الافتراضي)
  buttons: {}, // { [id]: { id, name, content, createdAt } }
  buttonOrder: [], // ترتيب ظهور الأزرار
  maintenance: false, // وضع الصيانة
  statsSnapshot: null,
  autoStatusOff: [] // مستخدمون عُطّل إشعارهم من الكود
};

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = { ...db, ...parsed };
  } catch {
    /* ملف جديد */
  }
}

function writeNow() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[admin] فشل الحفظ:', e.message);
  }
}

let timer = null;
const scheduleSave = () => {
  clearTimeout(timer);
  timer = setTimeout(writeNow, 500);
  timer.unref?.();
};

load();

/* ==========================================================
 *  هوية المطور
 * ========================================================== */
export function isDeveloper(ctxLike) {
  const id = Number(ctxLike?.tgId || ctxLike?.from?.id || 0);
  return !!id && (id === CONFIG.OWNER_ID || CONFIG.ADMIN_IDS.includes(id));
}

export const isMaintenanceOn = () => !!db.maintenance;
export const getDevDb = () => db;

/** صفوف أزرار /start المخصصة (callback_data = devbtn:<id> قصير) */
export function startButtonRows() {
  const rows = [];
  const btns = db.buttonOrder.map((id) => db.buttons[id]).filter(Boolean);
  for (let i = 0; i < btns.length; i += 2) {
    rows.push(btns.slice(i, i + 2).map((b) => Markup.button.callback(`🔹 ${b.name}`, `devbtn:${b.id}`)));
  }
  return rows;
}

/* ==========================================================
 *  نص رسالة /start (الافتراضي أو المخصص)
 * ========================================================== */
export function getStartText() {
  if (db.startMessage) return db.startMessage;
  return null; // null = استخدم الافتراضي في bot.js
}

/** أزرار /start: أزرار المطور المخصصة + رجوع للقائمة */
export function startButtonsMarkup() {
  const rows = [];
  const btns = db.buttonOrder.map((id) => db.buttons[id]).filter(Boolean);
  for (let i = 0; i < btns.length; i += 2) {
    rows.push(btns.slice(i, i + 2).map((b) => Markup.button.callback(`🔹 ${b.name}`, `devbtn:${b.id}`)));
  }
  rows.push([Markup.button.callback('⬅️ القائمة الرئيسية', 'act:menu')]);
  return Markup.inlineKeyboard(rows);
}

/** محتوى زر مخصص */
export const getDevButton = (id) => db.buttons[String(id)] || null;

/* ==========================================================
 *  1) أمر /admin — القائمة الرئيسية للمطور
 * ========================================================== */
export function regAdminCommands({ reg, need, sockOf, isDeveloper: isDev, escapeHtml: esc }) {
  const guard = { guard: true, devOnly: true, category: '👑 المطور' };

  reg('admin', {
    ...guard,
    desc: '👑 لوحة تحكم المطور الكاملة',
    aliases: ['الاوامر_مطور', 'لوحة_المطور'],
    handler: async (ctx) => {
      if (ctx.raw && ctx.raw.telegram) {
        // من تيليجرام: نص + لوحة
        const { listCommands, countDistinct, countCommands } = await import('./commands.js');
        const g = globalStats();
        const users = store.all();
        const connected = users.filter((u) => u.connected).length;
        const totalReacted = users.reduce((a, u) => a + (u.stats?.reacted || 0), 0);
        const totalViewed = users.reduce((a, u) => a + (u.stats?.viewed || 0), 0);
        const text =
          `👑 <b>لوحة تحكم المطور</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `🆔 آيديك: <code>${ctx.tgId}</code>\n` +
          `⚙️ إصدار البوت: <b>${CONFIG.VERSION}</b>\n` +
          `⏳ مدة التشغيل: ${fmtUptime(g.uptime)}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `👥 المستخدمون: <b>${g.users}</b> (مربوطين: <b>${connected}</b>)\n` +
          `🔢 الجلسات النشطة: <b>${g.connected}/${g.max}</b>\n` +
          `🧠 الذاكرة: Heap ${g.heapMB}MB | RSS ${g.rssMB}MB\n` +
          `━━━━━━━━━━━━━━━\n` +
          `👀 إجمالي المشاهدات: <b>${totalViewed}</b>\n` +
          `❤️ إجمالي التفاعلات: <b>${totalReacted}</b>\n` +
          `🔢 عدد الأوامر المسجلة: <b>${countDistinct()}</b> (مع المرادفات: ${countCommands()})\n` +
          `━━━━━━━━━━━━━━━\n` +
          `🛠 وضع الصيانة: ${db.maintenance ? '🟠 مفعّل' : '⚪ متوقف'}\n` +
          `✏️ رسالة /start مخصصة: ${db.startMessage ? '✅ نعم' : '❌ لا (افتراضية)'}\n` +
          `🔘 أزرار /start المخصصة: <b>${db.buttonOrder.length}</b>`;
        await ctx.reply(text, adminMenuKb());
      } else {
        // من واتساب: نص فقط
        const g = globalStats();
        await ctx.reply(
          `👑 <b>لوحة تحكم المطور</b>\n` +
            `👥 المستخدمون: ${g.users} | الجلسات: ${g.connected}/${g.max}\n` +
            `⏳ التشغيل: ${fmtUptime(g.uptime)}\n\n` +
            `📊 إحصائيات كاملة: <code>/devstats</code>\n` +
            `📜 أوامر المطور: <code>/devcmds</code>\n` +
            `🛠 وضع الصيانة: ${db.maintenance ? 'مفعّل 🟠' : 'متوقف ⚪'} — <code>/maintenance</code>`
        );
      }
    }
  });

  /* ---- أوامر المطور (أدوات إدارة لوحة /start) ---- */
  reg('setstart', {
    ...guard,
    desc: 'تغيير رسالة /start — /setstart النص',
    usage: '/setstart النص الجديد',
    aliases: ['رسالة_البداية'],
    handler: async (ctx) => {
      if (!ctx.argsStr) {
        db.startMessage = null;
        scheduleSave();
        return ctx.reply('♻️ تمت استعادة رسالة /start الافتراضية.');
      }
      db.startMessage = ctx.argsStr.slice(0, 3000);
      scheduleSave();
      await ctx.reply('✅ تم حفظ رسالة /start الجديدة.\n👁 للمعاينة أرسل <code>/start</code>');
    }
  });

  reg('addbtn', {
    ...guard,
    desc: 'إضافة زر تحت /start — /addbtn اسم الزر | المحتوى',
    usage: '/addbtn اسم الزر | المحتوى',
    aliases: ['اضف_زر'],
    handler: async (ctx) => {
      const m = ctx.argsStr.match(/^(.+?)\s*\|\s*([\s\S]+)$/);
      if (!m) return ctx.reply('✍️ الصيغة: <code>/addbtn اسم الزر | نص الرسالة</code>');
      const id = `b${Date.now().toString(36)}${randInt(100, 999)}`;
      db.buttons[id] = { id, name: m[1].trim().slice(0, 40), content: m[2].trim().slice(0, 3800), createdAt: Date.now() };
      db.buttonOrder.push(id);
      scheduleSave();
      await ctx.reply(`✅ تمت إضافة الزر «<b>${esc(m[1].trim())}</b>» تحت رسالة /start.\nأي شخص يضغط عليه سيستلم الرسالة التي أضفتها.\n👁 للمعاينة: <code>/start</code>`);
    }
  });

  reg('delbtn', {
    ...guard,
    desc: 'حذف زر من /start — /delbtn رقم أو اسم الزر',
    usage: '/delbtn اسم الزر',
    aliases: ['احذف_زر'],
    handler: async (ctx) => {
      if (!db.buttonOrder.length) return ctx.reply('ℹ️ لا توجد أزرار مخصصة.');
      if (!ctx.argsStr) {
        const list = db.buttonOrder.map((id, i) => `${i + 1}. ${esc(db.buttons[id]?.name || id)}`).join('\n');
        return ctx.reply(`🔘 <b>الأزرار الحالية</b>\n${list}\n\n🗑 للحذف: <code>/delbtn رقم الزر أو اسمه</code>\n💣 لحذف الكل: <code>/delbtnall</code>`);
      }
      const idx = Number(ctx.argsStr.trim());
      let target = null;
      if (Number.isInteger(idx) && idx >= 1 && idx <= db.buttonOrder.length) target = db.buttonOrder[idx - 1];
      else target = db.buttonOrder.find((id) => db.buttons[id]?.name === ctx.argsStr.trim());
      if (!target) return ctx.reply('⚠️ لم أجد هذا الزر. أرسل <code>/delbtn</code> لعرض القائمة.');
      const name = db.buttons[target]?.name;
      delete db.buttons[target];
      db.buttonOrder = db.buttonOrder.filter((x) => x !== target);
      scheduleSave();
      await ctx.reply(`🗑 تم حذف الزر «<b>${esc(name)}</b>».`);
    }
  });

  reg('delbtnall', {
    ...guard,
    desc: 'حذف كل أزرار /start المخصصة',
    aliases: ['حذف_الازرار'],
    handler: async (ctx) => {
      const n = db.buttonOrder.length;
      db.buttons = {};
      db.buttonOrder = [];
      scheduleSave();
      await ctx.reply(n ? `🗑 تم حذف كل الأزرار (${n}).` : 'ℹ️ لا توجد أزرار أصلاً.');
    }
  });

  reg('listbtn', {
    ...guard,
    desc: 'عرض أزرار /start المخصصة',
    aliases: ['الازرار'],
    handler: async (ctx) => {
      if (!db.buttonOrder.length) return ctx.reply('ℹ️ لا توجد أزرار مخصصة. أضف واحداً بـ <code>/addbtn</code>');
      const list = db.buttonOrder
        .map((id, i) => `${i + 1}. <b>${esc(db.buttons[id]?.name || id)}</b> — ${(db.buttons[id]?.content || '').slice(0, 60).replace(/\n/g, ' ')}…`)
        .join('\n');
      await ctx.reply(`🔘 <b>أزرار /start (${db.buttonOrder.length})</b>\n${list}`);
    }
  });

  /* ---- إذاعة تيليجرام ---- */
  reg('tgbcast', {
    ...guard,
    desc: 'إذاعة لكل مشتركي تيليجرام — /tgbcast النص',
    usage: '/tgbcast النص',
    aliases: ['اذاعة_تليجرام'],
    handler: async (ctx) => {
      if (!ctx.argsStr) return ctx.reply('✍️ اكتب نص الإذاعة بعد الأمر.');
      const users = store.all();
      await ctx.reply(`📢 جاري الإذاعة إلى ${users.length} مشترك في تيليجرام...`);
      let ok = 0;
      for (const u of users) {
        try {
          await (ctx.raw?.telegram || globalThis.__tgBot?.telegram).sendMessage(u.id, `📢 <b>إذاعة من المطور</b>\n━━━━━━━━━━━━━━━\n${ctx.argsStr}`, {
            parse_mode: 'HTML',
            disable_web_page_preview: true
          });
          ok++;
        } catch {
          /* محظور أو غير موجود */
        }
        await delay(randInt(300, 900)); // تقييد الإرسال لتفادي حظر تيليجرام
      }
      await ctx.reply(`✅ تم الإذاعة إلى ${ok}/${users.length} مشترك.`);
    }
  });

  /* ---- إذاعة للأرقام المربوطة (واتساب) ---- */
  reg('wabcast', {
    ...guard,
    desc: 'إذاعة لكل الأرقام المربوطة — /wabcast النص',
    usage: '/wabcast النص',
    aliases: ['اذاعة_الارقام'],
    handler: async (ctx) => {
      if (!ctx.argsStr) return ctx.reply('✍️ اكتب نص الإذاعة بعد الأمر.');
      const targets = [...sessions.values()].filter((s) => s.status === 'connected');
      if (!targets.length) return ctx.reply('ℹ️ لا توجد أرقام مربوطة حالياً.');
      await ctx.reply(`📢 جاري الإذاعة إلى ${targets.length} رقم مربوط...`);
      let ok = 0;
      for (const rec of targets) {
        try {
          await rec.sock.sendMessage(`${jidOf(rec)}@s.whatsapp.net`, { text: `📢 <b>رسالة من مطور البوت</b>\n━━━━━━━━━━━━━━━\n${ctx.argsStr}` });
          ok++;
        } catch {
          /* ignore */
        }
        await delay(randInt(800, 2000)); // تقييد لتفادي حظر واتساب
      }
      await ctx.reply(`✅ تم الإذاعة إلى ${ok}/${targets.length} رقم.`);
    }
  });

  /* ---- الصيانة ---- */
  reg('maintenance', {
    ...guard,
    desc: 'تشغيل/إيقاف وضع الصيانة',
    aliases: ['صيانة'],
    handler: async (ctx) => {
      db.maintenance = !db.maintenance;
      scheduleSave();
      await ctx.reply(db.maintenance ? '🛠 <b>تم تشغيل وضع الصيانة</b> — الأوامر متاحة للمطور فقط.' : '✅ <b>تم إيقاف وضع الصيانة</b> — البوت متاح للجميع.');
    }
  });

  /* ---- 13 أمر مطور مميز ---- */
  reg('devcmds', {
    ...guard,
    desc: '📜 قائمة أوامر المطور الـ13',
    aliases: ['اوامر_المطور'],
    handler: async (ctx) =>
      ctx.reply(
        `👑 <b>أوامر المطور المميزة (13)</b>\n━━━━━━━━━━━━━━━\n` +
          DEV_COMMANDS.map((c, i) => `${i + 1}. <code>/${c.n}</code> — ${c.d}`).join('\n')
      )
  });

  reg('devstats', {
    ...guard,
    desc: '📊 إحصائيات كاملة وشاملة',
    aliases: ['احصائيات_كامله'],
    handler: async (ctx) => {
      const g = globalStats();
      const users = store.all();
      const totalViewed = users.reduce((a, u) => a + (u.stats?.viewed || 0), 0);
      const totalReacted = users.reduce((a, u) => a + (u.stats?.reacted || 0), 0);
      const totalErrors = users.reduce((a, u) => a + (u.stats?.errors || 0), 0);
      const connects = users.reduce((a, u) => a + (u.stats?.connects || 0), 0);
      const top = users
        .sort((a, b) => (b.stats?.reacted || 0) - (a.stats?.reacted || 0))
        .slice(0, 10)
        .map((u, i) => `${i + 1}. <code>${u.id}</code> — ❤️${u.stats?.reacted || 0} 👀${u.stats?.viewed || 0} ${u.connected ? '🟢' : '⚪'}`)
        .join('\n');
      await ctx.reply(
        `📊 <b>الإحصائيات الكاملة</b>\n━━━━━━━━━━━━━━━\n` +
          `👥 المستخدمون: <b>${g.users}</b>\n` +
          `🟢 المربوطون الآن: <b>${[...sessions.values()].filter((s) => s.status === 'connected').length}</b>\n` +
          `🔢 حد الجلسات: ${g.max}\n` +
          `👀 إجمالي المشاهدات: <b>${totalViewed}</b>\n` +
          `❤️ إجمالي التفاعلات: <b>${totalReacted}</b>\n` +
          `⚠️ إجمالي الأخطاء: ${totalErrors}\n` +
          `🔌 مرات الربط: ${connects}\n` +
          `🧠 Heap: ${g.heapMB}MB | RSS: ${g.rssMB}MB\n` +
          `⏳ التشغيل: ${fmtUptime(g.uptime)}\n` +
          `📅 أول استخدام: ${users[0]?.createdAt ? new Date(Math.min(...users.map((u) => u.createdAt))).toLocaleDateString('ar-EG') : '—'}\n` +
          `━━━━━━━━━━━━━━━\n🏆 <b>الأكثر تفاعلاً</b>\n${top || '—'}`
      );
    }
  });

  reg('devping', {
    ...guard,
    desc: '🏓 فحص شامل لكل الجلسات',
    aliases: ['فحص_الجلسات'],
    handler: async (ctx) => {
      const recs = [...sessions.values()];
      if (!recs.length) return ctx.reply('ℹ️ لا توجد جلسات.');
      await ctx.reply(`🏓 جاري فحص ${recs.length} جلسة...`);
      let ok = 0;
      for (const rec of recs) {
        try {
          await rec.sock.sendPresenceUpdate('available');
          ok++;
        } catch {
          /* ignore */
        }
        await delay(200);
      }
      await ctx.reply(`🏓 نتيجة الفحص: <b>${ok}/${recs.length}</b> جلسة تستجيب.`);
    }
  });

  reg('devkill', {
    ...guard,
    desc: '💀 فصل رقم مربوط فوراً — /devkill <tgId|الكل>',
    usage: '/devkill <tgId>',
    aliases: ['فصل_رقم'],
    handler: async (ctx) => {
      const arg = (ctx.args[0] || '').trim();
      if (!arg) return ctx.reply('✍️ الصيغة: <code>/devkill 123456</code> أو <code>/devkill الكل</code>');
      if (arg === 'الكل' || arg.toLowerCase() === 'all') {
        let n = 0;
        for (const id of [...sessions.keys()]) {
          try {
            await stopSession(id, { logout: false });
            n++;
          } catch {
            /* ignore */
          }
        }
        return ctx.reply(`💀 تم فصل ${n} جلسة.`);
      }
      if (!sessions.has(arg)) return ctx.reply('⚠️ لا توجد جلسة بهذا الآيدي.');
      await stopSession(arg, { logout: false });
      await ctx.reply(`💀 تم فصل جلسة <code>${esc(arg)}</code>.`);
    }
  });

  reg('devmsg', {
    ...guard,
    desc: '✉️ رسالة لمستخدم تيليجرام — /devmsg <tgId> النص',
    usage: '/devmsg <tgId> النص',
    aliases: ['رسالة_لمستخدم'],
    handler: async (ctx) => {
      if (ctx.args.length < 2) return ctx.reply('✍️ الصيغة: <code>/devmsg 123456 النص</code>');
      const [id, ...rest] = ctx.args;
      try {
        await (ctx.raw?.telegram || globalThis.__tgBot?.telegram).sendMessage(id, `👑 <b>رسالة من المطور</b>\n━━━━━━━━━━━━━━━\n${rest.join(' ')}`, {
          parse_mode: 'HTML'
        });
        await ctx.reply('✅ تم الإرسال.');
      } catch (e) {
        await ctx.reply(`❌ فشل الإرسال: ${esc(e.message)}`);
      }
    }
  });

  reg('devreset', {
    ...guard,
    desc: '♻️ تصفير إحصائيات مستخدم — /devreset <tgId>',
    usage: '/devreset <tgId>',
    aliases: ['تصفير'],
    handler: async (ctx) => {
      const id = ctx.args[0];
      if (!id) return ctx.reply('✍️ الصيغة: <code>/devreset 123456</code>');
      const u = store.getUser(id);
      u.stats = { viewed: 0, reacted: 0, errors: 0, connects: 0, startedAt: u.stats?.startedAt || null };
      store.save();
      await ctx.reply(`♻️ تم تصفير إحصائيات <code>${esc(String(id))}</code>.`);
    }
  });

  reg('devannounce', {
    ...guard,
    desc: '📣 إذاعة مزدوجة (تيليجرام + واتساب)',
    usage: '/devannounce النص',
    aliases: ['اذاعة_مزدوجة'],
    handler: async (ctx) => {
      if (!ctx.argsStr) return ctx.reply('✍️ اكتب نص الإذاعة.');
      await ctx.reply('📢 جاري الإذاعة المزدوجة...');
      // تيليجرام
      let tgOk = 0;
      const tg = ctx.raw?.telegram || globalThis.__tgBot?.telegram;
      for (const u of store.all()) {
        try {
          await tg.sendMessage(u.id, `📣 <b>إذاعة عامة</b>\n━━━━━━━━━━━━━━━\n${ctx.argsStr}`, { parse_mode: 'HTML' });
          tgOk++;
        } catch {
          /* ignore */
        }
        await delay(randInt(250, 700));
      }
      // واتساب
      let waOk = 0;
      for (const rec of [...sessions.values()].filter((s) => s.status === 'connected')) {
        try {
          await rec.sock.sendMessage(`${jidOf(rec)}@s.whatsapp.net`, { text: `📣 إذاعة عامة\n━━━━━━━━━━━━━━━\n${ctx.argsStr}` });
          waOk++;
        } catch {
          /* ignore */
        }
        await delay(randInt(800, 1800));
      }
      await ctx.reply(`✅ الإذاعة المزدوجة: تيليجرام ${tgOk} | واتساب ${waOk}.`);
    }
  });

  reg('devmode', {
    ...guard,
    desc: '🧪 وضع المطور: تفاصيل تقنية حية',
    aliases: ['وضع_المطور'],
    handler: async (ctx) => {
      const g = globalStats();
      const mem = process.memoryUsage();
      const recs = [...sessions.values()];
      const rows = recs
        .slice(0, 15)
        .map((r) => `• <code>${r.tgId}</code> ${r.status} ⏳${fmtUptime(Date.now() - r.startedAt)}`)
        .join('\n');
      await ctx.reply(
        `🧪 <b>وضع المطور — تقرير حي</b>\n━━━━━━━━━━━━━━━\n` +
          `📦 Node: <code>${process.version}</code>\n` +
          `🧠 Heap Used: <code>${fmtBytes(mem.heapUsed)}</code> / Total <code>${fmtBytes(mem.heapTotal)}</code>\n` +
          `📊 RSS: <code>${fmtBytes(mem.rss)}</code>\n` +
          `⏱ Uptime: ${fmtUptime(g.uptime)}\n` +
          `🔢 الجلسات: ${recs.length} (متصلة: ${recs.filter((r) => r.status === 'connected').length})\n` +
          `🛠 الصيانة: ${db.maintenance ? '🟠 ON' : '⚪ OFF'}\n` +
          `🔘 أزرار /start: ${db.buttonOrder.length}\n` +
          `✏️ start مخصص: ${db.startMessage ? 'نعم' : 'لا'}\n` +
          `━━━━━━━━━━━━━━━\n${rows || '—'}`
      );
    }
  });

  reg('devbackup', {
    ...guard,
    desc: '💾 نسخة احتياطية شاملة (بيانات + إعدادات المطور)',
    aliases: ['نسخة_شاملة'],
    handler: async (ctx) => {
      const payload = JSON.stringify({ store: store.raw(), devtools: db }, null, 2);
      await ctx.replyDoc(Buffer.from(payload, 'utf8'), `full-backup-${Date.now()}.json`);
    }
  });

  reg('devreload', {
    ...guard,
    desc: '🔄 حفظ فوري لكل البيانات على القرص',
    aliases: ['حفظ_فوري'],
    handler: async (ctx) => {
      store.saveNow();
      writeNow();
      await ctx.reply('💾 تم حفظ كل البيانات فوراً على القرص.');
    }
  });
}

/** استخراج رقم الجلسة من سجل الجلسة */
function jidOf(rec) {
  const n = rec?.sock?.user?.id ? String(rec.sock.user.id).split('@')[0].split(':')[0] : rec?.phone || '';
  return n;
}

/* ==========================================================
 *  لوحات الأزرار الخاصة بالمطور
 * ========================================================== */
export function adminMenuKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✏️ تغيير رسالة /start', 'adm:setstart'), Markup.button.callback('📊 الإحصائيات الكاملة', 'adm:devstats')],
    [Markup.button.callback('📢 إذاعة تيليجرام', 'adm:tgbcast'), Markup.button.callback('📱 إذاعة الأرقام المربوطة', 'adm:wabcast')],
    [Markup.button.callback('➕ إضافة زر', 'adm:addbtn'), Markup.button.callback('🗑 حذف زر', 'adm:delbtn')],
    [Markup.button.callback('📜 أوامر المطور (13)', 'adm:devcmds'), Markup.button.callback('🛠 وضع الصيانة', 'adm:maintenance')],
    [Markup.button.callback('⬅️ رجوع', 'act:menu')]
  ]);
}

export const DEV_COMMANDS = [
  { n: 'admin', d: 'لوحة تحكم المطور' },
  { n: 'devcmds', d: 'قائمة أوامر المطور' },
  { n: 'devstats', d: 'إحصائيات كاملة وشاملة' },
  { n: 'devping', d: 'فحص كل الجلسات المتصلة' },
  { n: 'devkill', d: 'فصل جلسة أو كل الجلسات' },
  { n: 'devmsg', d: 'رسالة مباشرة لأي مستخدم' },
  { n: 'devreset', d: 'تصفير إحصائيات مستخدم' },
  { n: 'devannounce', d: 'إذاعة مزدوجة (تيليجرام + واتساب)' },
  { n: 'devmode', d: 'تقرير تقني حي للنظام' },
  { n: 'devbackup', d: 'نسخة احتياطية شاملة' },
  { n: 'devreload', d: 'حفظ فوري لكل البيانات' },
  { n: 'maintenance', d: 'تشغيل/إيقاف وضع الصيانة' },
  { n: 'tgbcast', d: 'إذاعة مشتركي تيليجرام' }
];

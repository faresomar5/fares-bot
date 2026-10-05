/**
 * bot.js — نقطة التشغيل الرئيسية
 * بوت تيليجرام متكامل لإدارة أرقام واتساب (Multi-Device) عبر Baileys
 *
 * التشغيل:
 *   cp .env.example .env      # ثم ضع BOT_TOKEN
 *   npm install
 *   npm start                 # node --expose-gc --max-old-space-size=450 bot.js
 */
import telegraf from 'telegraf';
const { Telegraf, Markup } = telegraf;

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, assertConfig, sessionDir } from './src/config.js';
import { store } from './src/store.js';
import { escapeHtml, cleanPhone, fmtBytes, fmtUptime, jidToNumber } from './src/utils.js';
import {
  sessions,
  getSock,
  isConnected,
  sessionCount,
  connectedCount,
  globalStats,
  startPairing,
  stopSession,
  resumeSession,
  startMemoryGuard,
  cleanTmp
} from './src/wa.js';
import { setNotifier } from './src/wa.js';
import { runCommand, countDistinct, countCommands } from './src/commands.js';
import * as kb from './src/keyboards.js';
import * as dl from './src/downloader.js';

assertConfig();

const bot = new Telegraf(CONFIG.BOT_TOKEN);

/* ==========================================================
 *  إشعارات من واتساب إلى تيليجرام
 * ========================================================== */
setNotifier((tgId, text) => {
  bot.telegram.sendMessage(tgId, text, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
});

/* ==========================================================
 *  تدفقات الإدخال (خطوات متعددة)
 * ========================================================== */
const flows = new Map();
const setFlow = (id, step, data = {}) => flows.set(String(id), { step, data, ts: Date.now() });
const getFlow = (id) => flows.get(String(id));
const clearFlow = (id) => flows.delete(String(id));

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (now - v.ts > 10 * 60 * 1000) flows.delete(k);
}, 60_000).unref?.();

/* ==========================================================
 *  أدوات مساعدة
 * ========================================================== */
const tgIdOf = (ctx) => String(ctx.from?.id || ctx.chat?.id || '');
const isOwner = (ctx) => {
  const id = Number(ctx.from?.id || 0);
  return id && (id === CONFIG.OWNER_ID || CONFIG.ADMIN_IDS.includes(id));
};

const safeEdit = async (ctx, text, extra = {}) => {
  const opts = { parse_mode: 'HTML', disable_web_page_preview: true, ...extra };
  try {
    return await ctx.editMessageText(text, opts);
  } catch {
    return ctx.reply(text, opts).catch(() => {});
  }
};

const reply = (ctx, text, extra = {}) =>
  ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

/** بناء ctx لمحرك الأوامر المشترك (تيليجرام) */
function tgCommandCtx(ctx, text) {
  const tgId = tgIdOf(ctx);
  const argsStr = String(text).replace(/^[./!#]\S+\s*/, '').trim();
  return {
    tgId,
    sock: getSock(tgId),
    jid: `tg:${tgId}`,
    raw: ctx,
    from: tgId,
    isGroup: false,
    isAdmin: true,
    isOwner: isOwner(ctx),
    pushName: ctx.from?.first_name || '',
    text: String(text),
    media: null,
    args: argsStr ? argsStr.split(/\s+/).filter(Boolean) : [],
    argsStr,
    reply: (t, o = {}) => reply(ctx, t, o),
    replyDoc: (buf, name) => ctx.replyWithDocument({ source: buf, filename: name }),
    download: async () => null
  };
}

const fmtStatusLine = (tgId) => {
  const rec = sessions.get(String(tgId));
  const s = rec?.status;
  if (!s) return '⚪ غير مربوط';
  if (s === 'connected') return '🟢 متصل ويعمل';
  if (s === 'reconnecting') return '🟡 جاري إعادة الاتصال...';
  if (s === 'awaiting_code') return '🔑 بانتظار إدخال الكود';
  if (s === 'pairing') return '⏳ جاري الربط';
  if (s === 'logged_out') return '🔴 تم تسجيل الخروج';
  return `⚪ ${s}`;
};

/* ==========================================================
 *  /start والقائمة الرئيسية
 * ========================================================== */
const WELCOME = (ctx) => {
  const tgId = tgIdOf(ctx);
  const u = store.getUser(tgId);
  const g = globalStats();
  return (
    `🚀 <b>مرحباً بك في بوت إدارة واتساب</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👋 ${escapeHtml(ctx.from?.first_name || 'صديقي')}\n` +
    `📊 حالة رقمك: ${fmtStatusLine(tgId)}\n` +
    `📱 الرقم المربوط: <code>${u.phone || '—'}</code>\n` +
    `😀 إيموجيات التفاعل: ${u.settings.emojis.length}\n` +
    `❤️ تفاعلات مُرسلة: <b>${u.stats.reacted}</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔢 أوامر النظام: <b>${countDistinct()}</b> (مع المرادفات: ${countCommands()})\n` +
    `🖥 الجلسات النشطة: <b>${g.connected}/${g.max}</b>\n` +
    `🧠 استهلاك الذاكرة: ${g.heapMB}MB\n` +
    `━━━━━━━━━━━━━━━\n` +
    `<i>اختر من الأزرار أدناه، أو أرسل رقمك مباشرة بصيغة دولية للربط بكود الاقتران.</i>`
  );
};

bot.start(async (ctx) => {
  store.getUser(tgIdOf(ctx));
  await reply(ctx, WELCOME(ctx), kb.mainMenu());
});

bot.command('menu', async (ctx) => {
  store.getUser(tgIdOf(ctx));
  await reply(ctx, '🏠 <b>القائمة الرئيسية</b>\nاختر ما تريد إدارته:', kb.mainMenu());
});

bot.command('help', async (ctx) => {
  const { listCommands } = await import('./src/commands.js');
  await reply(ctx, `📜 <b>الأوامر المتاحة</b>\n${listCommands()}`, kb.backMenu());
});

/* ==========================================================
 *  معالجات الأزرار
 * ========================================================== */
const A = (data, fn) => bot.action(data, fn);

A('act:menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, WELCOME(ctx), kb.mainMenu());
});

/* ---- الربط ---- */
A('act:connect', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setFlow(tgIdOf(ctx), 'connect_phone');
  await reply(
    ctx,
    '🔗 <b>ربط رقم جديد</b>\n\n' +
      '📱 أرسل رقمك بصيغة دولية <b>بدون + وبدون مسافات</b>\n' +
      'مثال: <code>966501234567</code>\n\n' +
      '⚠️ تأكد من صحة الرقم — كود الاقتران يُرسل لمرة واحدة.',
    kb.backMenu()
  );
});

A('act:disconnect', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(
    ctx,
    '❌ <b>فصل الرقم</b>\nهل تريد فصل الرقم الحالي عن البوت؟\n<i>(لن تُحذف الجلسة، ويمكنك إعادة الاتصال لاحقاً)</i>',
    kb.confirmMenu('do:disconnect')
  );
});

A('do:disconnect', async (ctx) => {
  await ctx.answerCbQuery('تم الفصل').catch(() => {});
  await stopSession(tgIdOf(ctx), { logout: false });
  await safeEdit(ctx, '🔌 تم فصل الرقم بنجاح.\nيمكنك إعادة الاتصال من «📊 حالة الحساب».', kb.backMenu());
});

A('act:status', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const tgId = tgIdOf(ctx);
  const u = store.getUser(tgId);
  const rec = sessions.get(tgId);
  const info = rec?.sock?.user;
  const text =
    `📊 <b>حالة الحساب</b>\n━━━━━━━━━━━━━━━\n` +
    `📱 الرقم: <code>${u.phone || '—'}</code>\n` +
    `🔌 الحالة: ${fmtStatusLine(tgId)}\n` +
    `👤 الاسم: ${escapeHtml(info?.name || info?.verifiedName || '—')}\n` +
    `🆔 واتساب: <code>${info ? jidToNumber(info.id) : '—'}</code>\n` +
    `🔁 محاولات الاتصال: ${rec?.attempts || 0}\n` +
    `💾 حجم الجلسة: ${fmtBytes((await import('./src/wa.js')).sessionSize(tgId))}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👀 حالات مشوهدة: <b>${u.stats.viewed}</b>\n` +
    `❤️ تفاعلات: <b>${u.stats.reacted}</b>\n` +
    `⚠️ أخطاء: ${u.stats.errors}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🔁 التفاعل التلقائي: ${u.settings.autoReact ? '✅ مفعّل' : '❌ متوقف'}\n` +
    `👀 المشاهدة أولاً: ${u.settings.viewFirst ? '✅' : '❌'}\n` +
    `💚 القلب الأخضر: ${u.settings.greenHeart ? '✅' : '❌'}\n` +
    `⏱ التأخير: ${u.settings.reactDelayMin}–${u.settings.reactDelayMax} ثانية`;
  await safeEdit(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔄 إعادة الاتصال', 'act:reconnect'), Markup.button.callback('🚪 خروج كامل', 'act:logout')],
      [Markup.button.callback('⬅️ رجوع', 'act:menu')]
    ])
  );
});

A('act:reconnect', async (ctx) => {
  await ctx.answerCbQuery('جاري إعادة الاتصال...').catch(() => {});
  const ok = await resumeSession(tgIdOf(ctx));
  await reply(ctx, ok ? '🔄 جاري إعادة الاتصال بالجلسة المحفوظة...' : '⚠️ لا توجد جلسة محفوظة. استخدم «🔗 ربط رقم جديد».');
});

A('act:logout', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(
    ctx,
    '🚪 <b>تسجيل خروج كامل</b>\nسيتم فصل الرقم <b>وحذف بيانات الجلسة نهائياً</b>.\nهل أنت متأكد؟',
    kb.confirmMenu('do:logout')
  );
});

A('do:logout', async (ctx) => {
  await ctx.answerCbQuery('تم الحذف').catch(() => {});
  const tgId = tgIdOf(ctx);
  await stopSession(tgId, { logout: true });
  const { clearAuth } = await import('./src/wa.js');
  clearAuth(tgId);
  store.update(tgId, { connected: false, phone: null });
  await safeEdit(ctx, '🚪 تم تسجيل الخروج وحذف الجلسة بالكامل.', kb.backMenu());
});

/* ---- مفاتيح التشغيل ---- */
const toggle = (key, labels) =>
  A(`act:toggle_${key}`, async (ctx) => {
    const tgId = tgIdOf(ctx);
    const u = store.getUser(tgId);
    const val = !u.settings[key];
    store.updateSettings(tgId, { [key]: val });
    await ctx.answerCbQuery(val ? labels[1] : labels[2]).catch(() => {});
    await safeEdit(
      ctx,
      `${val ? labels[1] : labels[2]}\n\n<b>${labels[0]}</b>: ${val ? '✅ مفعّل' : '❌ متوقف'}`,
      kb.settingsMenu()
    );
  });

toggle('autoReact', ['التفاعل التلقائي على الحالات', '🟢 تم تشغيل التفاعل التلقائي', '🔴 تم إيقاف التفاعل التلقائي']);
toggle('viewFirst', ['مشاهدة الحالة قبل التفاعل', '👀 سيتم مشاهدة الحالة أولاً', '⚪ تم إيقاف المشاهدة المسبقة']);
toggle('greenHeart', ['القلب الأخضر 💚', '💚 تم تشغيل القلب الأخضر', '⚪ تم إيقاف القلب الأخضر']);
toggle('protection', ['وضع الحماية', '🛡 تم تشغيل وضع الحماية', '⚠️ تم إيقاف وضع الحماية']);
toggle('readReceipts', ['إشعارات القراءة', '👁 تم تفعيل إشعار القراءة', '🙈 تم إيقاف إشعار القراءة']);
toggle('typingSim', ['محاكاة الكتابة', '⌨️ تم تفعيل محاكاة الكتابة', '⚪ تم إيقاف محاكاة الكتابة']);
toggle('antiDelete', ['مكافحة حذف الرسائل', '🛡 سيتم التقاط الرسائل المحذوفة', '⚪ تم إيقاف مكافحة الحذف']);
toggle('groupWelcome', ['ترحيب الأعضاء الجدد', '👋 تم تفعيل الترحيب', '⚪ تم إيقاف الترحيب']);
toggle('keepCustomEmojiLast', ['ترتيب التفاعل', '🔄 القلب الأخضر أولاً ثم الإيموجي', '🔄 الإيموجي المخصص أولاً ثم القلب']);

/* ---- الإيموجيات ---- */
A('act:emoji_list', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  await safeEdit(
    ctx,
    `😀 <b>إيموجيات التفاعل (${u.settings.emojis.length})</b>\n` +
      `━━━━━━━━━━━━━━━\n${u.settings.emojis.join('  ')}\n━━━━━━━━━━━━━━━\n` +
      `<i>اضغط على أي إيموجي لحذفه فوراً، أو أضف إيموجيات جديدة بلا حدود.</i>`,
    kb.emojiMenu(u.settings.emojis)
  );
});

A(/^emoji:del:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  const tgId = tgIdOf(ctx);
  const u = store.getUser(tgId);
  const removed = u.settings.emojis[idx];
  u.settings.emojis = u.settings.emojis.filter((_, i) => i !== idx);
  store.save();
  await ctx.answerCbQuery(removed ? `تم حذف ${removed}` : 'غير موجود').catch(() => {});
  await safeEdit(
    ctx,
    `😀 <b>إيموجيات التفاعل (${u.settings.emojis.length})</b>\n` +
      `━━━━━━━━━━━━━━━\n${u.settings.emojis.join('  ') || '—'}\n━━━━━━━━━━━━━━━\n` +
      `<i>اضغط على أي إيموجي لحذفه.</i>`,
    kb.emojiMenu(u.settings.emojis)
  );
});

A('act:emoji_add', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setFlow(tgIdOf(ctx), 'emoji_add');
  await reply(
    ctx,
    '➕ <b>إضافة إيموجيات جديدة</b>\n\n' +
      'أرسل الإيموجي (يمكنك إرسال عدة إيموجيات معاً).\n' +
      'مثال: <code>😀 🔥 💯 🥰</code>\n\n' +
      '♾ <i>لا يوجد حد أقصى لعدد الإيموجيات.</i>',
    kb.backMenu('act:emoji_list')
  );
});

A('act:emoji_del', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  await safeEdit(ctx, `🗑 <b>حذف إيموجي</b>\nاضغط على الإيموجي لحذفه:`, kb.emojiMenu(u.settings.emojis));
});

A('act:emoji_reset', async (ctx) => {
  await ctx.answerCbQuery('تمت الاستعادة').catch(() => {});
  const defaults = ['❤️', '🔥', '👏', '😍', '💯', '😂', '🙏', '💚'];
  store.updateSettings(tgIdOf(ctx), { emojis: defaults });
  await safeEdit(ctx, `♻️ تمت استعادة الإيموجيات الافتراضية:\n${defaults.join('  ')}`, kb.emojiMenu(defaults));
});

/* ---- التأخير ---- */
A('act:delay', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  setFlow(tgIdOf(ctx), 'delay');
  await reply(
    ctx,
    `⏱ <b>ضبط تأخير التفاعل</b>\n` +
      `القيمة الحالية: <b>${u.settings.reactDelayMin}–${u.settings.reactDelayMax}</b> ثانية\n\n` +
      `أرسل القيمتين بالصيغة: <code>5 15</code>\n` +
      `<i>التأخير يحاكي زمن قراءة الإنسان ويقلل خطر الحظر.</i>`,
    kb.backMenu()
  );
});

/* ---- الإعدادات ---- */
A('act:settings', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  const s = u.settings;
  await safeEdit(
    ctx,
    `⚙️ <b>الإعدادات المتقدمة</b>\n━━━━━━━━━━━━━━━\n` +
      `🔁 التفاعل التلقائي: ${s.autoReact ? '✅' : '❌'}\n` +
      `👀 المشاهدة أولاً: ${s.viewFirst ? '✅' : '❌'}\n` +
      `💚 القلب الأخضر: ${s.greenHeart ? '✅' : '❌'}\n` +
      `🔄 ترتيب التفاعل: ${s.keepCustomEmojiLast ? 'قلب ثم إيموجي' : 'إيموجي ثم قلب'}\n` +
      `🛡 الحماية: ${s.protection ? '✅' : '❌'}\n` +
      `👁 إشعار القراءة: ${s.readReceipts ? '✅' : '❌'}\n` +
      `⌨️ محاكاة الكتابة: ${s.typingSim ? '✅' : '❌'}\n` +
      `🗑 مكافحة الحذف: ${s.antiDelete ? '✅' : '❌'}\n` +
      `🔔 ساعات الهدوء: ${s.quietHours?.enabled ? `✅ (${s.quietHours.from}–${s.quietHours.to})` : '❌'}`,
    kb.settingsMenu()
  );
});

/* ---- ساعات الهدوء ---- */
A('act:quiet', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const tgId = tgIdOf(ctx);
  const u = store.getUser(tgId);
  if (u.settings.quietHours?.enabled) {
    store.updateSettings(tgId, { quietHours: { ...u.settings.quietHours, enabled: false } });
    return safeEdit(ctx, '🔕 تم إيقاف ساعات الهدوء.', kb.backMenu());
  }
  setFlow(tgId, 'quiet');
  await reply(
    ctx,
    '🔔 <b>ساعات الهدوء</b>\nخلال هذه الفترة لن يتفاعل الرقم مع الحالات.\n\nأرسل الساعات بالصيغة: <code>2 7</code>\n(أي من 2 صباحاً حتى 7 صباحاً)',
    kb.backMenu()
  );
});

/* ---- الإحصائيات والذاكرة ---- */
A('act:stats', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  const rate = u.stats.viewed ? ((u.stats.reacted / u.stats.viewed) * 100).toFixed(1) : '0.0';
  await safeEdit(
    ctx,
    `📈 <b>إحصائياتك</b>\n━━━━━━━━━━━━━━━\n` +
      `👀 حالات مشاهدة: <b>${u.stats.viewed}</b>\n` +
      `❤️ تفاعلات مُرسلة: <b>${u.stats.reacted}</b>\n` +
      `📉 نسبة التفاعل: <b>${rate}%</b>\n` +
      `⚠️ أخطاء: ${u.stats.errors}\n` +
      `🔌 مرات الاتصال: ${u.stats.connects}\n` +
      `📅 أول ربط: ${u.stats.startedAt ? new Date(u.stats.startedAt).toLocaleString('ar-EG') : '—'}`,
    kb.backMenu()
  );
});

A('act:gc', async (ctx) => {
  await ctx.answerCbQuery('جاري التنظيف...').catch(() => {});
  const before = process.memoryUsage().heapUsed;
  if (typeof global.gc === 'function') global.gc();
  const tmp = cleanTmp();
  const after = process.memoryUsage().heapUsed;
  const g = globalStats();
  await safeEdit(
    ctx,
    `🧹 <b>تنظيف الذاكرة</b>\n━━━━━━━━━━━━━━━\n` +
      `قبل: <code>${fmtBytes(before)}</code>\n` +
      `بعد: <code>${fmtBytes(after)}</code>\n` +
      `تم تحرير: <b>${fmtBytes(Math.max(0, before - after))}</b>\n` +
      `ملفات مؤقتة محذوفة: ${tmp}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🧠 Heap: ${g.heapMB}MB | RSS: ${g.rssMB}MB\n` +
      `🔢 الجلسات: ${g.connected}/${g.max}\n` +
      `⏳ التشغيل: ${fmtUptime(g.uptime)}` +
      (typeof global.gc === 'function' ? '' : '\n\n⚠️ <i>شغّل البوت بـ <code>--expose-gc</code> لتنظيف أقوى.</i>'),
    kb.backMenu()
  );
});

A('act:ping', async (ctx) => {
  const t = Date.now();
  await ctx.answerCbQuery('🏓').catch(() => {});
  const sock = getSock(tgIdOf(ctx));
  let wa = '⚪ غير مربوط';
  if (sock) {
    const t2 = Date.now();
    try {
      await sock.sendPresenceUpdate('available');
      wa = `🟢 متصل (${Date.now() - t2}ms)`;
    } catch {
      wa = '🟡 مربوط لكن لا يستجيب';
    }
  }
  await safeEdit(
    ctx,
    `🏓 <b>Pong!</b>\n⚡ زمن استجابة تيليجرام: <code>${Date.now() - t}ms</code>\n📡 واتساب: ${wa}`,
    kb.backMenu()
  );
});

/* ---- الحماية والمجموعات ---- */
A('act:toggle_protect', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const tgId = tgIdOf(ctx);
  const u = store.getUser(tgId);
  const v = !u.settings.protection;
  store.updateSettings(tgId, { protection: v });
  await safeEdit(
    ctx,
    `🛡 <b>وضع الحماية</b>: ${v ? '✅ مفعّل' : '❌ متوقف'}\n\n` +
      `<i>عند التفعيل: تقييد السرعة، تجاهل الرسائل الجماعية، واحترام قائمة الحظر.</i>`,
    kb.settingsMenu()
  );
});

A('act:blocklist', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  const list = u.settings.blocked || [];
  await safeEdit(
    ctx,
    `🚫 <b>قائمة الحظر (${list.length})</b>\n` +
      (list.length ? list.map((j) => `• <code>${jidToNumber(j)}</code>`).join('\n') : 'القائمة فارغة.') +
      `\n\n<i>للإضافة: <code>/block 9665xxxxxxxx</code></i>`,
    kb.backMenu()
  );
});

A('act:groups', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, '👥 <b>إدارة المجموعات</b>\nاختر العملية المطلوبة:', kb.groupsMenu());
});

A('grp:list', async (ctx) => {
  const tgId = tgIdOf(ctx);
  const sock = getSock(tgId);
  if (!sock || !isConnected(tgId)) {
    await ctx.answerCbQuery('لا يوجد رقم مربوط').catch(() => {});
    return safeEdit(ctx, '⚠️ لا يوجد رقم مربوط. اربط رقماً أولاً.', kb.groupsMenu());
  }
  await ctx.answerCbQuery('جاري الجلب...').catch(() => {});
  const all = await sock.groupFetchAllParticipating();
  const list = Object.values(all || {});
  const txt = list.length
    ? list.slice(0, 40).map((g, i) => `${i + 1}. <b>${escapeHtml(g.subject)}</b>\n   👥 ${g.participants?.length || 0} | <code>${g.id}</code>`).join('\n')
    : 'ℹ️ لا توجد مجموعات.';
  await safeEdit(ctx, `👥 <b>مجموعاتك (${list.length})</b>\n━━━━━━━━━━━━━━━\n${txt}`, kb.groupsMenu());
});

A('grp:close', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, '🔒 لقفل مجموعة أرسل:\n<code>/lock 123456@g.us</code>\n<i>أو نفّذ الأمر من داخل المجموعة نفسها.</i>', kb.groupsMenu());
});

A('grp:open', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, '🔓 لفتح مجموعة أرسل:\n<code>/unlock 123456@g.us</code>', kb.groupsMenu());
});

/* ---- الردود الآلية ---- */
A('act:autoreply', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const u = store.getUser(tgIdOf(ctx));
  const keys = Object.keys(u.settings.autoReplies || {});
  setFlow(tgIdOf(ctx), 'autoreply');
  await reply(
    ctx,
    `🤖 <b>الردود الآلية (${keys.length})</b>\n━━━━━━━━━━━━━━━\n` +
      (keys.length ? keys.map((k) => `• <code>${escapeHtml(k)}</code> → ${escapeHtml(u.settings.autoReplies[k])}`).join('\n') : 'لا توجد ردود بعد.') +
      `\n━━━━━━━━━━━━━━━\n` +
      `أرسل رداً جديداً بالصيغة:\n<code>الكلمة => الرد</code>\n\n` +
      `<i>للحذف: <code>/delreply الكلمة</code></i>`,
    kb.backMenu()
  );
});

/* ---- التحميل ---- */
A('act:downloader', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const ok = await dl.ytdlpAvailable();
  await safeEdit(
    ctx,
    `📥 <b>مركز التحميل</b>\n━━━━━━━━━━━━━━━\n` +
      `🎬 المنصات المدعومة: <b>${dl.PLATFORMS.length}</b>\n` +
      `🔧 محرك yt-dlp: ${ok ? '✅ متاح' : '❌ غير مثبت'}\n\n` +
      `<i>اختر جودة التنزيل، ثم أرسل الرابط.</i>\n` +
      `<i>للتحميل من أي منصة مباشرة: <code>/yt الرابط</code> أو <code>/tiktok الرابط</code> ...</i>`,
    kb.downloaderMenu()
  );
});

A(/^dl:(360|720|1080|mp3|info)$/, async (ctx) => {
  const q = ctx.match[1];
  const tgId = tgIdOf(ctx);
  await ctx.answerCbQuery().catch(() => {});
  if (q === 'info') {
    setFlow(tgId, 'dl_info');
    return reply(ctx, 'ℹ️ أرسل الرابط لجلب معلوماته بدون تحميل.', kb.backMenu('act:downloader'));
  }
  setFlow(tgId, 'dl_url', { quality: q });
  await reply(
    ctx,
    q === 'mp3'
      ? '🎵 <b>تحميل صوت MP3</b>\nأرسل الرابط الآن.'
      : `🎬 <b>تحميل فيديو بجودة ${q}p</b>\nأرسل الرابط الآن.`,
    kb.backMenu('act:downloader')
  );
});

/* ---- الإذاعة والمساعدة ---- */
A('act:broadcast', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const tgId = tgIdOf(ctx);
  if (!isConnected(tgId)) {
    return safeEdit(ctx, '⚠️ لا يوجد رقم مربوط.', kb.backMenu());
  }
  setFlow(tgId, 'broadcast');
  await reply(ctx, '📢 <b>رسالة جماعية</b>\nأرسل نص الرسالة التي تريد إرسالها لكل جهات الاتصال.\n\n⚠️ <i>يُنصح بعدم تجاوز 50 رسالة دفعة واحدة لتجنب الحظر.</i>', kb.backMenu());
});

A('act:help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const { listCommands } = await import('./src/commands.js');
  await safeEdit(ctx, `📜 <b>قائمة الأوامر</b>\n🔢 الأوامر: <b>${countDistinct()}</b> | مع المرادفات: <b>${countCommands()}</b>\n${listCommands()}`, kb.backMenu());
});

A('act:about', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const g = globalStats();
  await safeEdit(
    ctx,
    `ℹ️ <b>حول البوت</b>\n━━━━━━━━━━━━━━━\n` +
      `⚙️ الإصدار: <b>${CONFIG.VERSION}</b>\n` +
      `📦 Node: <code>${process.version}</code>\n` +
      `🔌 مكتبة واتساب: @whiskeysockets/baileys\n` +
      `🤖 مكتبة تيليجرام: telegraf\n` +
      `📥 محرك التحميل: yt-dlp\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👥 المستخدمون: ${g.users}\n` +
      `🔢 الجلسات: ${g.connected}/${g.max}\n` +
      `⏳ مدة التشغيل: ${fmtUptime(g.uptime)}`,
    kb.backMenu()
  );
});

/* ==========================================================
 *  استقبال الرسائل النصية: تدفقات + أوامر + روابط + أرقام
 * ========================================================== */
bot.on('text', async (ctx) => {
  const tgId = tgIdOf(ctx);
  const text = (ctx.message.text || '').trim();
  if (!text) return;
  store.getUser(tgId);

  /* 1) التدفقات (خطوات متعددة) */
  const flow = getFlow(tgId);
  if (flow) {
    flow.ts = Date.now();

    if (flow.step === 'connect_phone') {
      const phone = cleanPhone(text);
      if (phone.length < 8 || phone.length > 15) {
        return reply(ctx, '❌ الرقم غير صالح.\nأرسل الرقم بصيغة دولية بدون + أو مسافات.\nمثال: <code>966501234567</code>');
      }
      clearFlow(tgId);
      const msg = await reply(ctx, `⏳ جاري توليد كود الاقتران للرقم <code>${phone}</code>...`);
      try {
        const { code } = await startPairing(
          tgId,
          phone,
          (c) => bot.telegram.sendMessage(tgId, `🔑 <b>كود الاقتران</b>\n<code>${c}</code>`, { parse_mode: 'HTML' }).catch(() => {}),
          (ev, data) => {
            if (ev === 'open') {
              bot.telegram.sendMessage(tgId, `✅ تم ربط الرقم بنجاح: <b>${data}</b>`, { parse_mode: 'HTML' }).catch(() => {});
            }
          }
        );
        await reply(
          ctx,
          `✅ <b>كود الاقتران جاهز</b>\n━━━━━━━━━━━━━━━\n` +
            `📱 الرقم: <code>${phone}</code>\n` +
            `🔑 الكود: <code>${code}</code>\n` +
            `━━━━━━━━━━━━━━━\n` +
            `📲 افتح واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← <b>الربط برقم الهاتف</b> ← أدخل الكود.\n\n` +
            `⏳ الكود صالح لدقائق قليلة، وسيتم إشعارك فور نجاح الربط.`,
          kb.mainMenu()
        );
      } catch (e) {
        await reply(ctx, `❌ فشل الربط: ${escapeHtml(e.message)}`, kb.mainMenu());
      }
      return;
    }

    if (flow.step === 'emoji_add') {
      const added = [];
      const u = store.getUser(tgId);
      for (const em of [...text]) {
        if (/\p{Extended_Pictographic}/u.test(em) && !u.settings.emojis.includes(em)) {
          u.settings.emojis.push(em);
          added.push(em);
        }
      }
      store.save();
      clearFlow(tgId);
      return reply(
        ctx,
        added.length
          ? `✅ تمت إضافة ${added.length} إيموجي: ${added.join('  ')}\n📊 الإجمالي: <b>${u.settings.emojis.length}</b> إيموجي (بلا حدود).`
          : '⚠️ لم يُضف أي إيموجي (ربما موجود مسبقاً أو غير صالح).',
        kb.emojiMenu(u.settings.emojis)
      );
    }

    if (flow.step === 'delay') {
      const [a, b] = text.split(/\s+/).map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b > 600 || b < a) {
        return reply(ctx, '⏱ صيغة غير صحيحة. أرسل مثل: <code>5 15</code>');
      }
      store.updateSettings(tgId, { reactDelayMin: a, reactDelayMax: b });
      clearFlow(tgId);
      return reply(ctx, `⏱ تم ضبط التأخير: <b>${a}–${b}</b> ثانية قبل التفاعل.`, kb.settingsMenu());
    }

    if (flow.step === 'quiet') {
      const [from, to] = text.split(/\s+/).map(Number);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return reply(ctx, '⏰ صيغة غير صحيحة. أرسل مثل: <code>2 7</code>');
      store.updateSettings(tgId, { quietHours: { enabled: true, from, to } });
      clearFlow(tgId);
      return reply(ctx, `🔔 تم تشغيل ساعات الهدوء من <b>${from}</b> إلى <b>${to}</b>.`, kb.settingsMenu());
    }

    if (flow.step === 'autoreply') {
      const m = text.match(/^(.+?)\s*=>\s*(.+)$/s);
      if (!m) return reply(ctx, '✍️ الصيغة: <code>الكلمة => الرد</code>');
      const u = store.getUser(tgId);
      u.settings.autoReplies[m[1].trim()] = m[2].trim();
      u.settings.autoReply = true;
      store.save();
      clearFlow(tgId);
      return reply(ctx, `✅ تمت إضافة الرد الآلي: <code>${escapeHtml(m[1].trim())}</code>`, kb.backMenu());
    }

    if (flow.step === 'broadcast') {
      const sock = getSock(tgId);
      clearFlow(tgId);
      if (!sock) return reply(ctx, '⚠️ لا يوجد رقم مربوط.', kb.mainMenu());
      const contacts = Object.keys(sock.store?.contacts || {}).filter((j) => j.endsWith('@s.whatsapp.net'));
      if (!contacts.length) return reply(ctx, 'ℹ️ لا توجد جهات اتصال محمّلة.', kb.mainMenu());
      const status = await reply(ctx, `📢 جاري الإرسال إلى ${contacts.length} جهة اتصال...`);
      let ok = 0;
      for (const jid of contacts) {
        try {
          await sock.sendMessage(jid, { text });
          ok++;
          await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1800));
        } catch {
          /* ignore */
        }
      }
      return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `✅ تم الإرسال إلى ${ok}/${contacts.length}.`).catch(() => {});
    }

    if (flow.step === 'dl_url' || flow.step === 'dl_info') {
      if (!dl.isUrl(text)) return reply(ctx, '🔗 أرسل رابطاً صالحاً يبدأ بـ http/https.');
      const quality = flow.data?.quality || '720';
      const step = flow.step;
      clearFlow(tgId);
      const wait = await reply(ctx, `⏳ جاري المعالجة من ${dl.detectPlatform(text)}...`);
      try {
        if (step === 'dl_info') {
          const i = await dl.info(text);
          return ctx.telegram
            .editMessageText(
              ctx.chat.id,
              wait.message_id,
              undefined,
              `ℹ️ <b>معلومات الرابط</b>\n🎬 ${escapeHtml(i.title || '—')}\n📺 ${i.platform}\n⏱ ${i.duration ? Math.floor(i.duration / 60) + ':' + String(i.duration % 60).padStart(2, '0') : '—'}\n👤 ${escapeHtml(i.uploader || '—')}`,
              { parse_mode: 'HTML' }
            )
            .catch(() => {});
        }

        const res = await dl.download(text, quality === 'mp3' ? { audio: true } : { quality });
        try {
          if (res.size > 48 * 1024 * 1024) {
            return ctx.telegram
              .editMessageText(
                ctx.chat.id,
                wait.message_id,
                undefined,
                `⚠️ حجم الملف ${fmtBytes(res.size)} يتجاوز حد تيليجرام (50MB).\nجرّب جودة أقل مثل 360p.`,
                { parse_mode: 'HTML' }
              )
              .catch(() => {});
          }
          await ctx.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, '📤 جاري الرفع...').catch(() => {});
          if (res.audio) {
            await ctx.replyWithAudio({ source: res.file }, { title: res.title, performer: res.platform });
          } else {
            await ctx.replyWithVideo(
              { source: res.file },
              { caption: `🎬 <b>${res.platform}</b>\n📦 ${fmtBytes(res.size)}`, parse_mode: 'HTML' }
            );
          }
        } finally {
          dl.cleanup(res.dir);
        }
      } catch (e) {
        await ctx.telegram
          .editMessageText(ctx.chat.id, wait.message_id, undefined, `❌ ${escapeHtml(e.message)}`, { parse_mode: 'HTML' })
          .catch(() => {});
      }
      return;
    }
  }

  /* 2) الأوامر */
  if (['/', '.', '!', '#'].includes(text[0])) {
    const handled = await runCommand(tgCommandCtx(ctx, text));
    if (handled) return;
  }

  /* 3) رابط مباشر */
  if (dl.isUrl(text)) {
    setFlow(tgId, 'dl_url', { quality: '720' });
    return reply(
      ctx,
      `🔗 <b>تم اكتشاف رابط من ${dl.detectPlatform(text)}</b>\nاختر جودة التنزيل:`,
      kb.downloaderMenu()
    );
  }

  /* 4) رقم هاتف */
  const digits = cleanPhone(text);
  if (/^\+?[\d\s-]{8,18}$/.test(text) && digits.length >= 8) {
    setFlow(tgId, 'connect_phone');
    return reply(
      ctx,
      `📱 هل تريد ربط الرقم <code>${digits}</code>؟\n\nأرسل الرقم مرة أخرى للتأكيد، أو اضغط «🔗 ربط رقم جديد».`,
      kb.backMenu()
    );
  }

  /* 5) افتراضي */
  await reply(
    ctx,
    `🤖 لم أفهم هذا الطلب.\n\nيمكنك:\n• إرسال رقمك للربط\n• إرسال رابط للتحميل\n• استخدام الأزرار أدناه\n• كتابة <code>/help</code> لعرض كل الأوامر`,
    kb.mainMenu()
  );
});

/* ==========================================================
 *  معالجة الأخطاء
 * ========================================================== */
bot.catch((err, ctx) => {
  const e = err?.response?.description || err?.message || String(err);
  console.error('[telegraf]', e);
  if (ctx?.reply) ctx.reply(`⚠️ حدث خطأ: ${escapeHtml(e)}`).catch(() => {});
});

/* ==========================================================
 *  الإقلاع
 * ========================================================== */
async function bootstrap() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🚀 بوت تيليجرام + واتساب (Baileys)');
  console.log(`  📦 Node ${process.version}`);
  console.log(`  🔢 أوامر: ${countDistinct()} | مع المرادفات: ${countCommands()}`);
  console.log(`  🧠 حد الجلسات: ${CONFIG.MAX_SESSIONS}`);
  console.log(`  ♻️  GC متاح: ${typeof global.gc === 'function' ? 'نعم' : 'لا (شغّل بـ --expose-gc)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  startMemoryGuard();

  // إعادة تشغيل الجلسات المحفوظة تدريجياً (لتجنّب ارتفاع الذاكرة دفعة واحدة)
  const saved = store.all().filter((u) => fs.existsSync(path.join(sessionDir(u.id), 'creds.json')));
  if (saved.length) {
    console.log(`♻️  إعادة تشغيل ${saved.length} جلسة محفوظة...`);
    (async () => {
      for (const u of saved.slice(0, CONFIG.MAX_SESSIONS)) {
        try {
          await resumeSession(u.id);
          await new Promise((r) => setTimeout(r, 2500)); // تباعد لمنع الضغط
        } catch (e) {
          console.error(`[boot] فشل استئناف ${u.id}: ${e.message}`);
        }
      }
      console.log('✅ تم استئناف الجلسات.');
    })();
  }

  await bot.launch({ dropPendingUpdates: true });
  console.log('✅ بوت تيليجرام يعمل الآن.');

  const { setMyCommands } = bot.telegram;
  await setMyCommands([
    { command: 'start', description: 'القائمة الرئيسية والأزرار' },
    { command: 'menu', description: 'عرض لوحة التحكم' },
    { command: 'pair', description: 'ربط رقم عبر كود الاقتران' },
    { command: 'status', description: 'حالة الحساب المربوط' },
    { command: 'emojis', description: 'إدارة إيموجيات التفاعل' },
    { command: 'addemoji', description: 'إضافة إيموجي جديد' },
    { command: 'gc', description: 'تنظيف الذاكرة' },
    { command: 'stats', description: 'إحصائيات التفاعل' },
    { command: 'help', description: 'قائمة كل الأوامر' }
  ]).catch(() => {});
}

/* ==========================================================
 *  الإغلاق الآمن
 * ========================================================== */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n⏹ استقبال ${signal} — جاري الإغلاق الآمن...`);
  try {
    bot.stop(signal);
  } catch {
    /* ignore */
  }
  for (const id of [...sessions.keys()]) {
    try {
      await stopSession(id, { logout: false });
    } catch {
      /* ignore */
    }
  }
  store.saveNow();
  console.log('✅ تم حفظ البيانات وفصل الجلسات. إلى اللقاء!');
  setTimeout(() => process.exit(0), 500);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r?.message || r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

bootstrap().catch((e) => {
  console.error('❌ فشل الإقلاع:', e);
  process.exit(1);
});

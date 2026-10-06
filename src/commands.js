/**
 * commands.js — محرك الأوامر المتقدم (نواة) + سجل الأوامر
 *
 * كل أمر له: name, category, desc, usage, aliases[], handler(ctx)
 * ctx = { tgId, sock, jid, args, argsStr, text, isGroup, isAdmin, isOwner,
 *         reply(text, opts), replyMedia(), from, pushName, raw }
 */
import { store } from './store.js';
import { CONFIG } from './config.js';
import { extras } from './commands.extra.js';
import {
  sessions,
  getSock,
  isConnected,
  startPairing,
  stopSession,
  resumeSession,
  sendFrom,
  accountInfo,
  sessionSize,
  globalStats,
  cleanTmp,
  clearAuth
} from './wa.js';
import * as dl from './downloader.js';
import { publishTextStatus } from './status.js';
import { cleanPhone, jidToNumber, fmtBytes, fmtUptime, randInt, escapeHtml, md5, sendLong } from './utils.js';
import { isDeveloper, isMaintenanceOn } from './admin.js';

export const registry = new Map();
export const aliasMap = new Map();

export function reg(name, def) {
  const canonical = String(name).toLowerCase();
  registry.set(canonical, {
    name: canonical,
    category: def.category || 'عام',
    desc: def.desc || '',
    usage: def.usage || `/${canonical}`,
    waOnly: !!def.waOnly,
    devOnly: !!def.devOnly,
    guard: !!def.guard,
    handler: def.handler || (async () => {}),
    aliases: def.aliases || []
  });
  for (const a of def.aliases || []) aliasMap.set(String(a).toLowerCase(), canonical);
}

const need = (cond, msg = '⚠️ هذا الأمر يحتاج رقماً مربوطاً وشغّالاً.') => {
  if (!cond) throw new Error(msg);
};

const sockOf = (ctx) => {
  const s = ctx.sock || getSock(ctx.tgId);
  need(s && isConnected(ctx.tgId), '⚠️ لا يوجد رقم مربوط أو الاتصال غير جاهز. استخدم «🔗 ربط رقم جديد».');
  return s;
};

/* ==========================================================
 *  1) أوامر النظام والحساب
 * ========================================================== */
reg('ping', {
  category: 'النظام',
  desc: 'قياس سرعة استجابة البوت',
  aliases: ['بنق', 'فحص'],
  handler: async (ctx) => {
    const t = Date.now();
    const s = getSock(ctx.tgId);
    let wa = 'غير مربوط';
    if (s) {
      try {
        await s.sendPresenceUpdate('available');
        wa = `متصل (${Date.now() - t}ms)`;
      } catch {
        wa = 'مربوط لكن لا يستجيب';
      }
    }
    await ctx.reply(`🏓 <b>Pong!</b>\n⚡ زمن الاستجابة: <code>${Date.now() - t}ms</code>\n📡 واتساب: ${wa}`);
  }
});

reg('id', {
  category: 'النظام',
  desc: 'عرض آيديك وآيدي المحادثة',
  aliases: ['ايدي'],
  handler: async (ctx) => {
    await ctx.reply(
      `🆔 آيديك في تيليجرام: <code>${ctx.tgId}</code>\n` +
        `💬 آيدي المحادثة: <code>${ctx.jid || '—'}</code>\n` +
        `👤 الاسم: ${escapeHtml(ctx.pushName || '—')}`
    );
  }
});

reg('status', {
  category: 'الحساب',
  desc: 'حالة الحساب المربوط بالتفصيل',
  aliases: ['حالة', 'حسابي'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const rec = sessions.get(String(ctx.tgId));
    const info = await accountInfo(ctx.tgId);
    const lines = [
      '📊 <b>حالة الحساب</b>',
      '━━━━━━━━━━━━━━━',
      `📱 الرقم: <code>${u.phone || '—'}</code>`,
      `🟢 الاتصال: <b>${rec?.status === 'connected' ? 'متصل' : rec?.status || 'غير مربوط'}</b>`,
      `👤 الاسم: ${escapeHtml(info?.name || '—')}`,
      `🔗 محاولات الربط: ${rec?.attempts || 0}`,
      `💾 حجم الجلسة: ${fmtBytes(sessionSize(ctx.tgId))}`,
      '━━━━━━━━━━━━━━━',
      `😀 الإيموجيات (${u.settings.emojis.length}): ${u.settings.emojis.join(' ')}`,
      `🔁 التفاعل التلقائي: ${u.settings.autoReact ? '✅' : '❌'}`,
      `👀 المشاهدة أولاً: ${u.settings.viewFirst ? '✅' : '❌'}`,
      `💚 القلب الأخضر: ${u.settings.greenHeart ? '✅' : '❌'}`,
      `⏱ التأخير: ${u.settings.reactDelayMin}–${u.settings.reactDelayMax} ثانية`,
      `🛡 الحماية: ${u.settings.protection ? '✅' : '❌'}`,
      '━━━━━━━━━━━━━━━',
      `👀 حالات تمت مشاهدتها: <b>${u.stats.viewed}</b>`,
      `❤️ تفاعلات مُرسلة: <b>${u.stats.reacted}</b>`,
      `⚠️ أخطاء: ${u.stats.errors}`,
      `🔌 مرات الاتصال: ${u.stats.connects}`
    ];
    await ctx.reply(lines.join('\n'));
  }
});

reg('sysinfo', {
  category: 'النظام',
  desc: 'معلومات السيرفر والذاكرة',
  aliases: ['معلومات', 'sys'],
  handler: async (ctx) => {
    const g = globalStats();
    await ctx.reply(
      `🖥 <b>معلومات النظام</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⏳ مدة التشغيل: ${fmtUptime(g.uptime)}\n` +
        `📦 Node: <code>${process.version}</code>\n` +
        `🧠 Heap: <b>${g.heapMB} MB</b>\n` +
        `📊 RSS: <b>${g.rssMB} MB</b>\n` +
        `🔢 الجلسات: <b>${g.connected}/${g.max}</b> متصلة\n` +
        `👥 المستخدمون: ${g.users}\n` +
        `🗂 الحالات في الذاكرة: ${g.seen}\n` +
        `⚙️ إصدار البوت: ${CONFIG.VERSION}`
    );
  }
});

reg('gc', {
  category: 'النظام',
  desc: 'تنظيف الذاكرة وتشغيل جامع القمامة',
  aliases: ['تنظيف', 'clean', 'ram'],
  handler: async (ctx) => {
    const before = process.memoryUsage().heapUsed;
    if (typeof global.gc === 'function') global.gc();
    cleanTmp();
    const after = process.memoryUsage().heapUsed;
    await ctx.reply(
      `🧹 <b>تم تنظيف الذاكرة</b>\n` +
        `قبل: <code>${fmtBytes(before)}</code>\n` +
        `بعد: <code>${fmtBytes(after)}</code>\n` +
        `تم تحرير: <b>${fmtBytes(Math.max(0, before - after))}</b>`
    );
  }
});

reg('stats', {
  category: 'النظام',
  desc: 'إحصائيات تفاعل الحالات',
  aliases: ['احصائيات'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const rate = u.stats.viewed ? ((u.stats.reacted / u.stats.viewed) * 100).toFixed(1) : '0.0';
    await ctx.reply(
      `📈 <b>إحصائياتك</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `👀 حالات مشاهدة: <b>${u.stats.viewed}</b>\n` +
        `❤️ تفاعلات: <b>${u.stats.reacted}</b>\n` +
        `📉 نسبة التفاعل: ${rate}%\n` +
        `⚠️ أخطاء: ${u.stats.errors}\n` +
        `🔌 اتصالات: ${u.stats.connects}`
    );
  }
});

/* ==========================================================
 *  2) الربط والاتصال
 * ========================================================== */
reg('pair', {
  category: 'الحساب',
  desc: 'ربط رقم عبر كود الاقتران',
  usage: '/pair 9665xxxxxxxx',
  aliases: ['ربط', 'paircode', 'connect'],
  handler: async (ctx) => {
    if (!ctx.args[0]) return ctx.reply('📱 أرسل الرقم بصيغة دولية بدون + مثال:\n<code>/pair 966501234567</code>');
    const phone = cleanPhone(ctx.args[0]);
    const msg = await ctx.reply('⏳ جاري توليد كود الاقتران...');
    try {
      const { code } = await startPairing(
        ctx.tgId,
        phone,
        (c) => ctx.reply(`🔑 <b>كود الاقتران</b>\n<code>${c}</code>\n\nافتح واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف`),
        () => {}
      );
      await ctx.reply(
        `✅ <b>كود الاقتران جاهز</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📱 الرقم: <code>${phone}</code>\n` +
          `🔑 الكود: <code>${code}</code>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📲 واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← <b>الربط برقم الهاتف</b> ← أدخل الكود.`
      );
    } catch (e) {
      await ctx.reply(`❌ فشل الربط: ${escapeHtml(e.message)}`);
    }
  }
});

reg('disconnect', {
  category: 'الحساب',
  desc: 'فصل الرقم (بدون حذف الجلسة)',
  aliases: ['فصل', 'ايقاف', 'stop'],
  handler: async (ctx) => {
    const ok = await stopSession(ctx.tgId, { logout: false });
    store.update(ctx.tgId, { connected: false });
    await ctx.reply(ok ? '🔌 تم فصل الرقم. يمكنك إعادة الاتصال من «📊 حالة الحساب».' : 'ℹ️ لا يوجد رقم مربوط أصلاً.');
  }
});

reg('logout', {
  category: 'الحساب',
  desc: 'تسجيل الخروج وحذف الجلسة نهائياً',
  aliases: ['خروج', 'حذف_الجلسة'],
  handler: async (ctx) => {
    await stopSession(ctx.tgId, { logout: true });
    clearAuth(ctx.tgId);
    store.update(ctx.tgId, { connected: false, phone: null });
    await ctx.reply('🚪 تم تسجيل الخروج وحذف بيانات الجلسة بالكامل.');
  }
});

reg('reconnect', {
  category: 'الحساب',
  desc: 'إعادة تشغيل الاتصال بالجلسة المحفوظة',
  aliases: ['اعادة', 'restart_wa'],
  handler: async (ctx) => {
    const ok = await resumeSession(ctx.tgId);
    await ctx.reply(ok ? '🔄 جاري إعادة الاتصال...' : '⚠️ لا توجد جلسة محفوظة. استخدم «🔗 ربط رقم جديد».');
  }
});

reg('profile', {
  category: 'الحساب',
  desc: 'عرض بروفايل الرقم المربوط',
  aliases: ['بروفايل'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const info = await accountInfo(ctx.tgId);
    await ctx.reply(
      `👤 <b>بروفايل واتساب</b>\n` +
        `الاسم: <b>${escapeHtml(info?.name || '—')}</b>\n` +
        `الرقم: <code>${info?.number || '—'}</code>\n` +
        `الحالة: ${s.user?.status || '—'}`
    );
  }
});

reg('setname', {
  category: 'الحساب',
  desc: 'تغيير اسم حساب واتساب',
  usage: '/setname الاسم الجديد',
  aliases: ['اسم'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب الاسم الجديد بعد الأمر.');
    await s.updateProfileName(ctx.argsStr.slice(0, 25));
    await ctx.reply(`✅ تم تغيير الاسم إلى: <b>${escapeHtml(ctx.argsStr.slice(0, 25))}</b>`);
  }
});

reg('setabout', {
  category: 'الحساب',
  desc: 'تغيير الحالة النصية (About)',
  usage: '/setabout النص',
  aliases: ['حالة_نصية'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب النص بعد الأمر.');
    await s.updateProfileStatus(ctx.argsStr.slice(0, 139));
    await ctx.reply('✅ تم تحديث الحالة النصية.');
  }
});

reg('getpp', {
  category: 'الحساب',
  desc: 'جلب صورة بروفايل رقم',
  usage: '/getpp 9665xxxxxxxx',
  aliases: ['صورة'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const target = ctx.args[0] ? `${cleanPhone(ctx.args[0])}@s.whatsapp.net` : s.user.id;
    try {
      const url = await s.profilePictureUrl(target, 'image');
      await ctx.reply(`🖼 <a href="${url}">رابط صورة البروفايل</a>`);
    } catch {
      await ctx.reply('🚫 لا توجد صورة بروفايل ظاهرة لهذا الرقم (أو الخصوصية تمنع الوصول).');
    }
  }
});

reg('setpp', {
  category: 'الحساب',
  desc: 'تغيير صورة بروفايل واتساب (أرسل صورة بعد الأمر)',
  waOnly: true,
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.media) return ctx.reply('🖼 أرسل صورة مع الأمر لتغيير صورة البروفايل.');
    const buf = await ctx.download();
    await s.updateProfilePicture(s.user.id, buf);
    await ctx.reply('✅ تم تحديث صورة البروفايل.');
  }
});

reg('block', {
  category: 'الحساب',
  desc: 'حظر رقم',
  usage: '/block 9665xxxxxxxx',
  aliases: ['حظر'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    const jid = `${cleanPhone(ctx.args[0])}@s.whatsapp.net`;
    await s.updateBlockStatus(jid, 'block');
    const u = store.getUser(ctx.tgId);
    if (!u.settings.blocked.includes(jid)) u.settings.blocked.push(jid);
    store.save();
    await ctx.reply(`🚫 تم حظر <code>${cleanPhone(ctx.args[0])}</code>`);
  }
});

reg('unblock', {
  category: 'الحساب',
  desc: 'إلغاء حظر رقم',
  usage: '/unblock 9665xxxxxxxx',
  aliases: ['الغاء_حظر'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    const jid = `${cleanPhone(ctx.args[0])}@s.whatsapp.net`;
    await s.updateBlockStatus(jid, 'unblock');
    const u = store.getUser(ctx.tgId);
    u.settings.blocked = u.settings.blocked.filter((x) => x !== jid);
    store.save();
    await ctx.reply(`✅ تم إلغاء حظر <code>${cleanPhone(ctx.args[0])}</code>`);
  }
});

reg('blocklist', {
  category: 'الحساب',
  desc: 'عرض قائمة المحظورين',
  aliases: ['المحظورين'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const list = await s.fetchBlocklist();
    await ctx.reply(list?.length ? `🚫 <b>المحظورون (${list.length})</b>\n` + list.map((j) => `• <code>${jidToNumber(j)}</code>`).join('\n') : 'ℹ️ قائمة الحظر فارغة.');
  }
});

reg('online', {
  category: 'الحساب',
  desc: 'إظهار الحساب كمتصل',
  aliases: ['اتصال'],
  handler: async (ctx) => {
    await sockOf(ctx).sendPresenceUpdate('available');
    await ctx.reply('🟢 تم ضبط الحساب على «متصل».');
  }
});

reg('offline', {
  category: 'الحساب',
  desc: 'إظهار الحساب كغير متصل',
  handler: async (ctx) => {
    await sockOf(ctx).sendPresenceUpdate('unavailable');
    await ctx.reply('⚪ تم ضبط الحساب على «غير متصل».');
  }
});

reg('read', {
  category: 'الحساب',
  desc: 'تفعيل إشعارات القراءة',
  handler: async (ctx) => {
    store.updateSettings(ctx.tgId, { readReceipts: true });
    await ctx.reply('👁 تم تفعيل إشعار القراءة.');
  }
});

reg('unread', {
  category: 'الحساب',
  desc: 'إيقاف إشعارات القراءة',
  handler: async (ctx) => {
    store.updateSettings(ctx.tgId, { readReceipts: false });
    await ctx.reply('🙈 تم إيقاف إشعار القراءة.');
  }
});

reg('poststatus', {
  category: 'الحساب',
  desc: 'نشر حالة نصية على واتساب',
  usage: '/poststatus نص الحالة',
  aliases: ['نشر_حالة'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب نص الحالة بعد الأمر.');
    const contacts = Object.keys(store.raw().users)
      .map((k) => store.raw().users[k].phone)
      .filter(Boolean)
      .map((p) => `${p}@s.whatsapp.net`);
    await publishTextStatus(s, ctx.argsStr, contacts);
    await ctx.reply('📢 تم نشر الحالة النصية.');
  }
});

/* ==========================================================
 *  3) الإيموجيات والتفاعل
 * ========================================================== */
reg('emojis', {
  category: 'التفاعل',
  desc: 'عرض إيموجيات التفاعل',
  aliases: ['ايموجيات', 'الايموجي'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    await ctx.reply(
      `😀 <b>إيموجياتك (${u.settings.emojis.length})</b>\n${u.settings.emojis.join('  ')}\n\n` +
        `➕ لإضافة: <code>/addemoji 😀</code>\n🗑 للحذف: <code>/delemoji 😀</code>`
    );
  }
});

reg('addemoji', {
  category: 'التفاعل',
  desc: 'إضافة إيموجي أو أكثر للتفاعل (بلا حدود)',
  usage: '/addemoji 😀 🔥',
  aliases: ['اضف_ايموجي', 'ايموجي_جديد'],
  handler: async (ctx) => {
    if (!ctx.args.length) return ctx.reply('😀 اكتب الإيموجي بعد الأمر، مثال: <code>/addemoji 😀 🔥 💯</code>');
    const u = store.getUser(ctx.tgId);
    const added = [];
    for (const raw of ctx.args) {
      for (const em of [...raw]) {
        if (/\p{Extended_Pictographic}/u.test(em) && !u.settings.emojis.includes(em)) {
          u.settings.emojis.push(em);
          added.push(em);
        }
      }
    }
    store.save();
    await ctx.reply(
      added.length
        ? `✅ تمت إضافة: ${added.join(' ')}\n📊 الإجمالي الآن: <b>${u.settings.emojis.length}</b> إيموجي (بلا حدود).`
        : '⚠️ لم يُضف أي إيموجي جديد (ربما موجود مسبقاً أو غير صالح).'
    );
  }
});

reg('delemoji', {
  category: 'التفاعل',
  desc: 'حذف إيموجي من القائمة',
  usage: '/delemoji 😀',
  aliases: ['احذف_ايموجي'],
  handler: async (ctx) => {
    if (!ctx.args.length) return ctx.reply('✍️ اكتب الإيموجي بعد الأمر.');
    const u = store.getUser(ctx.tgId);
    const before = u.settings.emojis.length;
    u.settings.emojis = u.settings.emojis.filter((e) => !ctx.args.includes(e));
    store.save();
    await ctx.reply(`🗑 تم الحذف (${before} → ${u.settings.emojis.length}).`);
  }
});

reg('resetemoji', {
  category: 'التفاعل',
  desc: 'استعادة الإيموجيات الافتراضية',
  aliases: ['استعادة_ايموجي'],
  handler: async (ctx) => {
    const defaults = ['❤️', '🔥', '👏', '😍', '💯', '😂', '🙏', '💚'];
    store.updateSettings(ctx.tgId, { emojis: defaults });
    await ctx.reply(`♻️ تمت الاستعادة: ${defaults.join(' ')}`);
  }
});

reg('reacton', {
  category: 'التفاعل',
  desc: 'تشغيل التفاعل التلقائي',
  aliases: ['تفاعل_تشغيل'],
  handler: async (ctx) => {
    store.updateSettings(ctx.tgId, { autoReact: true });
    await ctx.reply('🟢 تم تشغيل التفاعل التلقائي على الحالات.');
  }
});

reg('reactoff', {
  category: 'التفاعل',
  desc: 'إيقاف التفاعل التلقائي',
  aliases: ['تفاعل_ايقاف'],
  handler: async (ctx) => {
    store.updateSettings(ctx.tgId, { autoReact: false });
    await ctx.reply('🔴 تم إيقاف التفاعل التلقائي.');
  }
});

reg('delay', {
  category: 'التفاعل',
  desc: 'ضبط تأخير التفاعل بالثواني',
  usage: '/delay 5 15',
  aliases: ['تأخير'],
  handler: async (ctx) => {
    const [a, b] = ctx.args.map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b > 600 || b < a) {
      return ctx.reply('⏱ الاستخدام: <code>/delay 5 15</code> (من 1 إلى 600 ثانية)');
    }
    store.updateSettings(ctx.tgId, { reactDelayMin: a, reactDelayMax: b });
    await ctx.reply(`⏱ تم ضبط التأخير: <b>${a}–${b}</b> ثانية قبل التفاعل.`);
  }
});

reg('heart', {
  category: 'التفاعل',
  desc: 'تشغيل/إيقاف القلب الأخضر 💚',
  aliases: ['قلب_اخضر'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.greenHeart;
    store.updateSettings(ctx.tgId, { greenHeart: v });
    await ctx.reply(v ? '💚 تم تشغيل القلب الأخضر.' : '⚪ تم إيقاف القلب الأخضر.');
  }
});

reg('viewfirst', {
  category: 'التفاعل',
  desc: 'تشغيل/إيقاف مشاهدة الحالة قبل التفاعل',
  aliases: ['مشاهدة'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.viewFirst;
    store.updateSettings(ctx.tgId, { viewFirst: v });
    await ctx.reply(v ? '👀 سيتم مشاهدة الحالة أولاً (سلوك بشري).' : '⚪ تم إيقاف المشاهدة المسبقة.');
  }
});

reg('reactorder', {
  category: 'التفاعل',
  desc: 'عكس ترتيب التفاعل (القلب أولاً)',
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.keepCustomEmojiLast;
    store.updateSettings(ctx.tgId, { keepCustomEmojiLast: v });
    await ctx.reply(v ? '🔄 سيُرسل القلب الأخضر أولاً ثم الإيموجي المخصص.' : '🔄 سيُرسل الإيموجي المخصص أولاً ثم القلب الأخضر.');
  }
});

reg('quiet', {
  category: 'التفاعل',
  desc: 'ساعات الهدوء (لا تفاعل)',
  usage: '/quiet 2 7',
  aliases: ['هدوء'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    if (!ctx.args.length) {
      const v = !u.settings.quietHours.enabled;
      store.updateSettings(ctx.tgId, { quietHours: { ...u.settings.quietHours, enabled: v } });
      return ctx.reply(v ? '🔔 تم تشغيل ساعات الهدوء (2ص–7ص).' : '🔕 تم إيقاف ساعات الهدوء.');
    }
    const [from, to] = ctx.args.map(Number);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return ctx.reply('⏰ مثال: <code>/quiet 2 7</code>');
    store.updateSettings(ctx.tgId, { quietHours: { enabled: true, from, to } });
    await ctx.reply(`🔔 ساعات الهدوء: من ${from}:00 إلى ${to}:00`);
  }
});

/* ==========================================================
 *  4) الحماية والردود الآلية
 * ========================================================== */
reg('protect', {
  category: 'الحماية',
  desc: 'تشغيل/إيقاف وضع الحماية',
  aliases: ['حماية'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.protection;
    store.updateSettings(ctx.tgId, { protection: v });
    await ctx.reply(v ? '🛡 تم تشغيل وضع الحماية (تقييد السرعة + تجاهل الرسائل الجماعية).' : '⚠️ تم إيقاف وضع الحماية.');
  }
});

reg('autoreply', {
  category: 'الحماية',
  desc: 'إدارة الردود الآلية',
  usage: '/autoreply كلمة => الرد',
  aliases: ['رد_الي'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    if (!ctx.argsStr) {
      const keys = Object.keys(u.settings.autoReplies || {});
      return ctx.reply(
        `🤖 <b>الردود الآلية (${keys.length})</b>\n` +
          (keys.length ? keys.map((k) => `• <code>${escapeHtml(k)}</code> → ${escapeHtml(u.settings.autoReplies[k])}`).join('\n') : 'لا توجد ردود.') +
          `\n\n➕ للإضافة: <code>/autoreply مرحبا => أهلاً بك</code>`
      );
    }
    const m = ctx.argsStr.match(/^(.+?)\s*=>\s*(.+)$/s);
    if (!m) return ctx.reply('✍️ الصيغة: <code>/autoreply الكلمة => الرد</code>');
    u.settings.autoReplies[m[1].trim()] = m[2].trim();
    u.settings.autoReply = true;
    store.save();
    await ctx.reply(`✅ تمت إضافة رد آلي: <code>${escapeHtml(m[1].trim())}</code>`);
  }
});

reg('delreply', {
  category: 'الحماية',
  desc: 'حذف رد آلي',
  usage: '/delreply كلمة',
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const key = ctx.argsStr.trim();
    if (!key || !u.settings.autoReplies[key]) return ctx.reply('⚠️ لم أجد هذا الرد.');
    delete u.settings.autoReplies[key];
    store.save();
    await ctx.reply(`🗑 تم حذف الرد: <code>${escapeHtml(key)}</code>`);
  }
});

reg('antidelete', {
  category: 'الحماية',
  desc: 'تشغيل/إيقاف التقاط الرسائل المحذوفة',
  aliases: ['مكافحة_الحذف'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.antiDelete;
    store.updateSettings(ctx.tgId, { antiDelete: v });
    await ctx.reply(v ? '🛡 سيتم التقاط الرسائل المحذوفة وإعادة إرسالها لك.' : '⚪ تم إيقاف مكافحة الحذف.');
  }
});

/* ---- حمايات الرقم المربوط (تُرسل التقارير في محادثة الرقم المربوط) ---- */
const guardToggle = (name, key, desc, onMsg, offMsg, aliases = []) =>
  reg(name, {
    category: 'الحماية',
    desc,
    aliases,
    handler: async (ctx) => {
      const u = store.getUser(ctx.tgId);
      let v;
      if (/^(on|تشغيل|تفعيل|1)$/i.test(ctx.argsStr)) v = true;
      else if (/^(off|ايقاف|إيقاف|0)$/i.test(ctx.argsStr)) v = false;
      else v = !u.settings[key];
      store.updateSettings(ctx.tgId, { [key]: v });
      await ctx.reply(v ? onMsg : offMsg);
    }
  });

guardToggle(
  'delguard',
  'delGuardMsgs',
  'تشغيل/إيقاف التقاط حذف الرسائل لدى الجميع',
  '🛡 <b>تم تشغيل مراقبة حذف الرسائل لدى الجميع</b>\nأي شخص يحذف رسالته (نص/صورة/فيديو/صوت/ملصق/ملف) سترسل الرسالة كاملة مع معلومات صاحبها ورقمه الفعلي في محادثة الرقم المربوط.',
  '⚪ تم إيقاف مراقبة حذف الرسائل لدى الجميع.',
  ['حذف_الرسائل', 'امسح_رسائل', 'delguard']
);

guardToggle(
  'statusguard',
  'delGuardStatus',
  'تشغيل/إيقاف عدم حذف حالات الواتس',
  '📵 <b>تم تشغيل مراقبة حذف الحالات</b>\nأي شخص يحذف حالته (نص/صورة/فيديو) سترسل الحالة كاملة مع معلومات صاحبها ورقمه الفعلي في محادثة الرقم المربوط.',
  '⚪ تم إيقاف مراقبة حذف الحالات.',
  ['حذف_الحالات', 'عدم_حذف_الحالات', 'statusguard']
);

guardToggle(
  'viewonce',
  'revealViewOnce',
  'تشغيل/إيقاف كشف رسائل العرض لمرة واحدة',
  '👁 <b>تم تشغيل كشف العرض لمرة واحدة</b>\nأي صورة/فيديو تُرسل بوضع «عرض مره واحده» ستُكشف وترسل كاملة مع معلومات المُرسل ورقمه الفعلي في محادثة الرقم المربوط.',
  '⚪ تم إيقاف كشف العرض لمرة واحدة.',
  ['كشف_الرسائل', 'عرض_مره_واحده', 'viewonce']
);

/* ==========================================================
 *  5) المجموعات
 * ========================================================== */
reg('groups', {
  category: 'المجموعات',
  desc: 'قائمة مجموعات الرقم المربوط',
  aliases: ['مجموعاتي', 'المجموعات'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const all = await s.groupFetchAllParticipating();
    const list = Object.values(all || {});
    if (!list.length) return ctx.reply('ℹ️ لا توجد مجموعات.');
    const txt = list
      .slice(0, 50)
      .map((g, i) => `${i + 1}. <b>${escapeHtml(g.subject)}</b>\n   👥 ${g.participants?.length || 0} | <code>${g.id}</code>`)
      .join('\n');
    await ctx.reply(`👥 <b>مجموعاتك (${list.length})</b>\n━━━━━━━━━━━━━━━\n${txt}`);
  }
});

reg('groupinfo', {
  category: 'المجموعات',
  desc: 'معلومات مجموعة',
  usage: '/groupinfo <jid>',
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || (ctx.isGroup ? ctx.jid : null);
    if (!jid) return ctx.reply('📋 اكتب آيدي المجموعة بعد الأمر.');
    const g = await s.groupMetadata(jid);
    const admins = g.participants.filter((p) => p.admin).length;
    await ctx.reply(
      `📋 <b>${escapeHtml(g.subject)}</b>\n` +
        `🆔 <code>${g.id}</code>\n` +
        `👥 الأعضاء: ${g.participants.length}\n` +
        `🛡 المشرفون: ${admins}\n` +
        `📝 الوصف: ${escapeHtml((g.desc || '—').slice(0, 200))}\n` +
        `📅 الإنشاء: ${g.creation ? new Date(g.creation * 1000).toLocaleDateString('ar-EG') : '—'}`
    );
  }
});

reg('grouplink', {
  category: 'المجموعات',
  desc: 'جلب رابط دعوة المجموعة',
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || (ctx.isGroup ? ctx.jid : null);
    if (!jid) return ctx.reply('📋 حدد المجموعة.');
    const code = await s.groupInviteCode(jid);
    await ctx.reply(`🔗 https://chat.whatsapp.com/${code}`);
  }
});

reg('revoke', {
  category: 'المجموعات',
  desc: 'إعادة تعيين رابط دعوة المجموعة',
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || (ctx.isGroup ? ctx.jid : null);
    if (!jid) return ctx.reply('📋 حدد المجموعة.');
    await s.groupRevokeInvite(jid);
    await ctx.reply('♻️ تم إعادة تعيين رابط الدعوة.');
  }
});

reg('kick', {
  category: 'المجموعات',
  desc: 'طرد عضو من المجموعة',
  usage: '/kick 9665xxxxxxxx',
  aliases: ['طرد'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    await s.groupParticipantsUpdate(ctx.jid, [`${cleanPhone(ctx.args[0])}@s.whatsapp.net`], 'remove');
    await ctx.reply('👢 تم الطرد.');
  }
});

reg('add', {
  category: 'المجموعات',
  desc: 'إضافة عضو للمجموعة',
  usage: '/add 9665xxxxxxxx',
  aliases: ['اضف'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    const res = await s.groupParticipantsUpdate(ctx.jid, [`${cleanPhone(ctx.args[0])}@s.whatsapp.net`], 'add');
    await ctx.reply(`➕ النتيجة: ${res?.[0]?.status || 'تم'}`);
  }
});

reg('promote', {
  category: 'المجموعات',
  desc: 'ترقية عضو إلى مشرف',
  usage: '/promote 9665xxxxxxxx',
  aliases: ['ترقية'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    await s.groupParticipantsUpdate(ctx.jid, [`${cleanPhone(ctx.args[0])}@s.whatsapp.net`], 'promote');
    await ctx.reply('⬆️ تمت الترقية إلى مشرف.');
  }
});

reg('demote', {
  category: 'المجموعات',
  desc: 'إلغاء إشراف عضو',
  usage: '/demote 9665xxxxxxxx',
  aliases: ['تنزيل'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('📱 اكتب الرقم بعد الأمر.');
    await s.groupParticipantsUpdate(ctx.jid, [`${cleanPhone(ctx.args[0])}@s.whatsapp.net`], 'demote');
    await ctx.reply('⬇️ تم إلغاء الإشراف.');
  }
});

reg('lock', {
  category: 'المجموعات',
  desc: 'قفل المجموعة (المشرفون فقط)',
  aliases: ['قفل'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || ctx.jid;
    await s.groupSettingUpdate(jid, 'announcement');
    await ctx.reply('🔒 تم قفل المجموعة.');
  }
});

reg('unlock', {
  category: 'المجموعات',
  desc: 'فتح المجموعة للجميع',
  aliases: ['فتح'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || ctx.jid;
    await s.groupSettingUpdate(jid, 'not_announcement');
    await ctx.reply('🔓 تم فتح المجموعة.');
  }
});

reg('mute', {
  category: 'المجموعات',
  desc: 'قفل المحادثة (المشرفون فقط للكتابة)',
  handler: async (ctx) => {
    await sockOf(ctx).groupSettingUpdate(ctx.args[0] || ctx.jid, 'announcement');
    await ctx.reply('🔇 تم كتم المجموعة.');
  }
});

reg('unmute', {
  category: 'المجموعات',
  desc: 'فتح المحادثة للجميع',
  handler: async (ctx) => {
    await sockOf(ctx).groupSettingUpdate(ctx.args[0] || ctx.jid, 'not_announcement');
    await ctx.reply('🔊 تم فتح المجموعة.');
  }
});

reg('setdesc', {
  category: 'المجموعات',
  desc: 'تغيير وصف المجموعة',
  usage: '/setdesc الوصف',
  handler: async (ctx) => {
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب الوصف.');
    await sockOf(ctx).groupUpdateDescription(ctx.args[0]?.includes('@g.us') ? ctx.args[0] : ctx.jid, ctx.argsStr);
    await ctx.reply('📝 تم تحديث الوصف.');
  }
});

reg('setsubject', {
  category: 'المجموعات',
  desc: 'تغيير اسم المجموعة',
  usage: '/setsubject الاسم',
  handler: async (ctx) => {
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب الاسم.');
    await sockOf(ctx).groupUpdateSubject(ctx.args[0]?.includes('@g.us') ? ctx.args[0] : ctx.jid, ctx.argsStr);
    await ctx.reply('✏️ تم تحديث اسم المجموعة.');
  }
});

reg('leave', {
  category: 'المجموعات',
  desc: 'مغادرة مجموعة',
  aliases: ['مغادرة'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const jid = ctx.args[0] || ctx.jid;
    await s.groupLeave(jid);
    await ctx.reply('🚪 تمت المغادرة.');
  }
});

reg('join', {
  category: 'المجموعات',
  desc: 'الانضمام لمجموعة عبر رابط',
  usage: '/join https://chat.whatsapp.com/xxxx',
  aliases: ['انضمام'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const link = ctx.args[0] || '';
    const code = link.split('/').pop();
    if (!code) return ctx.reply('🔗 أرسل رابط الدعوة.');
    const jid = await s.groupAcceptInvite(code);
    await ctx.reply(`✅ تم الانضمام: <code>${jid}</code>`);
  }
});

reg('tagall', {
  category: 'المجموعات',
  desc: 'منشن كل الأعضاء',
  aliases: ['منشن_الكل'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const g = await s.groupMetadata(ctx.jid);
    const mentions = g.participants.map((p) => p.id);
    const text = (ctx.argsStr || '📢 تنبيه للجميع') + '\n\n' + mentions.map((m) => `@${jidToNumber(m)}`).join(' ');
    await ctx.reply(text, { mentions });
  }
});

reg('tagadmins', {
  category: 'المجموعات',
  desc: 'منشن المشرفين فقط',
  handler: async (ctx) => {
    const s = sockOf(ctx);
    const g = await s.groupMetadata(ctx.jid);
    const admins = g.participants.filter((p) => p.admin).map((p) => p.id);
    await ctx.reply(
      (ctx.argsStr || '📢 تنبيه للمشرفين') + '\n\n' + admins.map((m) => `@${jidToNumber(m)}`).join(' '),
      { mentions: admins }
    );
  }
});

reg('poll', {
  category: 'المجموعات',
  desc: 'إنشاء تصويت',
  usage: '/poll سؤال | خيار1 | خيار2',
  handler: async (ctx) => {
    const parts = ctx.argsStr.split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) return ctx.reply('📊 الصيغة: <code>/poll سؤال | خيار1 | خيار2</code>');
    await sockOf(ctx).sendMessage(ctx.jid, {
      poll: { name: parts[0], values: parts.slice(1, 13), selectableCount: 1 }
    });
  }
});

/* ==========================================================
 *  6) الإرسال والوسائط
 * ========================================================== */
reg('send', {
  category: 'الإرسال',
  desc: 'إرسال رسالة نصية',
  usage: '/send 9665xxxxxxxx نص الرسالة',
  aliases: ['ارسال'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (ctx.args.length < 2) return ctx.reply('✍️ الصيغة: <code>/send 9665xxxxxxxx النص</code>');
    const to = `${cleanPhone(ctx.args[0])}@s.whatsapp.net`;
    await s.sendMessage(to, { text: ctx.args.slice(1).join(' ') });
    await ctx.reply('📤 تم الإرسال.');
  }
});

reg('sendgroup', {
  category: 'الإرسال',
  desc: 'إرسال رسالة لمجموعة',
  usage: '/sendgroup <jid> النص',
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (ctx.args.length < 2) return ctx.reply('✍️ الصيغة: <code>/sendgroup 123@g.us النص</code>');
    await s.sendMessage(ctx.args[0], { text: ctx.args.slice(1).join(' ') });
    await ctx.reply('📤 تم الإرسال للمجموعة.');
  }
});

reg('broadcast', {
  category: 'الإرسال',
  desc: 'إرسال رسالة لكل جهات الاتصال',
  usage: '/broadcast النص',
  aliases: ['اذاعة'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.argsStr) return ctx.reply('✍️ اكتب نص الرسالة.');
    const contacts = (await s.store?.contacts || {});
    const jids = Object.keys(contacts).filter((j) => j.endsWith('@s.whatsapp.net'));
    if (!jids.length) return ctx.reply('ℹ️ لا توجد جهات اتصال محمّلة.');
    await ctx.reply(`📢 جاري الإرسال إلى ${jids.length} جهة اتصال...`);
    let ok = 0;
    for (const jid of jids) {
      try {
        await s.sendMessage(jid, { text: ctx.argsStr });
        ok++;
        await new Promise((r) => setTimeout(r, randInt(1200, 3000)));
      } catch {
        /* ignore */
      }
    }
    await ctx.reply(`✅ تم الإرسال إلى ${ok}/${jids.length}.`);
  }
});

reg('sticker', {
  category: 'الوسائط',
  desc: 'تحويل صورة/فيديو إلى ملصق واتساب',
  waOnly: true,
  aliases: ['ملصق'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.media) return ctx.reply('🖼 أرسل صورة/فيديو مع الأمر.');
    const buf = await ctx.download();
    const isVid = /video/.test(ctx.media.mimetype || '');
    await s.sendMessage(ctx.jid, { sticker: buf, ...(isVid ? { video: buf } : {}) }, { quoted: ctx.raw });
  }
});

reg('toimg', {
  category: 'الوسائط',
  desc: 'تحويل ملصق إلى صورة',
  waOnly: true,
  handler: async (ctx) => {
    if (!ctx.media) return ctx.reply('🖼 أرسل ملصقاً مع الأمر.');
    const buf = await ctx.download();
    await sockOf(ctx).sendMessage(ctx.jid, { image: buf, caption: '🖼 تم التحويل' }, { quoted: ctx.raw });
  }
});

/* ==========================================================
 *  7) التحميل من المنصات
 * ========================================================== */
const makeDownloader = (label) => async (ctx) => {
  const s = sockOf(ctx);
  const url = ctx.args[0];
  if (!url) return ctx.reply(`🔗 أرسل رابط ${label} بعد الأمر.`);
  const quality = ctx.args[1] || '720';
  await ctx.reply(`⏳ جاري التحميل من ${label}...`);
  const res = await dl.download(url, { quality });
  try {
    await s.sendMessage(
      ctx.jid,
      { video: { url: res.file }, caption: `🎬 ${res.platform}\n📦 ${fmtBytes(res.size)}` },
      { quoted: ctx.raw }
    );
  } finally {
    dl.cleanup(res.dir);
  }
};

reg('yt', { category: 'التحميل', desc: 'تحميل فيديو يوتيوب', usage: '/yt <رابط> [الجودة]', aliases: ['يوتيوب', 'youtube'], handler: makeDownloader('يوتيوب') });
reg('tiktok', { category: 'التحميل', desc: 'تحميل فيديو تيك توك بدون علامة مائية', aliases: ['تيك_توك', 'tt'], handler: makeDownloader('تيك توك') });
reg('instagram', { category: 'التحميل', desc: 'تحميل ريلز/فيديو إنستجرام', aliases: ['انستا', 'ig'], handler: makeDownloader('إنستجرام') });
reg('facebook', { category: 'التحميل', desc: 'تحميل فيديو فيسبوك', aliases: ['فيسبوك', 'fb'], handler: makeDownloader('فيسبوك') });
reg('twitter', { category: 'التحميل', desc: 'تحميل فيديو تويتر/X', aliases: ['تويتر', 'x'], handler: makeDownloader('تويتر') });
reg('reddit', { category: 'التحميل', desc: 'تحميل فيديو ريديت', aliases: ['ريديت'], handler: makeDownloader('ريديت') });
reg('pinterest', { category: 'التحميل', desc: 'تحميل من بينترست', aliases: ['بينترست'], handler: makeDownloader('بينترست') });
reg('snapchat', { category: 'التحميل', desc: 'تحميل من سنابشات', aliases: ['سناب'], handler: makeDownloader('سنابشات') });
reg('vimeo', { category: 'التحميل', desc: 'تحميل من فيميو', aliases: ['فيميو'], handler: makeDownloader('فيميو') });
reg('dailymotion', { category: 'التحميل', desc: 'تحميل من ديلي موشن', aliases: ['ديلي_موشن'], handler: makeDownloader('ديلي موشن') });
reg('twitch', { category: 'التحميل', desc: 'تحميل مقطع تويتش', aliases: ['تويتش'], handler: makeDownloader('تويتش') });
reg('linkedin', { category: 'التحميل', desc: 'تحميل فيديو لينكدإن', aliases: ['لينكد_ان'], handler: makeDownloader('لينكدإن') });
reg('threads', { category: 'التحميل', desc: 'تحميل من ثريدز', aliases: ['ثريدز'], handler: makeDownloader('ثريدز') });

reg('mp3', {
  category: 'التحميل',
  desc: 'تحميل الصوت فقط MP3',
  usage: '/mp3 <رابط>',
  aliases: ['صوت', 'audio', 'اغنية'],
  handler: async (ctx) => {
    const s = sockOf(ctx);
    if (!ctx.args[0]) return ctx.reply('🔗 أرسل الرابط بعد الأمر.');
    await ctx.reply('⏳ جاري تحميل الصوت...');
    const res = await dl.download(ctx.args[0], { audio: true });
    try {
      await s.sendMessage(
        ctx.jid,
        { audio: { url: res.file }, mimetype: 'audio/mpeg', fileName: res.title },
        { quoted: ctx.raw }
      );
    } finally {
      dl.cleanup(res.dir);
    }
  }
});

reg('dlinfo', {
  category: 'التحميل',
  desc: 'معلومات رابط بدون تحميل',
  usage: '/dlinfo <رابط>',
  aliases: ['رابط'],
  handler: async (ctx) => {
    if (!ctx.args[0]) return ctx.reply('🔗 أرسل الرابط بعد الأمر.');
    const i = await dl.info(ctx.args[0]);
    await ctx.reply(
      `ℹ️ <b>معلومات الرابط</b>\n` +
        `🎬 العنوان: ${escapeHtml(i.title || '—')}\n` +
        `📺 المنصة: ${i.platform}\n` +
        `⏱ المدة: ${i.duration ? `${Math.floor(i.duration / 60)}:${String(i.duration % 60).padStart(2, '0')}` : '—'}\n` +
        `👤 الناشر: ${escapeHtml(i.uploader || '—')}\n` +
        `👁 المشاهدات: ${(i.views || 0).toLocaleString('ar-EG')}`
    );
  }
});

reg('platforms', {
  category: 'التحميل',
  desc: 'قائمة المنصات المدعومة',
  aliases: ['المنصات'],
  handler: async (ctx) => {
    await ctx.reply(
      `📥 <b>المنصات المدعومة (${dl.PLATFORMS.length})</b>\n` +
        dl.PLATFORMS.map((p) => `• ${p.name}`).join('\n') +
        `\n\n🔧 المحرك: yt-dlp\n${(await dl.ytdlpAvailable()) ? '✅ متاح' : '❌ غير مثبت — نفّذ: pip install -U yt-dlp'}`
    );
  }
});

/* ==========================================================
 *  8) الأوامر الإدارية (للمالك فقط)
 * ========================================================== */
reg('allstats', {
  category: 'الإدارة',
  desc: 'إحصائيات كل المستخدمين (للمطور)',
  aliases: ['الاحصائيات_العامة'],
  guard: true,
  handler: async (ctx) => {
    const g = globalStats();
    const users = store.all();
    const rows = users
      .sort((a, b) => (b.stats.reacted || 0) - (a.stats.reacted || 0))
      .slice(0, 20)
      .map((u, i) => `${i + 1}. <code>${u.id}</code> — 👀${u.stats.viewed} ❤️${u.stats.reacted} ${u.connected ? '🟢' : '⚪'}`)
      .join('\n');
    await ctx.reply(
      `🌐 <b>إحصائيات عامة</b>\n` +
        `👥 المستخدمون: ${g.users}\n` +
        `🔢 الجلسات: ${g.connected}/${g.max}\n` +
        `🧠 Heap: ${g.heapMB}MB | RSS: ${g.rssMB}MB\n` +
        `⏳ التشغيل: ${fmtUptime(g.uptime)}\n` +
        `━━━━━━━━━━━━━━━\n${rows || '—'}`
    );
  }
});

reg('sessions', {
  category: 'الإدارة',
  desc: 'قائمة الجلسات النشطة (للمطور)',
  aliases: ['الجلسات'],
  guard: true,
  handler: async (ctx) => {
    if (!sessions.size) return ctx.reply('ℹ️ لا توجد جلسات نشطة.');
    const rows = [...sessions.values()].map(
      (s) => `• <code>${s.tgId}</code> — ${s.phone || '—'} — ${s.status} (${fmtUptime(Date.now() - s.startedAt)})`
    );
    await ctx.reply(`🔢 <b>الجلسات النشطة (${sessions.size})</b>\n${rows.join('\n')}`);
  }
});

reg('kill', {
  category: 'الإدارة',
  desc: 'فصل جلسة مستخدم (للمطور)',
  usage: '/kill <tgId>',
  guard: true,
  handler: async (ctx) => {
    if (!ctx.args[0]) return ctx.reply('🆔 اكتب آيدي المستخدم.');
    await stopSession(ctx.args[0], { logout: true });
    await ctx.reply(`✅ تم فصل الجلسة <code>${ctx.args[0]}</code>.`);
  }
});

reg('backup', {
  category: 'الإدارة',
  desc: 'نسخة احتياطية من قاعدة البيانات',
  handler: async (ctx) => {
    const json = JSON.stringify(store.raw(), null, 2);
    await ctx.replyDoc(Buffer.from(json, 'utf8'), `backup-${Date.now()}.json`);
  }
});

reg('userinfo', {
  category: 'الإدارة',
  desc: 'تفاصيل مستخدم (للمطور)',
  usage: '/userinfo <tgId>',
  guard: true,
  handler: async (ctx) => {
    const id = ctx.args[0] || ctx.tgId;
    const u = store.getUser(id);
    await ctx.reply(
      `👤 <b>مستخدم ${id}</b>\n` +
        `📱 الرقم: <code>${u.phone || '—'}</code>\n` +
        `🟢 متصل: ${u.connected ? 'نعم' : 'لا'}\n` +
        `😀 الإيموجيات: ${u.settings.emojis.join(' ')}\n` +
        `👀 مشاهدة: ${u.stats.viewed} | ❤️ تفاعل: ${u.stats.reacted}\n` +
        `📅 الإنشاء: ${new Date(u.createdAt).toLocaleString('ar-EG')}`
    );
  }
});

/* ==========================================================
 *  9) أوامر المطور (/admin) والأوامر المميزة
 * ========================================================== */
import { regAdminCommands } from './admin.js';
regAdminCommands({ reg, need, sockOf, isDeveloper, escapeHtml });

/* ==========================================================
 *  10) تسجيل الأوامر الإضافية (300+)
 * ========================================================== */
for (const [name, def] of extras) reg(name, def);

/* ==========================================================
 *  10.5) أوامر الرقم المربوط (تعمل داخل واتساب وتيليجرام)
 *  - .الاوامر : عرض كل الأوامر المتاحة داخل الرقم المربوط
 *  - .الحذف   : تشغيل/إيقاف كشف حذف الرسائل «لدى الجميع»
 *  - .الحالات : تشغيل/إيقاف «عدم حذف حالات الواتساب»
 *  - .كشف     : تشغيل/إيقاف كشف «العرض لمرة واحدة»
 * ========================================================== */
const waOnOff = (v) => (v ? '✅ مُفعّل' : '❌ متوقف');

reg('menulive', {
  category: 'الرقم المربوط',
  desc: 'عرض جميع أوامر الرقم المربوط داخل واتساب',
  aliases: ['الاوامر', 'الأوامر', 'اوامر_الرقم', 'الاوامر_المربوط'],
  handler: async (ctx) => {
    const byCat = new Map();
    for (const c of registry.values()) {
      if (c.devOnly) continue;
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category).push(c);
    }
    let out = '*📜 أوامر الرقم المربوط*\n━━━━━━━━━━━━━━━\n';
    for (const [cat, list] of byCat) {
      out += `\n◆ *${cat}* (${list.length})\n`;
      out += list.map((c) => `.${c.name}${c.desc ? ' — ' + c.desc : ''}`).join('\n');
      out += '\n';
    }
    out += '\n━━━━━━━━━━━━━━━\n💡 يعمل الأمر بكل البادئات: . / ! #';
    const { chunkText } = await import('./utils.js');
    for (const part of chunkText(out, 3500)) {
      await ctx.reply(part);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

reg('wadelete', {
  category: 'الرقم المربوط',
  desc: 'تشغيل/إيقاف كشف حذف الرسائل لدى الجميع',
  usage: '.الحذف',
  aliases: ['الحذف', 'حذف_الرسائل', 'كشف_الحذف', 'wadelete'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.waAntiDelete;
    store.updateSettings(ctx.tgId, { waAntiDelete: v });
    await ctx.reply(
      v
        ? '🛡 *تم تشغيل كشف حذف الرسائل لدى الجميع*\n\nأي شخص يحذف رسالة سيتم إرسال معلومات الرسالة كاملة (نص، صور، فيديو) مع معلومات صاحبها ورقمه الفعلي إلى محادثة الرقم المربوط.'
        : '⚪ *تم إيقاف كشف حذف الرسائل.*'
    );
  }
});

reg('wastatussave', {
  category: 'الرقم المربوط',
  desc: 'تشغيل/إيقاف عدم حذف حالات الواتساب',
  usage: '.الحالات',
  aliases: ['الحالات', 'حالات_الواتس', 'حماية_الحالات', 'wastatussave'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.statusAntiDelete;
    store.updateSettings(ctx.tgId, { statusAntiDelete: v });
    await ctx.reply(
      v
        ? '📸 *تم تشغيل «عدم حذف حالات الواتساب»*\n\nأي شخص يحذف حالته (نص/صورة/فيديو) سيتم إرسالها كاملة مع معلومات صاحبها ورقمه الفعلي إلى محادثة الرقم المربوط.'
        : '⚪ *تم إيقاف حماية الحالات.*'
    );
  }
});

reg('viewonce', {
  category: 'الرقم المربوط',
  desc: 'تشغيل/إيقاف كشف الرسائل «للعرض لمرة واحدة»',
  usage: '.كشف',
  aliases: ['كشف', 'عرض_لمره_واحده', 'كشف_العرض', 'viewonce'],
  handler: async (ctx) => {
    const u = store.getUser(ctx.tgId);
    const v = !u.settings.viewOnceReveal;
    store.updateSettings(ctx.tgId, { viewOnceReveal: v });
    await ctx.reply(
      v
        ? '👁 *تم تشغيل كشف «العرض لمرة واحدة»*\n\nأي شخص يرسل صورة أو فيديو للعرض لمرة واحدة سيتم كشفها وإرسالها إلى محادثة الرقم المربوط مع معلومات المرسل ورقمه الفعلي.'
        : '⚪ *تم إيقاف كشف «العرض لمرة واحدة».*'
    );
  }
});

/* ==========================================================
 *  11) المحرك
 * ========================================================== */
const PREFIXES = ['/', '.', '!', '#'];

export function resolve(name) {
  const n = String(name).toLowerCase();
  if (registry.has(n)) return registry.get(n);
  if (aliasMap.has(n)) return registry.get(aliasMap.get(n));
  return null;
}

/**
 * تنفيذ أمر من نص
 * @returns {Promise<boolean>} true لو تم التعرف على الأمر
 */
export async function runCommand(ctx) {
  const raw = String(ctx.text || '').trim();
  if (!raw || !PREFIXES.includes(raw[0])) return false;

  const m = raw.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return false;

  const cmd = resolve(m[1]);
  if (!cmd) return false;

  if (isMaintenanceOn() && !isDeveloper({ tgId: ctx.tgId })) {
    await ctx.reply('🛠 <b>البوت في وضع الصيانة حالياً</b>\nحاول مرة أخرى لاحقاً.').catch(() => {});
    return true;
  }
  if (cmd.guard && !isDeveloper({ tgId: ctx.tgId })) {
    await ctx.reply('👑 <b>هذا الأمر خاص بمطور البوت فقط.</b>').catch(() => {});
    return true;
  }

  const argsStr = (m[2] || '').trim();
  const full = { ...ctx, args: argsStr ? argsStr.split(/\s+/).filter(Boolean) : [], argsStr, name: cmd.name };

  try {
    await cmd.handler(full);
  } catch (e) {
    const em = /message is too long/i.test(e?.description || e?.message || '') ? 'الرسالة أطول من الحد المسموح — تم تقطيعها تلقائياً، أعد المحاولة.' : e.message;
    await ctx.reply(`❌ خطأ في تنفيذ <code>${cmd.name}</code>: ${escapeHtml(em)}`).catch(() => {});
    store.bump(ctx.tgId, 'errors');
  }
  return true;
}

export const countCommands = () => registry.size + aliasMap.size;
export const countDistinct = () => registry.size;

export function listCommands() {
  const byCat = new Map();
  for (const c of registry.values()) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const out = [];
  for (const [cat, list] of byCat) {
    out.push(`\n<b>◆ ${cat} (${list.length})</b>`);
    out.push(list.map((c) => `<code>/${c.name}</code>${c.desc ? ' — ' + escapeHtml(c.desc) : ''}${c.devOnly ? ' 👑' : ''}`).join('\n'));
  }
  return out.join('\n');
}

/**
 * ربط محرك الأوامر برسائل واتساب الواردة
 */
export function attachWaCommands(sock, tgId, notify = () => {}) {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages || []) {
      try {
        if (!m.message) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast') continue;
        if (jid.endsWith('@newsletter')) continue;

        const body =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          '';
        if (!body || !PREFIXES.includes(body.trim()[0])) continue;

        const isGroup = jid.endsWith('@g.us');
        const from = jidToNumber(m.key.participant || m.key.remoteJid);
        const u = store.getUser(tgId);

        if (u.settings.protection) {
          if (u.settings.blocked.includes(`${from}@s.whatsapp.net`)) continue;
          if (isGroup && /@g\.us$/.test(jid) && !/^[./!]/.test(body)) continue;
        }

        let isAdmin = false;
        if (isGroup) {
          try {
            const g = await sock.groupMetadata(jid);
            const p = g.participants.find((x) => jidToNumber(x.id) === from);
            isAdmin = !!p?.admin;
          } catch {
            /* ignore */
          }
        }

        const mediaMsg =
          m.message.imageMessage || m.message.videoMessage || m.message.stickerMessage || m.message.documentMessage || null;

        const ctx = {
          tgId,
          sock,
          jid,
          raw: m,
          from,
          isGroup,
          isAdmin,
          pushName: m.pushName || '',
          text: body.trim(),
          media: mediaMsg,
          download: async () => {
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            return downloadMediaMessage(m, 'buffer', {}, { logger: undefined, reuploadRequest: sock.updateMediaMessage });
          },
          reply: async (text, opts = {}) => sock.sendMessage(jid, { text: String(text), ...opts }, { quoted: m }),
          replyDoc: async (buf, name) =>
            sock.sendMessage(jid, { document: buf, fileName: name, mimetype: 'application/octet-stream' }, { quoted: m })
        };

        const handled = await runCommand(ctx);
        if (handled) notify(tgId, `⚡ نُفّذ أمر واتساب: <code>${body.trim().slice(0, 40)}</code>`);
      } catch (e) {
        console.error(`[cmd:wa] ${e.message}`);
      }
    }
  });
}

export { md5 };

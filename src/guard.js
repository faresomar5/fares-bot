/**
 * guard.js — وحدة الحماية والكشف للرقم المربوط
 *
 * 1) كشف حذف الرسائل «لدى الجميع» — عند حذف أي شخص لرسالته يتم إرسال
 *    معلومات الرسالة كاملة (نص + وسائط/صور/فيديو) مع معلومات صاحب الرسالة
 *    ورقمه الفعلي الصحيح إلى محادثة الرقم المربوط في تيليجرام.
 * 2) حماية حالات الواتساب — عند حذف أي شخص لحالته (نص/صورة/فيديو)
 *    تُرسل الحالة كاملة مع معلومات صاحبها ورقمه الفعلي.
 * 3) كشف «العرض لمرة واحدة» — أي صورة/فيديو مرسلة بوضع view-once
 *    تُكشف وتُرسل كاملة مع معلومات المرسل ورقمه الفعلي.
 *
 * كل المفاتيح تُتحكم بها بأوامر داخل الرقم المربوط (.الحذف، .الحالات، .كشف)
 * أو من تيليجرام، والإعدادات محفوظة في قاعدة البيانات ولا تُحذف بإعادة التشغيل.
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { store } from './store.js';
import { jidToNumber, escapeHtml } from './utils.js';

const CACHE_TTL = 60 * 60 * 1000; // ساعة واحدة
const MAX_CACHE = 600; // حد أقصى للرسائل المخزنة لكل جلسة

/** ذاكرة الرسائل الأخيرة: Map<tgId, Map<msgId, {m, buf, mime, kind, ts}>> */
const msgCache = new Map();
/** ذاكرة الحالات: Map<tgId, Map<statusId, {m, buf, mime, kind, ts}>> */
const statusCache = new Map();

/* تنظيف دوري للذاكرة المؤقتة */
setInterval(() => {
  const now = Date.now();
  for (const map of [msgCache, statusCache]) {
    for (const [, mm] of map) {
      for (const [id, e] of mm) if (now - e.ts > CACHE_TTL) mm.delete(id);
    }
  }
}, 5 * 60 * 1000).unref?.();

const cacheFor = (map, tgId) => {
  const k = String(tgId);
  if (!map.has(k)) map.set(k, new Map());
  const mm = map.get(k);
  if (mm.size >= MAX_CACHE) {
    // إزالة الأقدم أولاً
    let oldest = null;
    for (const [id, e] of mm) if (!oldest || e.ts < oldest[1].ts) oldest = [id, e];
    if (oldest) mm.delete(oldest[0]);
  }
  return mm;
};

/**
 * الرقم الفعلي الصحيح للمرسل — يتعامل مع أنظمة LID الحديثة في واتساب
 * ويعيد الرقم الدولي الكامل بدون رموز (مثال: 966501234567)
 */
export function realNumber(m) {
  const k = m?.key || {};
  const p = k.participant || k.remoteJid || '';
  let n = jidToNumber(p);
  if ((/@lid$/i.test(p) || !/^\d{6,}$/.test(n)) && k.participantAlt) {
    const alt = jidToNumber(k.participantAlt);
    if (/^\d{6,}$/.test(alt)) return alt;
  }
  if (!/^\d{6,}$/.test(n) && k.remoteJidAlt) {
    const alt = jidToNumber(k.remoteJidAlt);
    if (/^\d{6,}$/.test(alt)) return alt;
  }
  return n;
}

const senderName = (m) => String(m?.pushName || m?.verifiedBizName || '').trim() || 'غير معروف';

const chatLabel = (jid) => {
  if (!jid) return 'غير معروفة';
  if (jid === 'status@broadcast') return 'حالة واتساب 📱';
  if (jid.endsWith('@g.us')) return `مجموعة 👥 (<code>${jid}</code>)`;
  if (jid.endsWith('@newsletter')) return 'قناة 📢';
  return `محادثة خاصة 💬 (<code>+${jidToNumber(jid)}</code>)`;
};

/** فك تغليف رسائل viewOnce إلى المحتوى الداخلي */
export const unwrap = (msg) => {
  let m = msg;
  for (let i = 0; i < 3 && m; i++) {
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m || msg || {};
};

const isViewOnceMsg = (message) => {
  if (!message) return false;
  if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) return true;
  const c = unwrap(message);
  return !!(c.imageMessage?.viewOnce || c.videoMessage?.viewOnce || c.audioMessage?.viewOnce);
};

const mediaNodeOf = (msg) => {
  const c = unwrap(msg);
  if (c.imageMessage) return { node: c.imageMessage, kind: 'صورة 🖼', mime: c.imageMessage.mimetype || 'image/jpeg' };
  if (c.videoMessage) return { node: c.videoMessage, kind: 'فيديو 🎬', mime: c.videoMessage.mimetype || 'video/mp4' };
  if (c.audioMessage) return { node: c.audioMessage, kind: 'صوت 🎵', mime: c.audioMessage.mimetype || 'audio/mpeg' };
  if (c.stickerMessage) return { node: c.stickerMessage, kind: 'ملصق 🩹', mime: c.stickerMessage.mimetype || 'image/webp' };
  if (c.documentMessage)
    return {
      node: c.documentMessage,
      kind: `ملف 📄 (${escapeHtml(c.documentMessage.fileName || 'بدون اسم')})`,
      mime: c.documentMessage.mimetype || 'application/octet-stream'
    };
  return null;
};

const msgTextOf = (msg) => {
  const c = unwrap(msg);
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
};

const timeNow = () => new Date().toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });

/** تنزيل وسائط رسالة كـ Buffer (مع فك viewOnce) */
async function dlBuffer(sock, m) {
  const inner = unwrap(m.message);
  return downloadMediaMessage({ key: m.key, message: inner }, 'buffer', {}, {
    logger: undefined,
    reuploadRequest: sock.updateMediaMessage
  });
}

/**
 * ربط وحدة الحماية بسوكيت جلسة
 * @param sock جلسة Baileys
 * @param tgId آيدي تيليجرام الخاص بالجلسة
 * @param hooks {log, notify, notifyMedia}
 */
export function attachGuards(sock, tgId, hooks = {}) {
  const log = hooks.log || (() => {});
  const notify = hooks.notify || (() => {});
  const notifyMedia = hooks.notifyMedia || (async () => {});

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages || []) {
      try {
        await handle(m);
      } catch (e) {
        log(`guard: ${e.message}`);
      }
    }
  });

  async function handle(m) {
    if (!m?.message) return;
    const s = store.getUser(tgId).settings;
    const key = m.key || {};
    const isStatus = key.remoteJid === 'status@broadcast';

    /* ===== 1) أحداث الحذف (بروتوكول REVOKE) ===== */
    const pm = m.message.protocolMessage;
    if (pm && (pm.type === 0 || pm.type === 'REVOKE')) {
      const pk = pm.key || {};
      if (pk.remoteJid === 'status@broadcast') return handleStatusDelete(m, pm, s);
      return handleMessageDelete(m, pm, s);
    }

    if (key.fromMe) return; // رسائلی الصادرة لا تُخزَّن ولا تُكشَف

    /* ===== 2) كشف العرض لمرة واحدة ===== */
    if (s.viewOnceReveal && !isStatus && isViewOnceMsg(m.message)) {
      await revealViewOnce(m);
    }

    /* ===== 3) تخزين الرسائل لاسترجاعها عند الحذف ===== */
    if (s.waAntiDelete && !isStatus) {
      const media = mediaNodeOf(m.message);
      let buf = null;
      if (media) {
        try {
          buf = await dlBuffer(sock, m); // تحميل مسبق حتى تُرسل الوسائط بعد الحذف
        } catch (e) {
          log(`تعذر تحميل وسائط الرسالة مسبقاً: ${e.message}`);
        }
      }
      cacheFor(msgCache, tgId).set(key.id, {
        m: { key: key, pushName: m.pushName, message: m.message },
        buf,
        mime: media?.mime || null,
        kind: media?.kind || null,
        ts: Date.now()
      });
    }

    /* ===== 4) تخزين الحالات لاسترجاعها عند الحذف ===== */
    if (s.statusAntiDelete && isStatus && key.participant) {
      const media = mediaNodeOf(m.message);
      let buf = null;
      if (media) {
        try {
          buf = await dlBuffer(sock, m);
        } catch (e) {
          log(`تعذر تحميل وسائط الحالة مسبقاً: ${e.message}`);
        }
      }
      cacheFor(statusCache, tgId).set(key.id, {
        m: { key: key, pushName: m.pushName, message: m.message },
        buf,
        mime: media?.mime || null,
        kind: media?.kind || null,
        ts: Date.now()
      });
    }
  }

  /* ================= حذف رسالة لدى الجميع ================= */
  async function handleMessageDelete(pmMsg, pm, s) {
    if (!s.waAntiDelete) return;
    const delKey = pm.key || {};
    const id = delKey.id;
    const entry = cacheFor(msgCache, tgId).get(id);
    const actor = realNumber(pmMsg); // من نفّذ الحذف
    const sender = delKey.participant ? realNumber({ key: delKey }) : jidToNumber(delKey.remoteJid || '');
    const chat = delKey.remoteJid || '';
    const deletedAt = pm.timestampMs ? new Date(Number(pm.timestampMs)).toLocaleString('ar-EG') : timeNow();

    let text =
      `🛡 <b>تم حذف رسالة لدى الجميع!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👤 صاحب الرسالة: <b>${escapeHtml(entry?.m?.pushName || senderName(pmMsg))}</b>\n` +
      `📱 رقمه الفعلي: <code>+${sender || 'غير معروف'}</code>\n` +
      `🧹 حذفها: <code>+${actor || 'غير معروف'}</code>\n` +
      `💬 المحادثة: ${chatLabel(chat)}\n` +
      `🕒 وقت الحذف: ${deletedAt}\n` +
      `🆔 معرف الرسالة: <code>${escapeHtml(id || '—')}</code>\n`;

    const origText = entry ? msgTextOf(entry.m.message) : '';
    if (origText) text += `📝 النص الأصلي:\n${origText.slice(0, 1500)}\n`;
    text += `📎 النوع: ${entry?.kind || (origText ? 'نص ✍️' : 'غير معروف (الحذف قبل التخزين أو الميزة كانت متوقفة)')}`;

    if (entry?.buf?.length) {
      await notifyMedia(tgId, entry.buf, entry.mime || 'application/octet-stream', text);
    } else {
      notify(tgId, text);
    }
    cacheFor(msgCache, tgId).delete(id);
  }

  /* ================= حذف حالة واتساب ================= */
  async function handleStatusDelete(pmMsg, pm, s) {
    if (!s.statusAntiDelete) return;
    const delKey = pm.key || {};
    const id = delKey.id;
    const entry = cacheFor(statusCache, tgId).get(id);
    const sender = realNumber({ key: delKey });
    const sender2 = sender && sender !== 'undefined' ? sender : realNumber(pmMsg);

    let text =
      `📸 <b>تم حذف حالة واتساب!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👤 صاحب الحالة: <b>${escapeHtml(entry?.m?.pushName || senderName(pmMsg))}</b>\n` +
      `📱 رقمه الفعلي: <code>+${sender2 || 'غير معروف'}</code>\n` +
      `🕒 وقت الحذف: ${timeNow()}\n` +
      `🆔 معرف الحالة: <code>${escapeHtml(id || '—')}</code>\n`;

    const origText = entry ? msgTextOf(entry.m.message) : '';
    if (origText) text += `📝 نص الحالة:\n${origText.slice(0, 1500)}\n`;
    text += `📎 النوع: ${entry?.kind || (origText ? 'نص ✍️' : 'غير معروف')}`;

    if (entry?.buf?.length) {
      await notifyMedia(tgId, entry.buf, entry.mime || 'application/octet-stream', text);
    } else {
      notify(tgId, text);
    }
    cacheFor(statusCache, tgId).delete(id);
  }

  /* ================= كشف العرض لمرة واحدة ================= */
  async function revealViewOnce(m) {
    const media = mediaNodeOf(m.message);
    const from = realNumber(m);
    let text =
      `👁 <b>تم كشف رسالة «العرض لمرة واحدة»!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👤 المرسل: <b>${escapeHtml(senderName(m))}</b>\n` +
      `📱 رقمه الفعلي: <code>+${from || 'غير معروف'}</code>\n` +
      `💬 المحادثة: ${chatLabel(m.key.remoteJid)}\n` +
      `🕒 الوقت: ${timeNow()}\n` +
      `📎 النوع: ${media?.kind || 'نص ✍️'}`;

    const t = msgTextOf(m.message);
    if (t) text += `\n📝 النص: ${t.slice(0, 800)}`;

    if (media) {
      try {
        const buf = await dlBuffer(sock, m);
        if (buf?.length) {
          await notifyMedia(tgId, buf, media.mime || 'application/octet-stream', text);
          return;
        }
      } catch (e) {
        log(`viewOnce: تعذر تنزيل الوسائط — ${e.message}`);
      }
    }
    notify(tgId, text);
  }
}

export { msgCache, statusCache };

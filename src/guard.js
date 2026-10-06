/**
 * guard.js — وحدة الحماية والكشف للرقم المربوط
 *
 * 1) كشف حذف الرسائل «لدى الجميع» — تُرسل الرسالة كاملة (نص + وسائط) مع
 *    معلومات صاحبها ورقمه الفعلي الصحيح (يدعم LID) إلى محادثة الرقم المربوط
 *    داخل واتساب (أو تيليجرام حسب الإعداد) — ولمرة واحدة فقط.
 * 2) حماية حالات الواتساب — عند حذف أي شخص لحالته تُرسل الحالة كاملة.
 * 3) كشف «العرض لمرة واحدة» — تُكشف الصورة/الفيديو وتُرسل كاملة.
 *
 * التحكم من داخل الرقم المربوط: .الحذف  .الحالات  .كشف
 */
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { store } from './store.js';
import { jidToNumber, isPhoneNumber, escapeHtml } from './utils.js';

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
    let oldest = null;
    for (const [id, e] of mm) if (!oldest || e.ts < oldest[1].ts) oldest = [id, e];
    if (oldest) mm.delete(oldest[0]);
  }
  return mm;
};

/* ==========================================================
 *  الرقم الفعلي الصحيح (يدعم LID والأنظمة الجديدة)
 * ========================================================== */
const pickNumber = (...cands) => {
  for (const c of cands) {
    const n = jidToNumber(c);
    if (isPhoneNumber(n)) return n;
  }
  return '';
};

/**
 * استخراج الرقم الفعلي للمرسل من رسالة واتساب.
 * يجرب: participantAlt → remoteJidAlt → senderPn/participantPn → participant → remoteJid
 * ويعيد رقماً دولياً صالحاً (8-15 خانة) أو '' إن تعذّر.
 */
export function realNumber(m) {
  const k = m?.key || {};
  return pickNumber(
    k.participantAlt,
    k.remoteJidAlt,
    m?.senderPn,
    m?.participantPn,
    m?.participant,
    k.participant,
    m?.senderLid && !/@lid$/i.test(String(m.senderLid)) ? m.senderLid : null,
    k.remoteJid
  );
}

/** الرقم الفعلي من مفتاح رسالة (لأحداث الحذف) */
export function realNumberFromKey(k = {}, extra = {}) {
  return pickNumber(k.participantAlt, k.remoteJidAlt, extra.senderPn, extra.participantPn, k.participant, k.remoteJid);
}

/** عرض الرقم بشكل موحّد */
const fmtNum = (n) => (n ? `+${n}` : 'غير معروف');

const senderName = (m) => String(m?.pushName || m?.verifiedBizName || '').trim() || 'غير معروف';

const chatLabel = (jid) => {
  if (!jid) return 'غير معروفة';
  if (jid === 'status@broadcast') return 'حالة واتساب 📱';
  if (jid.endsWith('@g.us')) return `مجموعة 👥`;
  if (jid.endsWith('@newsletter')) return 'قناة 📢';
  return 'محادثة خاصة 💬';
};

/** فك تغليف رسائل viewOnce إلى المحتوى الداخلي */
export const unwrap = (msg) => {
  let m = msg;
  for (let i = 0; i < 3 && m; i++) {
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
    else if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    else break;
  }
  return m || {};
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
      mime: c.documentMessage.mimetype || 'application/octet-stream',
      filename: c.documentMessage.fileName || 'file'
    };
  return null;
};

const msgTextOf = (msg) => {
  const c = unwrap(msg);
  return (
    c.conversation ||
    c.extendedTextMessage?.text ||
    c.imageMessage?.caption ||
    c.videoMessage?.caption ||
    c.documentMessage?.caption ||
    ''
  );
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

/* ==========================================================
 *  ربط وحدة الحماية بسوكيت جلسة
 * ========================================================== */
/**
 * @param sock جلسة Baileys
 * @param tgId آيدي تيليجرام الخاص بالجلسة
 * @param hooks {log, notify, notifyMedia, alert}
 *   alert = { send(key, alertObj, media) } من alerts.js
 */
export function attachGuards(sock, tgId, hooks = {}) {
  const log = hooks.log || (() => {});
  const alert = hooks.alert || { send: async () => false };

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

    if (key.fromMe) return; // رسائلنا الصادرة لا تُخزَّن ولا تُكشَف

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
          buf = await dlBuffer(sock, m);
        } catch (e) {
          log(`تعذر تحميل وسائط الرسالة مسبقاً: ${e.message}`);
        }
      }
      cacheFor(msgCache, tgId).set(key.id, {
        m: { key, pushName: m.pushName, message: m.message, senderPn: m.senderPn, participant: m.participant },
        buf,
        mime: media?.mime || null,
        kind: media?.kind || null,
        filename: media?.filename || null,
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
        m: { key, pushName: m.pushName, message: m.message, participantAlt: key.participantAlt },
        buf,
        mime: media?.mime || null,
        kind: media?.kind || null,
        filename: media?.filename || null,
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

    // صاحب الرسالة: من ذاكرة الرسالة أولاً ثم من مفتاح الحذف
    const sender = entry
      ? realNumberFromKey(entry.m.key, entry.m)
      : realNumberFromKey(delKey);
    const actor = realNumberFromKey(pmMsg.key || {}, pmMsg) || realNumber(pmMsg);

    const text =
      `🛡 *تم حذف رسالة لدى الجميع!*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `👤 صاحب الرسالة: *${entry?.m?.pushName || senderName(pmMsg)}*\n` +
      `📱 رقمه الفعلي: ${fmtNum(sender)}\n` +
      `🧹 حذفها: ${fmtNum(actor)}\n` +
      `💬 النوع: ${chatLabel(delKey.remoteJid)}\n` +
      `🕒 وقت الحذف: ${timeNow()}\n` +
      `📎 المحتوى: ${entry?.kind || (entry && msgTextOf(entry.m.message) ? 'نص ✍️' : 'غير معروف (قبل التخزين)')}`;

    const origText = entry ? msgTextOf(entry.m.message) : '';
    const caption = origText ? `${text}\n\n📝 النص الأصلي:\n${origText.slice(0, 1500)}` : text;

    const media = entry?.buf?.length
      ? { buf: entry.buf, mime: entry.mime || 'application/octet-stream', filename: entry.filename }
      : null;

    await alert.send(
      `del:${tgId}:${id}`,
      {
        title: '🛡 تم حذف رسالة لدى الجميع!',
        fields: [
          { icon: '👤', label: 'صاحب الرسالة', value: entry?.m?.pushName || senderName(pmMsg) },
          { icon: '📱', label: 'رقمه الفعلي', value: fmtNum(sender), code: false },
          { icon: '🧹', label: 'حذفها', value: fmtNum(actor) },
          { icon: '💬', label: 'النوع', value: chatLabel(delKey.remoteJid) },
          { icon: '🕒', label: 'وقت الحذف', value: timeNow() },
          { icon: '📎', label: 'المحتوى', value: entry?.kind || (origText ? 'نص ✍️' : 'غير معروف') }
        ],
        notes: origText ? [`📝 النص الأصلي:`, origText.slice(0, 1500)] : []
      },
      media
    );

    cacheFor(msgCache, tgId).delete(id);
  }

  /* ================= حذف حالة واتساب ================= */
  async function handleStatusDelete(pmMsg, pm, s) {
    if (!s.statusAntiDelete) return;
    const delKey = pm.key || {};
    const id = delKey.id;
    const entry = cacheFor(statusCache, tgId).get(id);

    const sender =
      realNumberFromKey(delKey, pmMsg) ||
      (entry ? realNumberFromKey(entry.m.key, entry.m) : '') ||
      realNumber(pmMsg);

    const origText = entry ? msgTextOf(entry.m.message) : '';
    const media = entry?.buf?.length
      ? { buf: entry.buf, mime: entry.mime || 'application/octet-stream', filename: entry.filename }
      : null;

    await alert.send(
      `status:${tgId}:${id}`,
      {
        title: '📸 تم حذف حالة واتساب!',
        fields: [
          { icon: '👤', label: 'صاحب الحالة', value: entry?.m?.pushName || senderName(pmMsg) },
          { icon: '📱', label: 'رقمه الفعلي', value: fmtNum(sender) },
          { icon: '🕒', label: 'وقت الحذف', value: timeNow() },
          { icon: '📎', label: 'النوع', value: entry?.kind || (origText ? 'نص ✍️' : 'غير معروف') }
        ],
        notes: origText ? [`📝 نص الحالة:`, origText.slice(0, 1500)] : []
      },
      media
    );

    cacheFor(statusCache, tgId).delete(id);
  }

  /* ================= كشف العرض لمرة واحدة ================= */
  async function revealViewOnce(m) {
    const media = mediaNodeOf(m.message);
    const from = realNumber(m);
    const t = msgTextOf(m.message);

    let buf = null;
    if (media) {
      try {
        buf = await dlBuffer(sock, m);
      } catch (e) {
        log(`viewOnce: تعذر تنزيل الوسائط — ${e.message}`);
      }
    }

    await alert.send(
      `von:${tgId}:${m.key?.id}`,
      {
        title: '👁 تم كشف رسالة «العرض لمرة واحدة»!',
        fields: [
          { icon: '👤', label: 'المرسل', value: senderName(m) },
          { icon: '📱', label: 'رقمه الفعلي', value: fmtNum(from) },
          { icon: '💬', label: 'النوع', value: chatLabel(m.key?.remoteJid) },
          { icon: '🕒', label: 'الوقت', value: timeNow() },
          { icon: '📎', label: 'المحتوى', value: media?.kind || 'نص ✍️' }
        ],
        notes: t ? [`📝 النص:`, t.slice(0, 800)] : []
      },
      buf?.length ? { buf, mime: media?.mime || 'application/octet-stream', filename: media?.filename } : null
    );
  }
}

export { msgCache, statusCache };

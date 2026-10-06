/**
 * alerts.js — موجّه التنبيهات (حذف الرسائل / الحالات / العرض لمرة واحدة)
 *
 * ✅ ما يفعله هذا الملف:
 *  - يرسل التنبيه إلى **محادثة الرقم المربوط نفسه داخل واتساب** (الافتراضي)،
 *    أو إلى تيليجرام، أو للاثنين — حسب إعداد المستخدم.
 *  - كل تنبيه يُرسل **لمرة واحدة فقط** (منع التكرار) عبر مفتاح فريد.
 *  - يرسل **الرقم الفعلي الصحيح** لصاحب الرسالة (يدعم نظام LID الجديد).
 */
import { store } from './store.js';
import { formatAlert, jidToNumber, isPhoneNumber } from './utils.js';

/* ==========================================================
 *  1) إرسال إلى تيليجرام (يُربط من bot.js)
 * ========================================================== */
let tgTextSender = null;
let tgMediaSender = null;

export const setTelegramSenders = ({ text, media } = {}) => {
  if (typeof text === 'function') tgTextSender = text;
  if (typeof media === 'function') tgMediaSender = media;
};

/* ==========================================================
 *  2) منع التكرار (مرة واحدة فقط)
 * ========================================================== */
const sent = new Map(); // key -> ts
const SENT_TTL = 24 * 60 * 60 * 1000; // يوم
const SENT_MAX = 8000;

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of sent) if (now - ts > SENT_TTL) sent.delete(k);
}, 10 * 60 * 1000).unref?.();

/** يعيد true إذا كان هذا أول ظهور للمفتاح */
function firstTime(key) {
  if (!key) return true;
  if (sent.has(key)) return false;
  sent.set(key, Date.now());
  if (sent.size > SENT_MAX) {
    // حذف الأقدم
    let oldest = null;
    for (const [k, ts] of sent) if (!oldest || ts < oldest[1]) oldest = [k, ts];
    if (oldest) sent.delete(oldest[0]);
  }
  return true;
}

export const alertStats = () => ({ pending: sent.size });

/* ==========================================================
 *  3) جِد محادثة الرقم المربوط نفسه (Self Chat)
 * ========================================================== */
export function selfJid(sock) {
  const raw = sock?.user?.id;
  if (!raw) return null;
  const num = jidToNumber(raw);
  return isPhoneNumber(num) ? `${num}@s.whatsapp.net` : null;
}

/* ==========================================================
 *  4) موجّه التنبيهات لكل جلسة
 * ========================================================== */
/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string|number} tgId
 */
export function createAlerter(sock, tgId) {
  return {
    /**
     * إرسال تنبيه
     * @param {string} key مفتاح فريد لمنع التكرار (مثال: del:<msgId>)
     * @param {object} alert { title, fields, notes }
     * @param {{buf?:Buffer, mime?:string, filename?:string}|null} media
     */
    async send(key, alert, media = null) {
      try {
        const s = store.getUser(tgId).settings;
        if (!s.alertsOn) return false;
        if (s.alertOnce && !firstTime(key)) return false;

        const to = String(s.alertsTo || 'whatsapp').toLowerCase();
        const wantWa = to === 'whatsapp' || to === 'both';
        const wantTg = to === 'telegram' || to === 'both';

        /* --- (أ) واتساب: محادثة الرقم المربوط نفسه --- */
        if (wantWa && s.alertsToSelfChat) {
          const jid = selfJid(sock);
          if (jid) {
            const text = formatAlert(alert, 'wa');
            try {
              if (media?.buf?.length) {
                const content = buildWaMedia(media, text);
                await sock.sendMessage(jid, content);
              } else {
                await sock.sendMessage(jid, { text });
              }
            } catch (e) {
              // لو فشل إرسال الوسائط، أرسل النص على الأقل
              try {
                await sock.sendMessage(jid, { text });
              } catch {
                /* ignore */
              }
            }
          }
        }

        /* --- (ب) تيليجرام --- */
        if (wantTg && tgTextSender) {
          const text = formatAlert(alert, 'tg');
          if (media?.buf?.length && tgMediaSender) {
            await tgMediaSender(String(tgId), media.buf, media.mime || 'application/octet-stream', text);
          } else {
            await tgTextSender(String(tgId), text);
          }
        }

        return true;
      } catch {
        return false;
      }
    }
  };
}

/** بناء محتوى الوسائط لإرسالها في واتساب */
function buildWaMedia(media, caption) {
  const mime = String(media.mime || '');
  const buf = media.buf;
  const cap = caption.length > 1000 ? caption.slice(0, 1000) + '…' : caption;

  if (/^image\//.test(mime)) return { image: buf, caption: cap, mimetype: mime };
  if (/^video\//.test(mime)) return { video: buf, caption: cap, mimetype: mime };
  if (/^audio\//.test(mime)) return { audio: buf, mimetype: mime, ptt: false };
  if (/webp/.test(mime)) return { sticker: buf };
  return {
    document: buf,
    mimetype: mime || 'application/octet-stream',
    fileName: media.filename || 'file',
    caption: cap
  };
}

export { jidToNumber };

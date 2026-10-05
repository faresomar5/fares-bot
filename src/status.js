/**
 * status.js — محرك التفاعل البشري على حالات واتساب
 *
 * الخطوات لكل حالة جديدة:
 *   1) readMessages()  → مشاهدة الحالة (تظهر كمشاهدة طبيعية)
 *   2) تأخير عشوائي بثوانٍ معدودة (محاكاة زمن قراءة الإنسان)
 *   3) إرسال الإيموجي المخصص (react على status@broadcast + statusJidList)
 *   4) إرسال القلب الأخضر 💚 (اختياري)
 *
 * ملاحظة مهمة (صريحة): واتساب يسمح بتفاعل واحد فقط لكل رسالة/حالة.
 * لذلك إرسال إيموجي ثم قلب أخضر يعني أن الأخير هو الذي يبقى ظاهراً.
 * يمكن عكس الترتيب من الإعدادات keepCustomEmojiLast.
 */
import { store } from './store.js';
import { randInt, delay, jidToNumber, randomPick } from './utils.js';

/** ذاكرة مؤقتة لمنع تكرار التفاعل على نفس الحالة */
const seen = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of seen) if (now - ts > 30 * 60 * 1000) seen.delete(id);
}, 5 * 60 * 1000).unref?.();

export const seenCount = () => seen.size;

const inQuietHours = (s) => {
  if (!s.quietHours?.enabled) return false;
  const h = new Date().getHours();
  const { from, to } = s.quietHours;
  return from <= to ? h >= from && h < to : h >= from || h < to;
};

/**
 * ربط محرك الحالات بسوكيت معيّن
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {string|number} tgId
 * @param {{log?:Function, notify?:Function}} hooks
 */
export function attachStatusEngine(sock, tgId, hooks = {}) {
  const log = hooks.log || (() => {});
  const notify = hooks.notify || (() => {});

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages || []) {
      try {
        if (m?.key?.remoteJid !== 'status@broadcast') continue;
        if (!m.key?.participant) continue;

        const id = m.key.id;
        if (seen.has(id)) continue;
        seen.set(id, Date.now());

        const u = store.getUser(tgId);
        const s = u.settings;

        if (!s.autoReact) continue;
        if (inQuietHours(s)) {
          log('وضع ساعات الهدوء — تم تخطي الحالة');
          continue;
        }

        await reactToStatus(sock, tgId, m, s, log, s.notifyStatusReaction ? notify : null);
      } catch (e) {
        store.bump(tgId, 'errors');
        log(`خطأ في معالجة الحالة: ${e.message}`);
      }
    }
  });
}

/**
 * تنفيذ التفاعل الكامل على حالة واحدة
 */
export async function reactToStatus(sock, tgId, m, settings, log = () => {}, notify = () => {}) {
  const s = settings || store.getUser(tgId).settings;
  const sender = m.key.participant;
  const statusJidList = [sender]; // من سيستلم التفاعل

  // 1) مشاهدة الحالة أولاً (سلوك بشري طبيعي)
  if (s.viewFirst) {
    try {
      await sock.readMessages([m.key]);
    } catch (e) {
      log(`تعذر إرسال إشعار القراءة: ${e.message}`);
    }
  }
  store.bump(tgId, 'viewed');

  // 2) انتظار بشري قبل التفاعل
  const waitMs = randInt(s.reactDelayMin * 1000, s.reactDelayMax * 1000) + randInt(300, 2500);
  await delay(waitMs);

  const custom = s.emojis?.length ? randomPick(s.emojis) : null;
  const GREEN = '💚';

  const sendReact = async (emoji, label) => {
    try {
      await sock.sendMessage(
        'status@broadcast',
        { react: { text: emoji, key: m.key } },
        { statusJidList }
      );
      store.bump(tgId, 'reacted');
      log(`تفاعل بـ ${emoji} (${label}) على حالة ${jidToNumber(sender)}`);
      return true;
    } catch (e) {
      store.bump(tgId, 'errors');
      log(`فشل التفاعل ${emoji}: ${e.message}`);
      return false;
    }
  };

  if (s.keepCustomEmojiLast) {
    // الترتيب المعكوس: القلب أولاً ثم الإيموجي المخصص
    if (s.greenHeart) await sendReact(GREEN, 'القلب الأخضر');
    if (custom && custom !== GREEN) {
      await delay(randInt(1200, 3500));
      await sendReact(custom, 'إيموجي مخصص');
    }
  } else {
    // الترتيب الافتراضي: الإيموجي المخصص ثم القلب الأخضر
    if (custom) await sendReact(custom, 'إيموجي مخصص');
    if (s.greenHeart) {
      await delay(randInt(1200, 3500));
      await sendReact(GREEN, 'القلب الأخضر');
    }
  }

  // إشعار تيليجرام عند التفاعل — مُعطّل افتراضياً (notify = null يعني لا رسالة)
  if (notify) notify(tgId, `👀 تم التفاعل على حالة <b>${jidToNumber(sender)}</b>`);
}

/** تفاعل يدوي على حالة محددة (يُستدعى من الأوامر) */
export async function manualReact(sock, m, emoji) {
  return sock.sendMessage(
    'status@broadcast',
    { react: { text: emoji, key: m.key } },
    { statusJidList: [m.key.participant] }
  );
}

/** نشر حالة نصية (ميزة إضافية) */
export async function publishTextStatus(sock, text, jidList = []) {
  return sock.sendMessage(
    'status@broadcast',
    { text: String(text) },
    { backgroundColor: '#0B141A', font: 3, statusJidList: jidList }
  );
}

export { seen };

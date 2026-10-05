/**
 * utils.js — أدوات مساعدة عامة
 */
import crypto from 'node:crypto';

export const delay = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) | 0)));

export const randInt = (min, max) =>
  Math.floor(Math.random() * (max - Math.min(min, max) + 1)) + Math.min(min, max);

export const cleanPhone = (s) => String(s ?? '').replace(/\D/g, '');

export const jidToNumber = (jid) => String(jid ?? '').split('@')[0].split(':')[0];

export const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

export const fmtBytes = (b) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Number(b) || 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

export const fmtUptime = (ms) => {
  const s = Math.floor((Number(ms) || 0) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}ي`);
  if (h) parts.push(`${h}س`);
  if (m) parts.push(`${m}د`);
  parts.push(`${sec}ث`);
  return parts.join(' ');
};

/** تأخير بشري: ثوانٍ عشوائية + ضجيج عشوائي صغير */
export const humanDelay = (minS, maxS) => delay(randInt(minS * 1000, maxS * 1000) + randInt(250, 2000));

export const hash = (algo, text) => crypto.createHash(algo).update(String(text), 'utf8').digest('hex');

export const md5 = (t) => hash('md5', t);

export const randomPick = (arr) => (Array.isArray(arr) && arr.length ? arr[randInt(0, arr.length - 1)] : null);

export const safeJson = (s, fallback = null) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** تنسيق مدة بالمللي ثانية إلى نص عربي مختصر */
export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}ث` : `${Math.round(ms)}م.ث`);

/**
 * تقسيم نص طويل إلى مقاطع ضمن الحد المسموح (تيليجرام 4096 حرف)
 * يقسم عند نهايات الأسطر إن أمكن ويتجنب قطع الوسوم في منتصفها
 */
export function chunkText(text, limit = 3900) {
  const s = String(text ?? '');
  if (s.length <= limit) return [s];
  const chunks = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      chunks.push(cur);
      cur = '';
    }
  };
  for (const line of s.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (!cur) cur = line;
    else if (cur.length + 1 + line.length <= limit) cur += '\n' + line;
    else {
      flush();
      cur = line;
    }
  }
  flush();
  return chunks;
}

/** إرسال نص طويل على عدة رسائل (يعمل مع reply في تيليجرام وواتساب) */
export async function sendLong(ctx, text, { header = '', pauseMs = 350, opts = {} } = {}) {
  const parts = chunkText(text);
  for (let i = 0; i < parts.length; i++) {
    const t = i === 0 ? parts[0] : `${header ? header + '\n' : ''}📄 <b>تكملة (${i + 1}/${parts.length})</b>\n${parts[i]}`;
    await ctx.reply(t, opts);
    if (i < parts.length - 1) await delay(pauseMs);
  }
  return parts.length;
}

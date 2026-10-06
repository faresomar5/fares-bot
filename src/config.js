/**
 * config.js — تحميل وضبط كل الإعدادات والمسارات
 *
 * ✳️ الجديد في هذا الإصدار:
 *  - تخزين دائم (Persistent Storage) للجلسات وقاعدة البيانات:
 *    يكتشف السيرفر تلقائياً وجود قرص/وحدة تخزين دائمة (/data, /mnt/data, /var/data ...)
 *    وينقل الجلسات إليها، ويحفظ مسارها في ملف علامة (.persist-root) حتى تبقى
 *    الجلسات تعمل بعد أي إعادة تشغيل أو إعادة نشر، ولو تغيّر مجلد التشغيل.
 *  - إنشاء روابط رمزية (symlink) من مجلد المشروع إلى المجلد الدائم للتوافق.
 *  - مسارات مطلقة تُحترم كما هي إن حدّدها المستخدم في .env
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// الجذر = مجلد المشروع نفسه (وليس مجلد التشغيل)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ==========================================================
 *  1) التخزين الدائم (Persistent Storage)
 * ========================================================== */
const MARKER = path.join(ROOT, '.persist-root');

const ensureWritable = (dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.w-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
};

/** مرشحات المجلدات الدائمة الشائعة على منصات الاستضافة */
const PERSIST_CANDIDATES = ['/data', '/mnt/data', '/var/data', '/opt/data', '/persistent', '/storage', '/app/data'];

function detectPersistRoot() {
  // (1) متغير بيئة صريح
  const envRoot = (process.env.PERSIST_ROOT || process.env.PERSIST_DIR || '').trim();
  if (envRoot) {
    const abs = path.resolve(envRoot);
    if (ensureWritable(abs)) return abs;
  }
  // (2) علامة محفوظة من تشغيل سابق (تضمن نفس المسار دائماً)
  try {
    const saved = fs.readFileSync(MARKER, 'utf8').trim();
    if (saved) {
      const abs = path.resolve(saved);
      if (ensureWritable(abs)) return abs;
    }
  } catch {
    /* لا توجد علامة بعد */
  }
  // (3) اكتشاف تلقائي لأول مجلد دائم متاح
  for (const c of PERSIST_CANDIDATES) {
    if (!fs.existsSync(c)) continue;
    const abs = path.resolve(c);
    if (abs === ROOT) continue;
    if (ensureWritable(abs)) {
      try {
        fs.writeFileSync(MARKER, abs);
      } catch {
        /* ignore */
      }
      return abs;
    }
  }
  // (4) الافتراضي: مجلد المشروع
  return ROOT;
}

export const PERSIST_ROOT = detectPersistRoot();

/** يحوّل قيمة المسار: يبقى المطلق كما هو، والنسبي يوضع داخل المجلد الدائم */
const resolveStore = (envValue, fallbackName) => {
  const v = (envValue || '').trim();
  if (v && path.isAbsolute(v)) return path.resolve(v);
  const name = v ? path.basename(v.replace(/[\\/]+$/, '')) || fallbackName : fallbackName;
  return path.join(PERSIST_ROOT, name);
};

/* ==========================================================
 *  2) الإعدادات العامة
 * ========================================================== */
export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  OWNER_ID: num(process.env.OWNER_ID, 0),
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),

  MAX_SESSIONS: num(process.env.MAX_SESSIONS, 100),

  // ===== المسارات الدائمة =====
  PERSIST_ROOT,
  SESSION_ROOT: resolveStore(process.env.SESSION_DIR, 'sessions'),
  DATA_DIR: resolveStore(process.env.DATA_DIR, 'data'),
  TMP_DIR: path.resolve(ROOT, 'tmp'),
  BIN_DIR: path.join(resolveStore(process.env.DATA_DIR, 'data'), 'bin'),
  COOKIES_FILE: (process.env.COOKIES_FILE || '').trim() || path.join(resolveStore(process.env.DATA_DIR, 'data'), 'cookies.txt'),

  GC_INTERVAL_MS: num(process.env.GC_INTERVAL_MS, 60_000),
  MEM_LIMIT_MB: num(process.env.MEM_LIMIT_MB, 400),
  CACHE_SWEEP_MIN: num(process.env.CACHE_SWEEP_MIN, 10),

  DEFAULT_REACT_DELAY_MIN: num(process.env.DEFAULT_REACT_DELAY_MIN, 4),
  DEFAULT_REACT_DELAY_MAX: num(process.env.DEFAULT_REACT_DELAY_MAX, 12),

  LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
  YTDLP_BIN: process.env.YTDLP_BIN || 'yt-dlp',
  FFMPEG_BIN: process.env.FFMPEG_BIN || 'ffmpeg',
  USER_AGENT:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',

  // ===== سلوك التنبيهات الافتراضي =====
  // الوجهة: محادثة الرقم المربوط نفسه داخل واتساب (وليس بوت تيليجرام)
  ALERTS_TO: process.env.ALERTS_TO || 'whatsapp',

  VERSION: '1.3.0',
  STARTED_AT: Date.now()
};

/* ==========================================================
 *  3) أدوات النسخ والربط الرمزي
 * ========================================================== */
function copyRec(from, to) {
  const st = fs.lstatSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from)) copyRec(path.join(from, e), path.join(to, e));
  } else if (st.isFile()) {
    fs.copyFileSync(from, to);
  }
}

/** ينسخ محتوى مجلد قديم إلى الجديد دون استبدال أي ملف موجود */
function migrateDir(src, dst) {
  try {
    if (!fs.existsSync(src)) return 0;
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink() || !st.isDirectory()) return 0;
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, e.name);
      const to = path.join(dst, e.name);
      if (fs.existsSync(to)) continue;
      try {
        copyRec(from, to);
        n++;
      } catch (err) {
        console.error(`[config] تعذر نسخ ${from}: ${err.message}`);
      }
    }
    return n;
  } catch (e) {
    console.error(`[config] تعذر ترحيل ${src}: ${e.message}`);
    return 0;
  }
}

/** ينشئ رابطاً رمزياً من مجلد المشروع إلى المجلد الدائم (للتشغيل القديم) */
function linkDir(linkPath, target) {
  try {
    if (path.resolve(linkPath) === path.resolve(target)) return;
    if (fs.existsSync(linkPath)) {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink()) return;
      const rest = fs.readdirSync(linkPath).filter((n) => !n.startsWith('.'));
      if (rest.length) return; // فيه ملفات لم تُنقل — نتركه كما هو
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
    fs.symlinkSync(target, linkPath, 'dir');
    console.log(`🔗 ربط ${path.basename(linkPath)} → ${target}`);
  } catch {
    /* الرابط الرمزي غير ضروري */
  }
}

/** إنشاء المجلدات + ترحيل الجلسات القديمة + الربط الرمزي */
export function ensureDirs() {
  for (const dir of [CONFIG.SESSION_ROOT, CONFIG.DATA_DIR, CONFIG.TMP_DIR, CONFIG.BIN_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error(`[config] تعذر إنشاء المجلد ${dir}: ${e.message}`);
    }
  }

  const legacySessions = path.join(ROOT, 'sessions');
  const legacyData = path.join(ROOT, 'data');

  if (path.resolve(legacySessions) !== path.resolve(CONFIG.SESSION_ROOT)) {
    const n = migrateDir(legacySessions, CONFIG.SESSION_ROOT);
    if (n) console.log(`📦 تم ترحيل ${n} جلسة إلى التخزين الدائم: ${CONFIG.SESSION_ROOT}`);
    linkDir(legacySessions, CONFIG.SESSION_ROOT);
  }
  if (path.resolve(legacyData) !== path.resolve(CONFIG.DATA_DIR)) {
    const n = migrateDir(legacyData, CONFIG.DATA_DIR);
    if (n) console.log(`📦 تم ترحيل ${n} ملف بيانات إلى التخزين الدائم: ${CONFIG.DATA_DIR}`);
    linkDir(legacyData, CONFIG.DATA_DIR);
  }
}

/** التحقق من الإعدادات الإلزامية */
export function assertConfig() {
  if (!CONFIG.BOT_TOKEN || !/^\d+:[\w-]+$/.test(CONFIG.BOT_TOKEN)) {
    console.error(
      '\n[خطأ] BOT_TOKEN غير موجود أو غير صالح.\n' +
        'انسخ ملف .env.example إلى .env وضع توكن البوت من @BotFather.\n'
    );
    process.exit(1);
  }
  if (CONFIG.DEFAULT_REACT_DELAY_MAX < CONFIG.DEFAULT_REACT_DELAY_MIN) {
    CONFIG.DEFAULT_REACT_DELAY_MAX = CONFIG.DEFAULT_REACT_DELAY_MIN + 5;
  }
  ensureDirs();
  console.log(`💾 التخزين الدائم: ${CONFIG.PERSIST_ROOT}`);
  console.log(`🗂 الجلسات: ${CONFIG.SESSION_ROOT}`);
}

export const sessionDir = (tgId) => path.join(CONFIG.SESSION_ROOT, String(tgId));
export { ROOT };

/**
 * config.js — تحميل وضبط كل الإعدادات والمسارات
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  OWNER_ID: num(process.env.OWNER_ID, 0),
  ADMIN_IDS: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),

  MAX_SESSIONS: num(process.env.MAX_SESSIONS, 100),

  SESSION_ROOT: path.resolve(ROOT, process.env.SESSION_DIR || 'sessions'),
  DATA_DIR: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  TMP_DIR: path.resolve(ROOT, 'tmp'),

  GC_INTERVAL_MS: num(process.env.GC_INTERVAL_MS, 60_000),
  MEM_LIMIT_MB: num(process.env.MEM_LIMIT_MB, 400),
  CACHE_SWEEP_MIN: num(process.env.CACHE_SWEEP_MIN, 10),

  DEFAULT_REACT_DELAY_MIN: num(process.env.DEFAULT_REACT_DELAY_MIN, 4),
  DEFAULT_REACT_DELAY_MAX: num(process.env.DEFAULT_REACT_DELAY_MAX, 12),

  LOG_LEVEL: process.env.LOG_LEVEL || 'silent',
  YTDLP_BIN: process.env.YTDLP_BIN || 'yt-dlp',

  VERSION: '1.0.0',
  STARTED_AT: Date.now()
};

/** إنشاء المجلدات الأساسية إن لم تكن موجودة */
export function ensureDirs() {
  for (const dir of [CONFIG.SESSION_ROOT, CONFIG.DATA_DIR, CONFIG.TMP_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error(`[config] تعذر إنشاء المجلد ${dir}: ${e.message}`);
    }
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
}

export const sessionDir = (tgId) => path.join(CONFIG.SESSION_ROOT, String(tgId));
export { ROOT };

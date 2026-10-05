/**
 * store.js — قاعدة بيانات JSON خفيفة (بدون اعتماديات ثقيلة)
 * تحفظ إعدادات كل مستخدم + الإيموجيات المخصصة + الإحصائيات
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';

const FILE = path.join(CONFIG.DATA_DIR, 'db.json');

export const DEFAULT_SETTINGS = {
  autoReact: true, // تفاعل تلقائي على الحالات
  viewFirst: true, // مشاهدة الحالة أولاً (سلوك بشري)
  greenHeart: true, // القلب الأخضر 💚 بعد الإيموجي
  keepCustomEmojiLast: false, // لو true يبقى الإيموجي المخصص هو الأخير
  reactDelayMin: CONFIG.DEFAULT_REACT_DELAY_MIN,
  reactDelayMax: CONFIG.DEFAULT_REACT_DELAY_MAX,
  emojis: ['❤️', '🔥', '👏', '😍', '💯', '😂', '🙏', '💚'],
  protection: true, // وضع الحماية (تقييد السرعة + تجاهل الرسائل الجماعية)
  antiDelete: false, // إعادة إرسال الرسائل المحذوفة (للمجموعات الخاصة)
  autoReply: false, // ردود آلية
  autoReplies: {}, // { "كلمة": "الرد" }
  blocked: [], // أرقام محظورة
  groupWelcome: false,
  readReceipts: true, // إرسال إشعار القراءة
  typingSim: true, // محاكاة "يكتب..."
  quietHours: { enabled: false, from: 2, to: 7 } // ساعات هدوء (لا تفاعل)
};

const EMPTY = () => ({ users: {}, global: { createdAt: Date.now() } });

let db = EMPTY();
let timer = null;

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = { users: parsed.users || {}, global: parsed.global || { createdAt: Date.now() } };
  } catch {
    db = EMPTY();
  }
}

function writeNow() {
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[store] فشل الحفظ:', e.message);
  }
}

function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(writeNow, 800);
  timer.unref?.();
}

load();

export const store = {
  raw: () => db,
  save: scheduleSave,
  saveNow: writeNow,
  reload: load,

  getUser(id) {
    const k = String(id);
    if (!db.users[k]) {
      db.users[k] = {
        id: k,
        phone: null,
        connected: false,
        createdAt: Date.now(),
        settings: { ...DEFAULT_SETTINGS },
        stats: { viewed: 0, reacted: 0, errors: 0, connects: 0, startedAt: null }
      };
      scheduleSave();
    }
    const u = db.users[k];
    u.settings = { ...DEFAULT_SETTINGS, ...(u.settings || {}) };
    u.stats = { viewed: 0, reacted: 0, errors: 0, connects: 0, startedAt: null, ...(u.stats || {}) };
    return u;
  },

  update(id, patch) {
    const u = this.getUser(id);
    Object.assign(u, patch);
    scheduleSave();
    return u;
  },

  updateSettings(id, patch) {
    const u = this.getUser(id);
    u.settings = { ...u.settings, ...patch };
    scheduleSave();
    return u;
  },

  bump(id, key, by = 1) {
    const u = this.getUser(id);
    u.stats[key] = (u.stats[key] || 0) + by;
    scheduleSave();
  },

  all: () => Object.values(db.users),
  count: () => Object.keys(db.users).length,

  reset(id) {
    const k = String(id);
    delete db.users[k];
    scheduleSave();
  }
};

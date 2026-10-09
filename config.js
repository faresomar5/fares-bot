// config.js — كل الإعدادات القابلة للتعديل في مكان واحد (قراءة من .env مع افتراضات آمنة)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// يعمل البوت أحياناً من PM2/systemd بمجلد تشغيل مختلف؛ حمّل بيئة المشروع صراحةً.
dotenv.config({ path: path.join(__dirname, '.env') });
const localPath = (value) => {
  const v = String(value || '').trim();
  return v ? (path.isAbsolute(v) ? v : path.resolve(__dirname, v)) : '';
};

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = true) => (v === undefined || v === '' ? d : String(v).toLowerCase() !== 'false');
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ─────────── هوية العملية ───────────
// ROLE = main (سيرفر رئيسي) | worker (سيرفر عامل)
// إذا لم يُضبط ROLE صراحةً: وجود WORKER_NAME يعني أن هذا سيرفر عامل، وإلا فهو الرئيسي.
const ROLE = (process.env.ROLE || (process.env.WORKER_NAME ? 'worker' : 'main')).toLowerCase();
const IS_MAIN = ROLE !== 'worker';

export default {
  // ─────────── هوية العملية ───────────
  role: ROLE,
  isMain: IS_MAIN,
  isWorker: !IS_MAIN,
  version: '3.15.0',  // v3.15 — نظام الدعم الفني (مستخدم ← مطور ← مستخدم) + مكتبة أكواد منصة ARAB code كاملة داخل المشروع: إصلاح جذري لنظام الاقتران + 21 زراً تفاعلياً في /start (مشروطة بنجاح الربط) + مفتاح ذكاء اصطناعي آمن متعدد المزوّدين + انضمام تلقائي لقناة الواتساب

  // ─────────── تيليجرام (للسيرفر الرئيسي فقط) ───────────
  telegramToken: IS_MAIN ? String(process.env.TG_TOKEN || '').trim() : '',

  // معرفات المطورين (تيليجرام)
  devIds: list(process.env.DEV_IDS).map(Number),

  // من يُسمح له باستخدام البوت (Telegram numeric IDs). فارغة = الجميع
  allowedUsers: list(process.env.ALLOWED_USERS).map(Number),

  // ─────────── الخادم الرئيسي (المنسق) ───────────
  main: {
    port: int(process.env.MAIN_PORT, 3000),
    apiSecret: process.env.API_SECRET || 'change_me_to_a_long_random_secret',
    url: process.env.MAIN_URL || 'http://127.0.0.1:3000'
  },

  // ─────────── هذا السيرفر (رئيسي أو عامل) ───────────
  localServer: {
    name: process.env.LOCAL_SERVER_NAME || 'server1',
    maxSessions: int(process.env.MAX_SESSIONS, 4),
    port: int(process.env.WORKER_PORT, 3001),
    url: process.env.WORKER_URL || `http://127.0.0.1:${int(process.env.WORKER_PORT, 3001)}`
  },

  mainApiUrl: (process.env.MAIN_API_URL || 'http://127.0.0.1:3000').trim(),
  workerName: process.env.WORKER_NAME || 'server2',

  // ─────────── مسارات التخزين الدائم ───────────
  dataDir: path.join(__dirname, 'data'),
  usersFile: path.join(__dirname, 'data', 'users.json'),
  settingsFile: path.join(__dirname, 'data', 'settings.json'),
  serversFile: path.join(__dirname, 'data', 'servers.json'),
  prefsFile: path.join(__dirname, 'data', 'session-prefs.json'),
  sessionsDir: path.join(__dirname, 'data', 'sessions'),

  // ★ v3.8: الأوامر المخصّصة + ملفات أوامر الرقم المربوط
  //   customCommandsFile : أوامر نصية يضيفها المطور من بوت تيليجرام (اسم الأمر + نص الرد).
  //   sessionCommandsDir : مجلد ملفات الأوامر البرمجية المرفوعة لكل رقم مربوط
  //                        (داخل كل رقم: <userId>_<phone>/<name>.js).
  customCommandsFile: path.join(__dirname, 'data', 'custom-commands.json'),
  autoRepliesFile: path.join(__dirname, 'data', 'auto-replies.json'),
  sessionCommandsDir: path.join(__dirname, 'data', 'session-commands'),

  // ★ v3.9: كلمات مرور لوحة التحكم لكل رقم + خيارات التحكم الشاملة لكل رقم
  passwordsFile: path.join(__dirname, 'data', 'dashboard-passwords.json'),
  featuresFile: path.join(__dirname, 'data', 'features.json'),

  // ─────────── إعدادات الواتساب ───────────
  whatsapp: {
    browserName: 'Chrome',
    pairingStartDelayMs: 4000,
    pairingCodeTtlSec: 90,
    maxPairingAttempts: 4,
    pairingRetryDelayMs: 4000,
    keepAliveReconnectMin: 0,
    reactDelayMinMs: 1000,
    reactDelayMaxMs: 4000,
    // ★ v3.14: مهلة طلب كود الاقتران — لا يبقى الطلب معلّقاً بلا رد (كان سبب «توقف» شاشة الكود)
    pairingRequestTimeoutMs: int(process.env.PAIRING_REQUEST_TIMEOUT_MS, 30000)
  },

  // ─────────── الحالات: إيصال مشاهدة + تعليم كمقروء + تفاعل بالإيموجي ───────────
  // القيم هنا افتراضيات؛ ويمكن تغييرها مباشرة من لوحة التحكم (تُحفظ في settings.json)
  status: {
    concurrency: int(process.env.STATUS_CONCURRENCY, 8),
    fastMode: bool(process.env.STATUS_FAST_MODE, true),
    markRead: bool(process.env.STATUS_MARK_READ, true),
    autoView: bool(process.env.STATUS_AUTO_VIEW, true),
    autoLike: bool(process.env.STATUS_AUTO_LIKE, true),
    likeEmoji: process.env.STATUS_LIKE_EMOJI || '❤️',
    maxDelayMs: int(process.env.STATUS_MAX_DELAY_MS, 0),
    // ★ صار التفاعل يُرسَل في نفس لحظة المشاهدة (بلا أي مهلة) — أُبقيت القيمة
    //   للتوافق مع لوحة التحكم فقط؛ والقيمة الافتراضية 0 = بلا انتظار إطلاقاً.
    reactDelayMs: int(process.env.STATUS_REACT_DELAY_MS, 0),
    // ★ عدد محاولات إرسال التفاعل قبل إعلان الفشل (0 = محاولة واحدة فقط)
    reactRetries: int(process.env.STATUS_REACT_RETRIES, 2),
    // ★ v3.13: نمط تفاعل الحالات — واتساب يعطي كل مُتفاعِل تفاعلاً واحداً فقط على
    //   مفتاح الحالة (التفاعل الثاني يستبدل الأول)، فلا يوجد «تفاعلان معاً» رسمياً.
    //   rotate (افتراضي) = كل حالة تأخذ الإيموجي التالي من قائمتك (مضمون)
    //   single = الأول فقط • joined = دمج الكل في تفاعل واحد (عرضه يعتمد على العميل)
    reactionMode: String(process.env.STATUS_REACTION_MODE || 'rotate').toLowerCase(),
    maxReactionEmojis: int(process.env.STATUS_REACTION_MAX_EMOJIS, 5)
  },

  // ─────────── محرّك التحميل من منصات التواصل ───────────
  downloader: {
    enabled: bool(process.env.DOWNLOADER_ENABLED, true),
    bin: process.env.YTDLP_BIN || 'yt-dlp',
    ffmpeg: process.env.FFMPEG_BIN || '/usr/bin/ffmpeg',
    tmpDir: process.env.DOWNLOADER_TMP || path.join(__dirname, 'data', 'tmp'),
    maxFilesizeMb: int(process.env.DOWNLOADER_MAX_MB, 60),
    timeoutMs: int(process.env.DOWNLOADER_TIMEOUT_MS, 180000),
    concurrency: int(process.env.DOWNLOADER_CONCURRENCY, 3),
    proxy: process.env.YTDLP_PROXY || '',
    // اختياري: لا تُستخدم إلا إذا ضبطها صاحب السيرفر محلياً لمحتوى يملكه.
    cookiesFile: localPath(process.env.YTDLP_COOKIES_FILE || process.env.INSTAGRAM_COOKIE_FILE),
    instagramCookieFile: localPath(process.env.INSTAGRAM_COOKIE_FILE || process.env.YTDLP_COOKIES_FILE),
    youtubeCookieFile: localPath(process.env.YOUTUBE_COOKIES_FILE || process.env.YTDLP_COOKIES_FILE),
    cookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || '',
  },

  // ─────────── أدوات التحميل (تثبيت + تحديث تلقائي عند كل إقلاع) ───────────
  // autoInstall: يثبّت yt-dlp و ffmpeg تلقائياً إن كانا مفقودين (pip / ملف مستقل / npm / apt)
  // autoUpdate : يفحص تحديث yt-dlp عند كل تشغيل (يوتيوب يتغيّر باستمرار)
  tools: {
    autoInstall: bool(process.env.AUTO_INSTALL_TOOLS, true),
    autoUpdate: bool(process.env.YTDLP_AUTO_UPDATE, true),
    binDir: process.env.TOOLS_BIN_DIR || path.join(__dirname, 'bin')
  },

  // ─────────── حدود إرسال الوسائط عبر واتساب ───────────
  waLimits: {
    videoSafeMb: int(process.env.WA_VIDEO_MAX_MB, 45),
    hardMb: int(process.env.WA_HARD_MAX_MB, 60)
  },

  // ─────────── لوحة التحكم (واجهة الويب) ───────────
  dashboard: {
    enabled: bool(process.env.DASHBOARD_ENABLED, true),
    password: process.env.DASHBOARD_PASSWORD || 'admin123',
    sessionTtlMs: int(process.env.DASHBOARD_TTL_MS, 12 * 3600 * 1000)
  },

  // ─────────── الإذاعة عبر الواتساب ───────────
  broadcastWaDelayMinMs: int(process.env.BROADCAST_WA_DELAY_MIN_MS, 3000),
  broadcastWaDelayMaxMs: int(process.env.BROADCAST_WA_DELAY_MAX_MS, 7000),

  // ─────────── ★ v3.14: الذكاء الاصطناعي (مفتاح آمن + مزوّدون متعددون) ───────────
  // المفتاح يُقرأ من البيئة، ويمكن تعيين مفتاح خاص لكل رقم من البوت/اللوحة.
  // لا يوجد أي مفتاح مضمَّن في الكود، ولا يُطبع في السجل (يُعرض مقنّعاً فقط).
  ai: {
    enabled: bool(process.env.AI_ENABLED, true),
    provider: String(process.env.AI_PROVIDER || 'auto').toLowerCase(),
    apiKey: String(process.env.AI_API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    baseUrl: String(process.env.AI_API_BASE || process.env.OPENAI_API_BASE || '').trim(),
    model: String(process.env.AI_MODEL || process.env.OPENAI_MODEL || '').trim(),
    temperature: Number(process.env.AI_TEMPERATURE || 0.6),
    maxTokens: int(process.env.AI_MAX_TOKENS, 500),
    timeoutMs: int(process.env.AI_TIMEOUT_MS, 30000),
    retries: int(process.env.AI_RETRIES, 2),
    memoryTurns: int(process.env.AI_MEMORY_TURNS, 6),
    systemPrompt: String(process.env.AI_SYSTEM_PROMPT || '').trim(),
    keysFile: path.join(__dirname, 'data', 'ai-keys.json')
  },

  // ─────────── ★ v3.14: قناة الواتساب الرسمية (انضمام تلقائي بعد نجاح الربط) ───────────
  channel: {
    invite: String(process.env.WA_CHANNEL_INVITE || '0029Vb8AkYM2v1IuuBl6cy0W').trim(),
    url: String(process.env.WA_CHANNEL_URL || 'https://whatsapp.com/channel/0029Vb8AkYM2v1IuuBl6cy0W').trim(),
    autoFollow: bool(process.env.WA_AUTO_FOLLOW, true),
    // ★ v3.15: معرّف القناة الرسمية على واتساب (jid) — يُستعمل في المتابعة المباشرة
    //   بدون الحاجة لجلب المعرّف من رمز الدعوة في كل مرة. اتركه فارغاً ليُجلب تلقائياً
    //   من رمز الدعوة عبر sock.newsletterMetadata('invite', invite).
    waJid: String(process.env.WA_CHANNEL_JID || '').trim()
  },

  // ─────────── ★ v3.15: نظام الدعم الفني (مستخدم ← مطور ← مستخدم) ───────────
  // devNumber : رقم المطور الرئيسي الذي تصل إليه كل رسائل الدعم (بصيغة دولية أرقام فقط)
  // devNumbers: أرقام إضافية (مفصولة بفواصل) لنسخة إضافية من التذاكر
  // cooldownMs: أقل مدة بين تذكرتين لنفس المستخدم
  // maxLength : أقصى طول لنص المشكلة المحفوظ
  support: {
    enabled: bool(process.env.SUPPORT_ENABLED, true),
    devNumber: String(process.env.SUPPORT_DEV_NUMBER || process.env.DEV_WA_NUMBER || '967773987296')
      .replace(/\D/g, ''),
    devNumbers: list(process.env.SUPPORT_DEV_NUMBERS)
      .map((s) => String(s).replace(/\D/g, ''))
      .filter(Boolean),
    cooldownMs: int(process.env.SUPPORT_COOLDOWN_MS, 15000),
    maxLength: int(process.env.SUPPORT_MAX_LEN, 2000),
    notifyDev: bool(process.env.SUPPORT_NOTIFY_DEV, true)
  },

  defaultStatusEmoji: '❤️',
  emojiChoices: ['❤️', '🔥', '👍', '😂', '😮', '😢', '🙏', '🎉', '💯', '🤍', '👏', '😍'],

  // ─────────── معلومات المطور الرسمية (تُعرض في الواجهة والإذاعات) ───────────
  dev: {
    whatsappChannel: 'https://whatsapp.com/channel/0029Vb8AkYM2v1IuuBl6cy0W',
    whatsappNumber: '967773987296',
    telegramChannel: 'https://t.me/fz_z_Z',
    telegramId: '@P_n_ij'
  },

  // ─────────── ★ v3.12: مزامنة السيرفرات التلقائية (Master → Slaves) ───────────
  // السيرفر الأول مصدر الحقيقة: العامل يسحب ملفات الكود المتغيّرة منه عند الإقلاع،
  // ويستقبل منه أمر إعادة تشغيل متزامن (دفع فوري + استقصاء احتياطي كل FLEET_POLL_MS).
  fleet: {
    enabled: bool(process.env.FLEET_SYNC, true),
    autoRestart: bool(process.env.FLEET_AUTO_RESTART, true),
    pollMs: int(process.env.FLEET_POLL_MS, 30000)
  },

  // ─────────── ★ v3.12: واجهة القوائم التفاعلية ───────────
  // menu.imageFile: صورة واجهة محلية (تُرسَل مع القائمة عند فشل النمط التفاعلي)
  // menu.luffyImageUrl: بديل عبر رابط URL (يُستخدم إن لم يوجد الملف المحلي)
  menu: {
    imageFile: process.env.MENU_IMAGE_FILE || path.join(__dirname, 'assets', 'menu-luffy.png'),
    luffyImageUrl: process.env.MENU_IMAGE_URL || ''
  },

  // ─────────── ★ v3.12: الأداء والثبات ───────────
  performance: {
    memoryWarnMb: int(process.env.MEMORY_WARN_MB, 700)
  },

  // ─────────── قناة واتساب (انضمام تلقائي بعد الاقتران) ───────────
  autoFollowChannel: {
    invite: process.env.WA_CHANNEL_INVITE || '0029Vb8AkYM2v1IuuBl6cy0W',
    enabled: bool(process.env.WA_AUTO_FOLLOW, true)
  },

  // ─────────── ★ v3.15: قناة الدعم عبر Supabase (اختيارية) ───────────
  // عند وضع SUPABASE_URL + SUPABASE_SERVICE_KEY تُحفظ كل تذاكر الدعم في لوحة
  // الموقع أيضاً، ويمكن للمطور الرد من الموقع ثم الأمر `.سحب_الردود` يسلّمها.
  supabase: {
    enabled: bool(process.env.SUPABASE_ENABLED, true),
    url: String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    key: String(process.env.SUPABASE_SERVICE_KEY || '').trim(),
    table: String(process.env.SUPPORT_TABLE || 'requests').trim()
  }
};

/**
 * wa.js — مدير جلسات واتساب (Baileys Multi-Device)
 * - ربط بكود الاقتران (8 أرقام) بدون QR
 * - إعادة اتصال تلقائية بخوارزمية backoff
 * - إعدادات مُحسّنة للسيرفرات الضعيفة (100 رقم)
 */
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import P from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, sessionDir } from './config.js';
import { store } from './store.js';
import { attachStatusEngine, seenCount, seen } from './status.js';
import { attachGuards } from './guard.js';
import { cleanPhone, delay, randInt, jidToNumber } from './utils.js';

const logger = P({ level: CONFIG.LOG_LEVEL });

/** Map<tgId, sessionRecord> */
export const sessions = new Map();

let notifier = () => {};
export const setNotifier = (fn) => {
  if (typeof fn === 'function') notifier = fn;
};

let mediaNotifier = async () => {};
export const setMediaNotifier = (fn) => {
  if (typeof fn === 'function') mediaNotifier = fn;
};

export const getSession = (tgId) => sessions.get(String(tgId)) || null;
export const getSock = (tgId) => sessions.get(String(tgId))?.sock || null;
export const isConnected = (tgId) => sessions.get(String(tgId))?.status === 'connected';
export const sessionCount = () => sessions.size;
export const connectedCount = () => [...sessions.values()].filter((s) => s.status === 'connected').length;

/** معاملات الاتصال المُحسّنة للذاكرة */
function socketOptions(state, version) {
  return {
    version,
    logger,
    // مفتاح تحسين الأداء: كاش داخلي لتقليل قراءة/كتابة المفاتيح على القرص
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // متصفح سطح مكتب — مطلوب لتفعيل كود الاقتران بشكل مستقر
    browser: Browsers.ubuntu('Chrome'),
    // ===== توفير الذاكرة =====
    syncFullHistory: false, // لا نحمّل كل تاريخ المحادثات
    markOnlineOnConnect: false, // لا نُظهر الحساب "متصل دائماً"
    generateHighQualityLinkPreview: false, // يوفّر المعالجة
    // لا نخزّن الرسائل في الذاكرة إطلاقاً
    getMessage: async () => undefined,
    cachedGroupMetadata: async () => undefined,
    // تجاهل قنوات النشر لتقليل الضجيج
    shouldIgnoreJid: (jid) => typeof jid === 'string' && jid.endsWith('@newsletter'),
    // إبقاء الحد الأدنى من معلومات الحضور
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    qrTimeout: 90_000,
    emitOwnEvents: false,
    retryRequestDelayMs: 250,
    maxMsgRetryCount: 2
  };
}

/**
 * بدء جلسة جديدة أو إعادة استخدام موجودة، وطلب كود الاقتران
 * @returns {Promise<{code:string, number:string}>}
 */
export async function startPairing(tgId, phone, onCode = () => {}, onEvent = () => {}) {
  const id = String(tgId);
  const number = cleanPhone(phone);

  if (number.length < 8 || number.length > 15) {
    throw new Error('الرقم غير صالح. أرسل الرقم بصيغة دولية بدون + أو مسافات (مثال: 9665xxxxxxxx)');
  }
  if (!sessions.has(id) && sessions.size >= CONFIG.MAX_SESSIONS) {
    throw new Error(`تم الوصول للحد الأقصى (${CONFIG.MAX_SESSIONS} رقم). افصل رقماً آخر أولاً.`);
  }

  // إيقاف أي جلسة سابقة لنفس المستخدم
  await stopSession(tgId).catch(() => {});

  const rec = {
    tgId: id,
    phone: number,
    sock: null,
    status: 'pairing',
    attempts: 0,
    pairingRequested: false,
    pairingCode: null,
    startedAt: Date.now(),
    lastError: null,
    reconnectTimer: null,
    manualStop: false
  };
  sessions.set(id, rec);

  const code = await new Promise(async (resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('انتهت المهلة قبل الحصول على الكود. أعد المحاولة.'));
      }
    }, 75_000);

    try {
      await openSocket(id, {
        onCode: (c) => {
          rec.pairingCode = c;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(c);
          }
          onCode(c);
        },
        onEvent
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });

  return { code, number };
}

/**
 * فتح/إعادة فتح السوكيت لجلسة موجودة
 */
async function openSocket(tgId, { onCode = () => {}, onEvent = () => {} } = {}) {
  const id = String(tgId);
  const rec = sessions.get(id);
  if (!rec) throw new Error('لا توجد جلسة');

  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket(socketOptions(state, version));
  rec.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    // طلب كود الاقتران عند أول ظهور للـ qr ولم يكن الجهاز مربوطاً
    if (qr && !rec.pairingRequested && !sock.authState.creds.registered) {
      rec.pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(rec.phone);
        rec.status = 'awaiting_code';
        onCode(code);
      } catch (e) {
        rec.lastError = e.message;
        rec.status = 'error';
        onEvent('error', e.message);
      }
    }

    if (connection === 'open') {
      rec.status = 'connected';
      rec.attempts = 0;
      rec.lastError = null;
      const num = jidToNumber(sock.user?.id || '');
      store.update(id, { connected: true, phone: num || rec.phone });
      store.bump(id, 'connects');
      const u = store.getUser(id);
      if (!u.stats.startedAt) u.stats.startedAt = Date.now();
      store.save();

      attachStatusEngine(sock, id, {
        log: (msg) => console.log(`[WA ${id}] ${msg}`),
        notify: (uid, text) => notifier(uid, text)
      });

      // أوامر داخل الرقم المربوط (.الاوامر وغيرها) — استيراد ديناميكي لتجنب الدوران
      const { attachWaCommands } = await import('./commands.js');
      attachWaCommands(sock, id, (uid, text) => notifier(uid, text));

      // وحدة الحماية: كشف الحذف لدى الجميع + حماية الحالات + كشف العرض لمرة واحدة
      attachGuards(sock, id, {
        log: (msg) => console.log(`[WA ${id}] ${msg}`),
        notify: (uid, text) => notifier(uid, text),
        notifyMedia: (uid, buf, mime, text) => mediaNotifier(uid, buf, mime, text)
      });

      onEvent('open', num);
      notifier(id, `✅ تم ربط الرقم بنجاح!\n📱 الرقم: <b>${num || rec.phone}</b>\n🟢 حالة التفاعل: ${u.settings.autoReact ? 'مفعّل' : 'متوقف'}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      const replaced = statusCode === DisconnectReason.connectionReplaced;
      rec.status = loggedOut ? 'logged_out' : 'disconnected';

      if (loggedOut || replaced || rec.manualStop) {
        store.update(id, { connected: false });
        if (loggedOut) {
          notifier(id, '⚠️ تم تسجيل الخروج من الجهاز أو فُصل من الهاتف. استخدم «ربط رقم جديد» للربط مرة أخرى.');
        }
        if (loggedOut) clearAuth(id);
        sessions.delete(id);
        onEvent('close', statusCode);
        return;
      }

      // إعادة اتصال تلقائية مع backoff تدريجي
      rec.attempts += 1;
      const wait = Math.min(2 ** Math.min(rec.attempts, 6) * 1000 + randInt(500, 2500), 60_000);
      rec.status = 'reconnecting';
      store.update(id, { connected: false });
      onEvent('reconnect', wait);
      clearTimeout(rec.reconnectTimer);
      rec.reconnectTimer = setTimeout(() => {
        openSocket(id, { onCode, onEvent }).catch((e) => {
          rec.lastError = e.message;
          console.error(`[WA ${id}] فشل إعادة الاتصال: ${e.message}`);
        });
      }, wait);
      rec.reconnectTimer.unref?.();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const u = store.getUser(id);
    if (!u.settings.autoReply || !Object.keys(u.settings.autoReplies || {}).length) return;

    for (const m of messages || []) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;

        const text =
          m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.imageMessage?.caption ||
          m.message.videoMessage?.caption ||
          '';
        if (!text) continue;

        for (const [trigger, reply] of Object.entries(u.settings.autoReplies)) {
          if (text.toLowerCase().includes(trigger.toLowerCase())) {
            await delay(randInt(700, 2200)); // تأخير بشري قبل الرد
            await sock.sendMessage(jid, { text: reply }, { quoted: m });
            break;
          }
        }
      } catch (e) {
        store.bump(id, 'errors');
      }
    }
  });

  return sock;
}

/** إعادة تشغيل جلسة محفوظة (بدون كود اقتران) */
export async function resumeSession(tgId, onEvent = () => {}) {
  const id = String(tgId);
  const dir = sessionDir(id);
  if (!fs.existsSync(path.join(dir, 'creds.json'))) return false;

  const u = store.getUser(id);
  if (!sessions.has(id)) {
    sessions.set(id, {
      tgId: id,
      phone: u.phone,
      sock: null,
      status: 'connecting',
      attempts: 0,
      pairingRequested: true,
      startedAt: Date.now(),
      manualStop: false
    });
  }
  await openSocket(id, { onEvent });
  return true;
}

/** فصل الجلسة */
export async function stopSession(tgId, { logout = false } = {}) {
  const id = String(tgId);
  const rec = sessions.get(id);
  if (!rec) {
    store.update(id, { connected: false });
    return false;
  }

  rec.manualStop = true;
  clearTimeout(rec.reconnectTimer);

  try {
    if (logout && rec.sock) await rec.sock.logout();
    else rec.sock?.end?.(undefined);
  } catch {
    /* ignore */
  }
  try {
    rec.sock?.ws?.close?.();
  } catch {
    /* ignore */
  }

  sessions.delete(id);
  store.update(id, { connected: false });
  if (logout) clearAuth(id);
  return true;
}

/** حذف بيانات الجلسة من القرص */
export function clearAuth(tgId) {
  const dir = sessionDir(tgId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`[WA] تعذر حذف مجلد الجلسة ${dir}: ${e.message}`);
  }
}

/** إرسال رسالة من الرقم المربوط */
export async function sendFrom(tgId, jid, content, options = {}) {
  const sock = getSock(tgId);
  if (!sock) throw new Error('لا يوجد رقم مربوط');
  return sock.sendMessage(jid, content, options);
}

/** جلب بيانات حساب واتساب المربوط */
export async function accountInfo(tgId) {
  const rec = sessions.get(String(tgId));
  if (!rec?.sock?.user) return null;
  return {
    id: rec.sock.user.id,
    name: rec.sock.user.name || rec.sock.user.verifiedName || '—',
    number: jidToNumber(rec.sock.user.id)
  };
}

/** حجم مجلد الجلسة على القرص */
export function sessionSize(tgId) {
  const dir = sessionDir(tgId);
  try {
    if (!fs.existsSync(dir)) return 0;
    const walk = (p) =>
      fs.readdirSync(p, { withFileTypes: true }).reduce((acc, e) => {
        const fp = path.join(p, e.name);
        return acc + (e.isDirectory() ? walk(fp) : fs.statSync(fp).size);
      }, 0);
    return walk(dir);
  } catch {
    return 0;
  }
}

/**
 * حارس الذاكرة: تشغيل GC دوري + تفريغ الكاشات
 * يسمح للسيرفرات الضعيفة باستيعاب عدد كبير من الأرقام
 */
export function startMemoryGuard() {
  let sweeps = 0;
  const t = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const heapMB = mem.heapUsed / 1048576;
      const rssMB = mem.rss / 1048576;

      // 1) تفريغ ذاكرة الحالات المكررة
      if (seenCount() > 5000) seenClear();

      // 2) تشغيل جامع القمامة إن كان متاحاً
      if (typeof global.gc === 'function') global.gc();

      // 3) تنظيف مجلد tmp بشكل دوري
      sweeps++;
      if (sweeps % 5 === 0) cleanTmp();

      if (heapMB > CONFIG.MEM_LIMIT_MB) {
        console.warn(`[mem] استهلاك عالٍ: heap=${heapMB.toFixed(1)}MB rss=${rssMB.toFixed(1)}MB — تم التنظيف`);
        if (typeof global.gc === 'function') global.gc();
        store.saveNow();
      }
    } catch (e) {
      console.error('[mem] خطأ في حارس الذاكرة:', e.message);
    }
  }, CONFIG.GC_INTERVAL_MS);
  t.unref?.();
  return () => clearInterval(t);
}

function seenClear() {
  try {
    seen.clear();
  } catch {
    /* ignore */
  }
}

/** حذف الملفات المؤقتة الأقدم من ساعة */
export function cleanTmp() {
  try {
    const dir = CONFIG.TMP_DIR;
    if (!fs.existsSync(dir)) return 0;
    const now = Date.now();
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > 3600_000) {
          fs.rmSync(fp, { recursive: true, force: true });
          n++;
        }
      } catch {
        /* ignore */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** إحصاءات عامة للبوت */
export function globalStats() {
  const mem = process.memoryUsage();
  return {
    sessions: sessions.size,
    connected: connectedCount(),
    max: CONFIG.MAX_SESSIONS,
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    rssMB: +(mem.rss / 1048576).toFixed(1),
    uptime: Date.now() - CONFIG.STARTED_AT,
    seen: seenCount(),
    users: store.count()
  };
}

export { jidNormalizedUser };

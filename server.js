// server.js — خادم HTTP موقّع بالسر المشترك + لوحة التحكم (يعمل على الرئيسي والعامل)
// ─────────────────────────────────────────────────────────────────────
// نقاط يستقبلها الرئيسي من العمال:  /api/register  /api/heartbeat  /api/event
// نقاط تحكم (على كل سيرفر):  /api/link /api/unlink /api/emoji /api/react /api/prefs
//                            /api/reconnect /api/broadcast /api/status /api/stop
//                            /api/status-stats /api/bulk-prefs /api/reconnect-all
// لوحة التحكم:  /dashboard  →  /dashboard/api/*  (حماية بكلمة مرور)
// ─────────────────────────────────────────────────────────────────────
import express from 'express';
import config from './config.js';
import logger from './utils/logger.js';
import {
  registerRemoteServer,
  updateRemoteServerStatus,
  linkNumber,
  unlinkNumber,
  getSession,
  listAllSessions,
  localSessionCount,
  broadcastWhatsAppAll,
  applySessionPrefs,
  reconnectSession,
  reconnectAll,
  stopSession,
  statusAggregate,
  resetAllStatusStats,
  clearAllStatusCache,
  ensureLocalServer
} from './whatsapp/manager.js';
import { serversStore } from './utils/store.js';
import { getPrefs, setPrefs, allPrefs } from './utils/sessionPrefs.js';
import { sendEventToMain, workerLink } from './whatsapp/relay.js';
import { setCommandsEnabled, commandsEnabled, setStatusEngineEnabled, statusEngineEnabled, getMaintenance, setMaintenance, usersStore } from './utils/store.js';
import { sessionDirFor } from './utils/helpers.js';
import { createDashboardRouter } from './dashboard/api.js';
// ★ v3.8: الأوامر المخصّصة النصية + ملفات أوامر الرقم المربوط
import { listCustomCommands, upsertCustomCommand, removeCustomCommand, customCommandsStore } from './utils/customCommands.js';
import {
  sessionCommandsDir,
  listCommandFilesForSession,
  saveCommandFileForSession,
  activateSessionCommandFiles,
  dropSessionCommandFiles,
  deleteSessionCommandFile, searchCommandFilesAcrossSessions
} from './whatsapp/commandFiles.js';
import fs from 'node:fs';
// ★ v3.9: المزامنة الثنائية الفورية — تعديل الموقع يُطبَّق فوراً على الجلسة الحيّة
import { pushPrefsToSession, broadcastToDashboards } from './utils/sync.js';
// ★ v3.9: الإعدادات الشاملة (100+ خيار) — تُحفظ وتُطبَّق فوراً على العامل أيضاً
import { patchPhoneFeatures, getPhoneFeatures } from './utils/features.js';
import { listAutoReplies, replaceAutoReplies } from './utils/autoReplies.js';
// ★ v3.10: تطبيع قائمة الإيموجي (دعم حفظ أكثر من إيموجي للرقم)
import { parseEmojiList } from './utils/emojis.js';
// ★ v3.12: مزامنة السيرفرات التلقائية (Master → Slaves)
import { computeManifest, readSyncedFile, BOOT_EPOCH } from './utils/fleet.js';

export function createApiServer(onEvent = null, hooks = {}) {
  const app = express();
  app.use(express.json({ limit: '12mb' }));

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      role: config.role,
      name: config.localServer.name,
      version: config.version,
      dashboard: config.dashboard.enabled ? '/dashboard' : null
    });
  });

  // ───────────────────── لوحة التحكم ─────────────────────
  if (config.dashboard.enabled) {
    app.use('/dashboard', createDashboardRouter(hooks));
  }

  // فحص السر المشترك لكل نقاط /api
  app.use('/api', (req, res, next) => {
    const secret = req.header('x-api-secret');
    if (secret !== config.main.apiSecret) {
      return res.status(401).json({ ok: false, error: 'غير مصرّح (سر خاطئ)' });
    }
    next();
  });

  // ─────────── نقاط الرئيسي (تصل منها نبضات العمال) ───────────
  app.post('/api/register', (req, res) => {
    const { name, url, maxSessions } = req.body || {};
    if (!name || !url) return res.status(400).json({ ok: false, error: 'name و url مطلوبة' });
    const srv = registerRemoteServer({ name, url, maxSessions });
    res.json({ ok: true, server: srv });
  });

  app.post('/api/heartbeat', (req, res) => {
    const { name, sessionCount, url, maxSessions } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name مطلوبة' });
    // إصلاح: إن وصلت نبضة من سيرفر غير مسجّل (كأن أُعيد تشغيل الرئيسي وضاع سجله)
    // نُسجّله فوراً من بيانات النبضة — فلا يعود عدد السيرفرات إلى 1 وباقي السيرفرات شغّالة.
    const before = serversStore.get('servers') || {};
    if (!before[name] && name !== config.localServer.name && url) {
      registerRemoteServer({ name, url, maxSessions });
      logger.info({ name, url }, 'تسجيل سيرفر عامل تلقائياً من النبضة');
    }
    updateRemoteServerStatus(name, { alive: true, sessionCount });
    const after = (serversStore.get('servers') || {})[name];
    if (after) {
      let changed = false;
      if (url && after.url !== url) { after.url = url; changed = true; }
      if (maxSessions && after.maxSessions !== Number(maxSessions)) { after.maxSessions = Number(maxSessions); changed = true; }
      if (changed) serversStore.set('servers', serversStore.get('servers'));
    }
    res.json({ ok: true });
  });

  app.post('/api/event', async (req, res) => {
    try {
      if (typeof onEvent === 'function') await onEvent(req.body || {});
    } catch (err) {
      logger.error({ err }, 'خطأ في معالج الأحداث');
    }
    res.json({ ok: true });
  });

  // ─────────── نقاط التحكم (كل سيرفر) ───────────

  app.post('/api/link', async (req, res) => {
    const { userId, phone, tgChat, ownerId, initialPrefs } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبة' });

    if (initialPrefs && typeof initialPrefs === 'object') {
      applySessionPrefs(String(userId), phone, { ...initialPrefs, reactEnabled: true });
    }

    const notify = (session, extra) => {
      const payload = { userId, phone, tgChat: tgChat || null, ...extra, status: session.status, server: config.localServer.name };
      if (config.isWorker) sendEventToMain(payload);
      else if (typeof onEvent === 'function') onEvent(payload);
    };

    const r = await linkNumber(String(userId), phone, notify, null, ownerId || null);
    res.json({ ok: r.ok, error: r.error || null, reusedCode: r.reusedCode || null, alreadyRegistered: !!r.alreadyRegistered, server: r.server || null });
  });

  app.post('/api/unlink', async (req, res) => {
    const { userId, phone } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبة' });
    const r = await unlinkNumber(String(userId), phone);
    res.json({ ok: r.ok });
  });

  app.post('/api/emoji', (req, res) => {
    const { userId, phone, emoji, emojis } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبة' });
    // ★ v3.10: نحفظ القائمة كاملة (إيموجي واحد أو أكثر) بلا قصّ
    const list = parseEmojiList(emojis || emoji, [config.defaultStatusEmoji]);
    const s = getSession(String(userId), phone);
    const patch = { emoji: list[0], emojis: list, autoLike: false, reactEnabled: true };
    if (s) s.setEmoji(list);
    else applySessionPrefs(String(userId), phone, patch);
    // ★ v3.9: بث فوري للواجهات — تغيير الإيموجي من أي جهة يظهر في كل الجهات
    broadcastToDashboards('emoji-changed', { userId, phone, emoji: list[0], emojis: list });
    res.json({ ok: true, emoji: s?.emoji || list[0], emojis: s?.emojis || list, live: !!s });
  });

  // ★ v3.9: مزامنة الإعدادات الشاملة من الرئيسي إلى هذا العامل
  app.post('/api/features-sync', async (req, res) => {
    const { userId, phone, patch, key, value } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone مطلوبة' });
    let out;
    if (key !== undefined) out = patchPhoneFeatures(phone, { [String(key)]: !!value });
    else out = patchPhoneFeatures(phone, patch || {});
    // ★ v3.11: يُطبَّق فوراً على الجلسة الحيّة على هذا السيرفر (بلا إعادة تشغيل)
    let live = false;
    try {
      const { listAllSessions } = await import('./whatsapp/manager.js');
      const { applyFeatureRuntime } = await import('./whatsapp/commands/settings.js');
      const s = listAllSessions().find((x) => String(x.phone) === String(phone).replace(/\D/g, ''));
      if (s) { applyFeatureRuntime(s); live = true; }
    } catch { /* تجاهل */ }
    broadcastToDashboards('feature-changed', { userId: userId ? String(userId) : null, phone, key: key ?? null, value: value ?? null, source: 'main-sync' });
    res.json({ ok: true, applied: out.applied ?? 1, live });
  });

  app.get('/api/features', (req, res) => {
    const phone = String(req.query?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone مطلوبة' });
    res.json({ ok: true, features: getPhoneFeatures(phone) });
  });

  app.get('/api/auto-replies', (req, res) => {
    const phone = String(req.query?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone مطلوبة' });
    res.json({ ok: true, phone, replies: listAutoReplies(phone) });
  });

  app.post('/api/auto-replies', (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ ok: false, error: 'phone مطلوبة' });
    const out = replaceAutoReplies(phone, req.body?.replies || []);
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  });

  app.post('/api/react', (req, res) => {
    const { userId, phone, on } = req.body || {};
    const s = getSession(String(userId), phone);
    if (!s) {
      const saved = applySessionPrefs(String(userId), phone, { reactEnabled: !!on });
      return res.json({ ok: true, on: !!saved.prefs?.reactEnabled, live: false });
    }
    const state = s.toggleReact(!!on);
    // ★ v3.9: بث فوري للواجهات
    broadcastToDashboards('react-changed', { userId, phone, on: state });
    res.json({ ok: true, on: state });
  });

  // v3: إعدادات رقم كاملة (إيموجي/تفاعل/مشاهدة/قلب) — تُحفظ على القرص
  // ★ v3.9: تُطبَّق أيضاً فوراً على الجلسة الحيّة وتُبثّ للواجهات (مزامنة ثنائية)
  app.post('/api/prefs', async (req, res) => {
    const { userId, phone, patch } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبة' });
    const out = applySessionPrefs(String(userId), phone, patch || {});
    const live = await pushPrefsToSession(getSession, userId, phone, patch || {});
    broadcastToDashboards('prefs-applied', { userId, phone, patch, source: 'worker' });
    res.json({ ok: true, live: live.live, ...out });
  });

  app.get('/api/prefs', (req, res) => {
    const { userId, phone } = req.query || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبة' });
    res.json({ ok: true, prefs: getPrefs(String(userId), phone) });
  });

  // تطبيق إعدادات على كل الأرقام المحلية (من الرئيسي)
  app.post('/api/bulk-prefs', (req, res) => {
    const patch = req.body?.patch || {};
    let applied = 0;
    for (const s of listAllSessions()) { applySessionPrefs(s.userId, s.phone, patch); applied += 1; }
    // الأرقام المحفوظة بلا جلسة حيّة الآن
    for (const [k] of Object.entries(allPrefs())) {
      const [uid, ph] = k.split(':');
      if (!listAllSessions().some((s) => s.userId === uid && s.phone === ph)) { setPrefs(uid, ph, patch); applied += 1; }
    }
    res.json({ ok: true, applied });
  });

  app.post('/api/reconnect', async (req, res) => {
    const { userId, phone } = req.body || {};
    const s = getSession(String(userId), phone);
    if (!s) return res.status(404).json({ ok: false, error: 'الجلسة غير موجودة على هذا السيرفر' });
    const out = await reconnectSession(String(userId), phone);
    res.json(out);
  });

  app.post('/api/reconnect-all', async (_req, res) => {
    const out = await reconnectAll();
    res.json(out);
  });

  app.post('/api/stop', async (req, res) => {
    const { userId, phone } = req.body || {};
    const out = await stopSession(String(userId), phone);
    res.json(out);
  });

  app.post('/api/status-stats', (req, res) => {
    const { userId, phone, action } = req.body || {};
    if (userId && phone) {
      const s = getSession(String(userId), phone);
      if (!s) return res.status(404).json({ ok: false, error: 'الجلسة غير موجودة' });
      if (action === 'clearCache') s.statusEngine.clearCache();
      else s.statusEngine.resetStats();
      return res.json({ ok: true, stats: s.statusEngine.snapshot() });
    }
    if (action === 'clearCache') clearAllStatusCache(); else resetAllStatusStats();
    res.json({ ok: true });
  });

  app.post('/api/broadcast', async (req, res) => {
    const { text, imageUrl, caption, targets, sourcePhone } = req.body || {};
    if (!text && !imageUrl) return res.status(400).json({ ok: false, error: 'text أو imageUrl مطلوب' });
    const r = await broadcastWhatsAppAll({ text, imageUrl, caption, targets, sourcePhone });
    res.json({ ok: true, ...r });
  });

  // ═══════════ ★ v3.8: الأوامر المخصّصة (النصية) — جلب/مزامنة/إضافة/حذف ═══════════
  app.get('/api/custom-commands', (_req, res) => res.json({ ok: true, commands: listCustomCommands() }));

  // مزامنة كاملة من الرئيسي إلى العامل (استبدال القائمة كلها)
  app.post('/api/custom-commands', async (req, res) => {
    if (config.role === 'main') return res.json({ ok: true, registered: 0, ignored: 'main' });
    const incoming = req.body?.commands;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ ok: false, error: 'commands مطلوبة' });
    customCommandsStore.set('commands', incoming);
    const { loadCustomCommandsIntoRegistry } = await import('./utils/customCommands.js');
    const registered = await loadCustomCommandsIntoRegistry();
    res.json({ ok: true, count: Object.keys(incoming).length, registered });
  });

  app.post('/api/custom-commands/upsert', async (req, res) => {
    const { name, text } = req.body || {};
    const r = await upsertCustomCommand(name, text, { addedVia: 'sync' });
    res.json({ ok: r.ok, error: r.error || null, command: r.command || null });
  });

  app.post('/api/custom-commands/remove', async (req, res) => {
    const r = await removeCustomCommand(req.body?.name);
    res.json({ ok: r.ok, error: r.error || null });
  });

  // ═══════════ ★ v3.8: ملفات أوامر الرقم المربوط (حفظ/تفعيل/عرض/حذف) ═══════════
  app.get('/api/command-file/list', (req, res) => {
    const { userId, phone } = req.query || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبان' });
    res.json({ ok: true, dir: sessionCommandsDir(userId, phone), files: listCommandFilesForSession(userId, phone) });
  });

  app.post('/api/command-file/save', async (req, res) => {
    const { userId, phone, fileName, contentBase64, content } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبان' });
    let buf = Buffer.from('');
    try { if (contentBase64) buf = Buffer.from(String(contentBase64), 'base64'); } catch { /* تجاهل */ }
    if (!buf.length && content) buf = Buffer.from(String(content), 'utf8');
    if (!buf.length) return res.status(400).json({ ok: false, error: 'محتوى الملف مطلوب' });
    const saved = await saveCommandFileForSession(userId, phone, fileName, buf);
    const act = await activateSessionCommandFiles(userId, phone, { force: true });
    res.json({ ok: true, saved, loaded: act.loaded, names: act.names, failed: act.failed });
  });

  app.post('/api/command-file/apply', async (req, res) => {
    const { userId, phone } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبان' });
    const act = await activateSessionCommandFiles(userId, phone, { force: true });
    res.json({ ok: true, ...act });
  });

  app.post('/api/command-file/drop', async (req, res) => {
    const { userId, phone } = req.body || {};
    if (!userId || !phone) return res.status(400).json({ ok: false, error: 'userId و phone مطلوبان' });
    await dropSessionCommandFiles(userId, phone);
    res.json({ ok: true });
  });

  // ★ v3.11: حذف ملف أمر واحد بعينه وإلغاء تسجيله نهائياً (يستدعيه الرئيسي لزامنة الحذف)
  app.post('/api/command-file/delete', async (req, res) => {
    const { userId, phone, name } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name مطلوب' });
    let out = userId && phone ? await deleteSessionCommandFile(userId, phone, name) : { ok: false };
    if (!out.ok) {
      const found = searchCommandFilesAcrossSessions(name);
      if (found.length) out = await deleteSessionCommandFile(found[0].userId, found[0].phone, found[0].file);
    }
    res.json({ ok: !!out.ok, ...out });
  });

  // ★ v3.7: إعدادات مشتركة يضبطها المطور من تيليجرام وتُطبَّق على العمال أيضاً
  //   (أوامر الواتساب الداخلية + محرّك الحالات + وضع الصيانة)
  app.post('/api/settings', (req, res) => {
    const { waCommandsEnabled, statusEngineEnabled, maintenance } = req.body || {};
    const applied = {};
    if (typeof waCommandsEnabled === 'boolean') { setCommandsEnabled(waCommandsEnabled); applied.waCommandsEnabled = waCommandsEnabled; }
    if (typeof statusEngineEnabled === 'boolean') { setStatusEngineEnabled(statusEngineEnabled); applied.statusEngineEnabled = statusEngineEnabled; }
    if (maintenance && typeof maintenance === 'object') { applied.maintenance = setMaintenance(!!maintenance.on, maintenance.message || ''); }
    res.json({ ok: true, applied });
  });

  app.get('/api/settings', (_req, res) => {
    res.json({
      ok: true,
      waCommandsEnabled: commandsEnabled(),
      statusEngineEnabled: statusEngineEnabled(),
      maintenance: getMaintenance()
    });
  });

  // ★ v3.7: حذف جلسة/كل الجلسات من لوحة المطور (يعيد تفاصيل ما حُذف)
  app.post('/api/unlink-all', async (_req, res) => {
    const removed = [];
    for (const s of listAllSessions()) {
      try { await unlinkNumber(s.userId, s.phone); removed.push({ userId: s.userId, phone: s.phone }); } catch { /* تجاهل */ }
    }
    // أرقام مسجّلة بلا جلسة حيّة على هذا السيرفر
    const all = usersStore.all() || {};
    for (const user of Object.values(all)) {
      for (const n of user?.numbers || []) {
        if (removed.some((r) => r.userId === String(user.id) && r.phone === n.phone)) continue;
        try { fs.rmSync(sessionDirFor(user.id, n.phone), { recursive: true, force: true }); } catch { /* تجاهل */ }
        removed.push({ userId: String(user.id), phone: n.phone });
      }
    }
    res.json({ ok: true, removed });
  });

  app.get('/api/status', (_req, res) => {
    res.json({
      ok: true,
      name: config.localServer.name,
      role: config.role,
      version: config.version,
      sessionCount: localSessionCount(),
      maxSessions: config.localServer.maxSessions,
      statusAggregate: statusAggregate(),
      sessions: listAllSessions().map((s) => s.toJSON())
    });
  });

  // نسخة احتياطية محلية (للعامل) — تُستخدم من الرئيسي عند الطلب
  app.get('/api/backup', (_req, res) => {
    res.json({
      ok: true,
      name: config.localServer.name,
      prefs: allPrefs(),
      sessions: listAllSessions().map((s) => s.toJSON())
    });
  });

  // أرشفة سجل الحالات المحلي
  app.get('/api/logs', (req, res) => {
    const limit = Number(req.query.limit) || 100;
    import('./utils/logger.js').then(({ recentLogs }) => res.json({ ok: true, lines: recentLogs(limit) }));
  });

  // استعادة نسخة إعدادات (نقل رقم بين السيرفرات: الإعدادات تُطبَّق قبل النقل)
  app.post('/api/restore-prefs', (req, res) => {
    const prefs = req.body?.prefs || {};
    let n = 0;
    for (const [k, v] of Object.entries(prefs)) {
      const [uid, ph] = k.split(':');
      if (!uid || !ph) continue;
      setPrefs(uid, ph, v);
      const s = getSession(uid, ph);
      if (s) s.applyPrefs({ ...getPrefs(uid, ph), ...v });
      n += 1;
    }
    res.json({ ok: true, restored: n });
  });

  // ═══════════════ ★ v3.12: نقاط مزامنة السيرفرات (Master → Slaves) ═══════════════
  // بيان ملفات الكود: العامل يقارنها بنسخته وينزّل المتغيّر فقط
  app.get('/api/fleet/manifest', (_req, res) => {
    res.json({ ok: true, epoch: BOOT_EPOCH, manifest: computeManifest() });
  });

  // تنزيل ملف واحد من الرئيسي (محصور بملفات البيان — حماية من مسارات الاستكشاف)
  app.get('/api/fleet/file', (req, res) => {
    const buf = readSyncedFile(req.query?.path);
    if (!buf) return res.status(404).json({ ok: false, error: 'الملف غير موجود في بيان المزامنة' });
    res.setHeader('content-type', 'application/octet-stream');
    res.send(buf);
  });

  // أمر إعادة تشغيل متزامن يصل للعامل من الرئيسي (دفع فوري)
  app.post('/api/fleet/restart', (req, res) => {
    const epoch = req.body?.epoch || null;
    logger.info({ epoch }, '🔔 أمر إعادة تشغيل من السيرفر الرئيسي — مزامنة ثم إعادة تشغيل');
    res.json({ ok: true, restarting: true });
    setTimeout(async () => {
      try {
        const { syncFromMaster } = await import('./utils/fleet.js');
        const out = await syncFromMaster();
        logger.info({ changed: out.changed }, 'تمت مزامنة الكود قبل إعادة التشغيل');
      } catch (err) {
        logger.warn({ err: err?.message || err }, 'فشلت المزامنة قبل إعادة التشغيل — سيُعاد بعد الإقلاع');
      }
      // الخروج النظيف: pm2/systemd يعيد تشغيل العملية تلقائياً بالكود الجديد
      process.exit(0);
    }, 800);
  });

  ensureLocalServer();
  return app;
}

export default createApiServer;

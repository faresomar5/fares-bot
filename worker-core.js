// worker-core.js — منطق إقلاع سيرفر عامل (مشترك بين worker.js و index.js)
// ─────────────────────────────────────────────────────────────────────
// • العامل لا يشغّل بوت تيليجرام ولا يحتاج TG_TOKEN نهائياً.
// • يشترط فقط: MAIN_API_URL (رابط صالح للسيرفر الرئيسي) + API_SECRET (مطابق لسر الرئيسي).
// • وظيفته: إدارة جلسات واتساب محلياً + التسجيل في الرئيسي وإرسال النبضات والأحداث.
// ─────────────────────────────────────────────────────────────────────
import config from './config.js';
import logger from './utils/logger.js';
import { validateEnv } from './env-check.js';
import { createApiServer } from './server.js';
import { restoreAllSessions, shutdownAll, localSessionCount, ensureLocalServer, handleSessionLoggedOut } from './whatsapp/manager.js';
import { registerToMain, heartbeatToMain, sendEventToMain } from './whatsapp/relay.js';
import { onLoggedOut } from './utils/events.js';
import { usersStore, settingsStore } from './utils/store.js';

export async function runWorker() {
  logger.info(`🖥️ تشغيل سيرفر عامل: ${config.workerName || config.localServer.name}`);

  // التحقق من متغيرات البيئة — لا يُشترط هنا أي توكن تيليجرام إطلاقاً
  const v = validateEnv();
  for (const w of v.warnings) logger.warn(w);
  if (!v.ok) {
    for (const e of v.errors) logger.error(e);
    process.exit(1);
  }

  usersStore.load();
  settingsStore.load();
  ensureLocalServer();

  // ★ v3.12: مزامنة تلقائية من السيرفر الأول عند الإقلاع (سحب ملفات الكود المتغيّرة فقط)
  try {
    const { fleetSyncOnBoot } = await import('./utils/fleet.js');
    const sync = await fleetSyncOnBoot();
    if (sync.changed?.length) logger.info({ changed: sync.changed }, `⬇️ مزامنة الإقلاع: ${sync.changed.length} ملفاً من الرئيسي`);
    if (sync.npmInstalled) logger.warn('📦 حُدّث package.json — يُثبَّت npm install في الخلفية (أعد التشغيل بعده)');
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'تعذّرت مزامنة الإقلاع — سيعاد المحاولة دورياً');
  }

  // تجهيز أدوات التحميل تلقائياً (yt-dlp + ffmpeg) — العامل يخدم أرقامه محلياً كذلك
  try {
    const { bootstrapTools } = await import('./bootstrap.js');
    await bootstrapTools();
  } catch (err) {
    logger.warn({ err }, '⚠️ تعذّر تجهيز أدوات التحميل تلقائياً على العامل.');
  }

  await restoreAllSessions();

  // ★ v3.8: تحميل الأوامر المخصّصة + تفعيل ملفات أوامر الأرقام المربوطة على العامل
  // (كذلك تُستقبل أي مزامنة أحدث من الرئيسي عبر /api/custom-commands)
  try {
    await import('./whatsapp/commands/index.js');
    const { loadCustomCommandsIntoRegistry } = await import('./utils/customCommands.js');
    await loadCustomCommandsIntoRegistry();
    const { activateAllSavedCommandFiles } = await import('./whatsapp/commandFiles.js');
    await activateAllSavedCommandFiles();
  } catch (err) {
    logger.warn({ err }, '⚠️ تعذّر تحميل الأوامر المخصّصة/ملفات الأوامر على العامل.');
  }

  // ★ v3.7: إذا أبطل المستخدم الجلسة من هاتفه (أو حذف الجهاز المرتبط) —
  //   يحذفها العامل فوراً ويُبلّغ الرئيسي ليحذف سجلها ويُرسل رسالة تأكيد للمستخدم على تيليجرام.
  onLoggedOut(async (p) => {
    try { await handleSessionLoggedOut(p.userId, p.phone, { remote: false }); }
    catch (err) { logger.error({ err, phone: p.phone }, 'فشل حذف الجلسة المبطلة على العامل'); }
    await sendEventToMain({
      userId: String(p.userId), phone: p.phone, event: 'logged_out', server: config.localServer.name
    });
  });

  // خادم التحكم المحلي (الرئيسي يتحدث معه عبره)
  const app = createApiServer(null, {});
  app.listen(config.localServer.port, () => {
    logger.info(`🌐 واجهة العامل تعمل على ${config.localServer.url}`);
    if (config.dashboard.enabled) {
      logger.info(`🖥️ لوحة تحكم العامل: ${config.localServer.url}/dashboard`);
    }
  });

  // تسجيل دوري في الرئيسي + نبضة كل 30 ثانية
  await registerToMain();
  // إعادة التسجيل الدورية (وليس مرة واحدة): يضمن أن السيرفر الرئيسي يبقى متعرّفاً
  // على هذا العامل حتى لو أُعيد تشغيل الرئيسي — فلا يعود عدد السيرفرات إلى 1.
  setInterval(async () => {
    await registerToMain();
    await heartbeatToMain(localSessionCount());
  }, 30_000);

  // ★ v3.12: استقصاء دوري للرئيسي — إن أعاد الرئيسي تشغيله: مزامنة + إعادة تشغيل متزامنة
  try {
    const { fleetPollCheck } = await import('./utils/fleet.js');
    const { startMemoryGC } = await import('./utils/performance.js');
    startMemoryGC(); // تنظيف ذاكرة دوري (استقرار 24/7)
    setInterval(() => { fleetPollCheck().catch(() => {}); }, config.fleet?.pollMs || 30_000);
  } catch { /* تجاهل */ }

  logger.info(`✅ العامل جاهز ويعمل بلا توكن تيليجرام — الجلسات المحلية: ${localSessionCount()}`);

  // إيقاف نظيف
  const shutdown = async (sig) => {
    logger.info(`استلمت ${sig} — إيقاف نظيف…`);
    await shutdownAll();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

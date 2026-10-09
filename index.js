// index.js — نقطة التشغيل الرئيسية (ESM): node index.js
// ─────────────────────────────────────────────────────────────────────
// نقطة دخول عامة:
//   • ROLE=main   (أو الافتراضي بلا WORKER_NAME) → سيرفر رئيسي: بوت تيليجرام + منسّق النظام.
//   • ROLE=worker (أو وجود WORKER_NAME)          → سيرفر عامل: جلسات واتساب فقط،
//     بلا بوت تيليجرام وبلا أي شرط لـ TG_TOKEN — حتى لو نُفِّذ عبر index.js.
// ملاحظة: telegraf لا يُستورد إلا داخل مسار الرئيسي وبعد التحقق من الدور والتوكن،
// فلا يتعطل إقلاع العمال غياباً للتوكن أو للحزمة.
// ─────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import config from './config.js';
import logger from './utils/logger.js';

// تحميل حزم الأوامر الداخلية (يجب قبل أي جلسة — على الرئيسي والعامل معاً)
import './whatsapp/commands/index.js';

async function main() {
  if (config.isWorker) {
    // ════════ سيرفر عامل: جلسات واتساب + اتصال بالرئيسي — لا تيليجرام هنا ════════
    const { runWorker } = await import('./worker-core.js');
    await runWorker();
    return;
  }

  // ════════ السيرفر الرئيسي: الوحيد الذي يشترط TG_TOKEN ويشغّل تيليجرام ════════
  const { validateEnv } = await import('./env-check.js');
  const { createApiServer } = await import('./server.js');
  const { restoreAllSessions, shutdownAll, ensureLocalServer } = await import('./whatsapp/manager.js');
  const { usersStore, settingsStore, isBanned } = await import('./utils/store.js');

  // 0) التحقق من متغيرات البيئة — التحقق الصارم من TG_TOKEN هنا (الرئيسي) فقط
  const v = validateEnv();
  for (const w of v.warnings) logger.warn(w);
  if (!v.ok) {
    for (const e of v.errors) logger.error(e);
    process.exit(1);
  }

  // 1) حمّل التخزين الدائم وسجّل السيرفر المحلي
  usersStore.load();
  settingsStore.load();
  ensureLocalServer();
  logger.info('تم تحميل بيانات المستخدمين والإعدادات');

  // 1.5) تجهيز أدوات التحميل تلقائياً (yt-dlp + ffmpeg):
  //      يبحث عنها وإن لم يجدها يثبّتها بنفسه (pip / ملف مستقل / npm / apt) ثم يحدّثها.
  //      لا يُسقط الإقلاع إطلاقاً إن فشل التجهيز — يصبح متاحاً لاحقاً مع أول طلب تحميل.
  try {
    const { bootstrapTools } = await import('./bootstrap.js');
    await bootstrapTools();
  } catch (err) {
    logger.warn({ err }, '⚠️ تعذّر تجهيز أدوات التحميل تلقائياً — سيُعاد المحاولة عند أول طلب تحميل.');
  }

  // 2) استعد جلسات الواتساب المحفوظة لهذا السيرفر
  await restoreAllSessions();

  // 2.5) ★ v3.8: فعّل الأوامر المخصّصة وملفات الأوامر المرفوعة للرقم المربوط
  //      (تُحمّل في سجل أوامر الواتساب فتظهر مباشرة في قائمة «.الاوامر»)
  try {
    const { loadCustomCommandsIntoRegistry } = await import('./utils/customCommands.js');
    await loadCustomCommandsIntoRegistry();
    const { activateAllSavedCommandFiles } = await import('./whatsapp/commandFiles.js');
    await activateAllSavedCommandFiles();
  } catch (err) {
    logger.warn({ err }, '⚠️ تعذّر تحميل الأوامر المخصّصة/ملفات الأوامر — سيعمل البوت بباقي الأوامر.');
  }

  // 3) جهّز بوت تيليجرام (استيراد كسول — telegraf لا يُحمَّل إلا على الرئيسي)
  const { createBot } = await import('./telegram/bot.js');
  const { bot, handleWorkerEvent } = createBot();

  // ★ v3.7: أي جلسة محلية يُبطلها المستخدم من هاتفه → حذف تلقائي + رسالة تأكيد له
  // (الجلسات المستعادة بعد إعادة التشغيل لا يكون لها معالج خاص، فهذا المسار هو شبكتها)
  const { onLoggedOut } = await import('./utils/events.js');
  onLoggedOut((payload) => handleWorkerEvent(payload));

  // 4) شغّل خادم الـ API (استقبال تسجيل العمال وأحداثهم ونقاط التحكم)
  // خطاف إذاعة تيليجرام لواجهة الويب: يبثّ لكل من تفاعل مع البوت
  // ★ v3.7: إذاعة تيليجرام من الويب — نص خام (بلا Markdown يسقط الرسالة)،
  //         تخطّي المحظورين ومن حجب البوت، وإعادة محاولة عند حدود المعدل (429).
  const broadcastTelegram = async (text) => {
    const users = Object.values(usersStore.all() || {}).filter((u) => u && u.id);
    let sent = 0, failed = 0, blocked = 0;
    for (const u of users) {
      if (isBanned(u.id)) continue;
      try {
        await bot.telegram.sendMessage(u.id, text);
        sent += 1;
      } catch (err) {
        const d = String(err?.description || err?.message || err);
        const retryAfter = err?.response?.parameters?.retry_after;
        if (/retry after|429|Too Many Requests/i.test(d) || retryAfter) {
          await new Promise((r) => setTimeout(r, (Number(retryAfter) || 3) * 1000 + 500));
          try { await bot.telegram.sendMessage(u.id, text); sent += 1; continue; } catch { failed += 1; continue; }
        }
        if (/blocked|forbidden|chat not found|deactivated|kicked/i.test(d)) blocked += 1;
        else failed += 1;
      }
      await new Promise((r) => setTimeout(r, 55));
    }
    return { total: users.length, sent, failed, blocked };
  };

  // ★ v3.12: تنظيف ذاكرة دوري (استقرار 24/7)
  try { const { startMemoryGC } = await import('./utils/performance.js'); startMemoryGC(); } catch { /* */ }

  const app = createApiServer(handleWorkerEvent, { broadcastTelegram });
  app.listen(config.main.port, () => {
    logger.info(`🌐 خادم الرئيسي يعمل على المنفذ ${config.main.port} (${config.main.url})`);
  });

  // أوامر القائمة الظاهرة في واجهة تيليجرام
  await bot.telegram.setMyCommands([
    { command: 'start', description: '🏠 القائمة الرئيسية' },
    { command: 'link', description: '➕ ربط رقم واتساب جديد' },
    { command: 'numbers', description: '📱 إدارة أرقامي وحالتها' },
    { command: 'emoji', description: '😀 تخصيص إيموجي الحالات' },
    { command: 'help', description: '❓ المساعدة' },
    { command: 'dev', description: '🛠️ لوحة المطور (للمطورين)' },
    { command: 'devhelp', description: '🛠️ أوامر المطور (للمطورين)' },
    { command: 'addcmd', description: '➕ إضافة أمر نصّي جديد (للمطورين)' },
    { command: 'uploadcmd', description: '📤 رفع ملف أمر برمجي للرقم المربوط (للمطورين)' },
    { command: 'customcmds', description: '⭐ الأوامر المخصّصة (للمطورين)' },
    { command: 'sessions', description: '🗂️ كل الجلسات (للمطورين)' },
    { command: 'broadcastTG', description: '📣 إذاعة تيليجرام (للمطورين)' },
    { command: 'broadcastWA', description: '📣 إذاعة واتساب (للمطورين)' }
  ]).catch(() => {});

  try {
    await bot.launch();
    logger.info('🚀 بوت تيليجرام يعمل الآن — بانتظار المستخدمين');
  } catch (err) {
    logger.error({ err }, '❌ فشل تشغيل بوت تيليجرام — تأكد من صحة TG_TOKEN (توكن حقيقي من @BotFather).');
    throw err;
  }

  // إيقاف نظيف
  const shutdown = async (sig) => {
    logger.info(`استلمت ${sig} — إيقاف نظيف…`);
    // ★ v3.12: إشعار السيرفرات الفرعية بإعادة التشغيل المتزامن قبل الإيقاف
    // (الرئيسي يتحكم ويدير بقية السيرفرات: يرسل الأمر فيخرّفوا أنفسهم ويتحدثوا كودهم)
    try {
      const { notifyWorkersRestart } = await import('./utils/fleet.js');
      await notifyWorkersRestart(sig);
    } catch { /* تجاهل */ }
    try { bot.stop(sig); } catch { /* */ }
    await shutdownAll();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// شبكة أمان: لا تُسقط البوت لأخطاء غير متوقعة
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException'));

// شغّل main() فقط عند تنفيذ هذا الملف مباشرة (node index.js) — وليس عند استيراده من وحدة أخرى
import { pathToFileURL } from 'node:url';
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err) => {
    logger.fatal({ err }, 'فشل تشغيل السيرفر');
    process.exit(1);
  });
}

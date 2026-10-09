// worker.js — نقطة تشغيل سيرفر عامل (Server 2، 3، …): node worker.js
// ─────────────────────────────────────────────────────────────────────
// • العامل لا يشغّل بوت تيليجرام ولا يحتاج TG_TOKEN نهائياً.
// • يشترط فقط: MAIN_API_URL (رابط صالح للسيرفر الرئيسي) + API_SECRET (مطابق لسر الرئيسي).
// • منطق الإقلاع الفعلي في worker-core.js (مشترك مع index.js عندما ROLE=worker).
// ─────────────────────────────────────────────────────────────────────
import './force-worker.js'; // يضبط ROLE=worker قبل قراءة config (تشغيل worker.js = سيرفر عامل)
import 'dotenv/config';
import { runWorker } from './worker-core.js';

// شغّل main() فقط عند تنفيذ هذا الملف مباشرة (node worker.js)
// وليس عند استيراده من وحدات أو اختبارات أخرى (smoke.js مثلاً)
import { pathToFileURL } from 'node:url';
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  runWorker().catch((err) => {
    import('./utils/logger.js').then(({ logger }) => {
      logger.fatal({ err }, 'فشل تشغيل العامل');
      process.exit(1);
    });
  });
}

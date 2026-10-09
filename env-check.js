// env-check.js — التحقق من متغيرات البيئة حسب دور السيرفر (فصل كامل بين الرئيسي والعمال)
// ─────────────────────────────────────────────────────────────────────
// • السيرفر الرئيسي (main)  : الوحيد الذي يُشترط فيه TG_TOKEN (توكن بوت تيليجرام).
// • السيرفرات العمال (worker): لا تُشترط فيها أي توكن تيليجرام نهائياً، بل يُشترط فيها:
//     MAIN_API_URL (رابط صالح للسيرفر الرئيسي) + API_SECRET (مطابق لسر الرئيسي).
// ─────────────────────────────────────────────────────────────────────
import config from './config.js';

const DEFAULT_SECRET = 'change_me_to_a_long_random_secret';

const isHttpUrl = (v) => {
  try {
    const u = new URL(String(v || '').trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !/[^\w.-]/.test(u.hostname);
  } catch {
    return false;
  }
};

/**
 * يتحقق من متغيرات البيئة وفق دور السيرفر المحدد في config.js
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateEnv() {
  const errors = [];
  const warnings = [];

  if (config.isMain) {
    // ════════ السيرفر الرئيسي: يشترط توكن تيليجرام فقط ════════
    if (!config.telegramToken) {
      errors.push(
        '❌ [الرئيسي] TG_TOKEN مفقود — السيرفر الرئيسي هو الوحيد الذي يشغّل بوت تيليجرام.\n' +
        '   ضع توكن البوت من @BotFather في ملف .env بالسطر: TG_TOKEN=123456:ABC-...'
      );
    } else if (/put_your|your_real_token/i.test(config.telegramToken)) {
      errors.push('❌ [الرئيسي] TG_TOKEN ما زال قيمة مؤقتة من القالب — ضع التوكن الحقيقي من @BotFather.');
    }
    if (!config.main.apiSecret || config.main.apiSecret === DEFAULT_SECRET) {
      warnings.push(
        '⚠️ [الرئيسي] API_SECRET ما زال بالقيمة الافتراضية — السيرفرات العمال لن تستطيع التسجيل إن لم تطابقها معه. غيّره إلى سر طويل عشوائي.'
      );
    }
  } else {
    // ════════ سيرفر عامل: لا توكن تيليجرام إطلاقاً — يشترط رابط الرئيسي والسر المشترك فقط ════════
    if (!isHttpUrl(config.mainApiUrl)) {
      errors.push(
        '❌ [العامل] MAIN_API_URL مفقود أو ليس رابطاً صحيحاً.\n' +
        '   ضع في .env: MAIN_API_URL=http://IP_السيرفر_الرئيسي:3000'
      );
    }
    if (!config.main.apiSecret || config.main.apiSecret === DEFAULT_SECRET) {
      errors.push(
        '❌ [العامل] API_SECRET مفقود أو ما زال بالقيمة الافتراضية.\n' +
        '   يجب أن يكون مطابقاً تماماً للسر المضبوط على السيرفر الرئيسي.'
      );
    }
    if (!process.env.WORKER_NAME) {
      warnings.push('⚠️ [العامل] WORKER_NAME غير مضبوط — سيُستخدم الاسم الافتراضي "server2". يفضَّل تسمية كل عامل باسم فريد (server2، server3…).');
    }
    // تنبيه إرشادي فقط: وجود توكن على عامل لا يعني شيئاً — لن يُشغَّل به بوت تيليجرام
    if (config.telegramToken) {
      warnings.push('ℹ️ [العامل] TG_TOKEN موجود في .env لكنه سيُتجاهَل تماماً — بوت تيليجرام يعمل على السيرفر الرئيسي فقط.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

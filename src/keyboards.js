/**
 * keyboards.js — لوحات الأزرار التفاعلية (Inline)
 * لوحة /start تحتوي أكثر من 15 زر إدارة
 */
import telegraf from 'telegraf';
const { Markup } = telegraf;

const b = (text, data) => Markup.button.callback(text, data);

/** اللوحة الرئيسية — 24 زر إدارة */
export const mainMenu = () => Markup.inlineKeyboard(mainMenuRows());

/** صفوف القائمة الرئيسية (تُستعمل أيضاً تحت أزرار /start المخصصة) */
export const mainMenuRows = () => [
    [b('🔗 ربط رقم جديد', 'act:connect'), b('❌ فصل الرقم', 'act:disconnect')],
    [b('📊 حالة الحساب', 'act:status'), b('🟢 تفاعل الحالات: تشغيل/إيقاف', 'act:toggle_react')],
    [b('😀 إيموجياتي', 'act:emoji_list'), b('➕ إضافة إيموجي', 'act:emoji_add')],
    [b('🗑 حذف إيموجي', 'act:emoji_del'), b('♻️ إعادة تعيين الإيموجيات', 'act:emoji_reset')],
    [b('💚 القلب الأخضر', 'act:toggle_heart'), b('👀 مشاهدة الحالة أولاً', 'act:toggle_view')],
    [b('⏱ تأخير التفاعل', 'act:delay'), b('🛡 وضع الحماية', 'act:toggle_protect')],
    [b('🚫 قائمة الحظر', 'act:blocklist'), b('👥 إدارة المجموعات', 'act:groups')],
    [b('🤖 الردود الآلية', 'act:autoreply'), b('📥 تحميل الوسائط', 'act:downloader')],
    [b('🧹 تنظيف الذاكرة', 'act:gc'), b('📈 إحصائيات', 'act:stats')],
    [b('🔔 ساعات الهدوء', 'act:quiet'), b('📢 رسالة جماعية', 'act:broadcast')],
    [b('🧪 فحص الاتصال', 'act:ping'), b('⚙️ الإعدادات', 'act:settings')],
    [b('📜 قائمة الأوامر', 'act:help'), b('ℹ️ حول البوت', 'act:about')]
];

/** لوحة الإيموجيات مع أزرار الحذف السريع */
export const emojiMenu = (emojis = []) => {
  const rows = [];
  const list = emojis.slice(0, 40);
  for (let i = 0; i < list.length; i += 4) {
    rows.push(list.slice(i, i + 4).map((e, idx) => b(`${e} ✖️`, `emoji:del:${i + idx}`)));
  }
  rows.push([b('➕ إضافة إيموجي جديد', 'act:emoji_add'), b('♻️ استعادة الافتراضي', 'act:emoji_reset')]);
  rows.push([b('⬅️ رجوع للقائمة', 'act:menu')]);
  return Markup.inlineKeyboard(rows);
};

/** لوحة الإعدادات */
export const settingsMenu = () =>
  Markup.inlineKeyboard([
    [b('🟢 التفاعل التلقائي', 'act:toggle_react'), b('👀 المشاهدة أولاً', 'act:toggle_view')],
    [b('💚 القلب الأخضر', 'act:toggle_heart'), b('🔔 ساعات الهدوء', 'act:quiet')],
    [b('🛡 الحماية', 'act:toggle_protect'), b('👁 إشعار القراءة', 'act:toggle_read')],
    [b('⌨️ محاكاة الكتابة', 'act:toggle_typing'), b('🗑 حذف الرسائل (antiDelete)', 'act:toggle_antidel')],
    [b('🛡 كشف الحذف لدى الجميع', 'act:toggle_wadel'), b('📸 عدم حذف الحالات', 'act:toggle_wast')],
    [b('👁 كشف العرض لمرة واحدة', 'act:toggle_vonce'), b('⏱ ضبط التأخير', 'act:delay')],
    [b('🔄 عكس ترتيب التفاعل', 'act:toggle_order'), b('🔔 إشعار «تم التفاعل على حالة»', 'act:toggle_notify')],
    [b('⬅️ رجوع', 'act:menu')]
  ]);

/** لوحة إدارة المجموعات */
export const groupsMenu = () =>
  Markup.inlineKeyboard([
    [b('📋 قائمة المجموعات', 'grp:list'), b('👋 ترحيب الأعضاء', 'act:toggle_welcome')],
    [b('🔒 قفل المجموعة', 'grp:close'), b('🔓 فتح المجموعة', 'grp:open')],
    [b('⬅️ رجوع', 'act:menu')]
  ]);

/** لوحة التحميل */
export const downloaderMenu = () =>
  Markup.inlineKeyboard([
    [b('🎬 فيديو 360p', 'dl:360'), b('🎬 فيديو 720p', 'dl:720')],
    [b('🎬 فيديو 1080p', 'dl:1080'), b('🎵 صوت MP3', 'dl:mp3')],
    [b('ℹ️ معلومات الرابط', 'dl:info')],
    [b('⬅️ رجوع', 'act:menu')]
  ]);

/** لوحة الرجوع فقط */
export const backMenu = (to = 'act:menu') => Markup.inlineKeyboard([[b('⬅️ رجوع', to)]]);

/** تأكيد عملية خطيرة */
export const confirmMenu = (yesData, noData = 'act:menu') =>
  Markup.inlineKeyboard([[b('✅ تأكيد', yesData), b('✖️ إلغاء', noData)]]);

export { Markup };

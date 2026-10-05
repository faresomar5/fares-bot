/**
 * commands.extra.js — أوامر إضافية: أدوات نص، ترفيه، أدوات ويب، إسلاميات، وسائط
 * تُصدّر مصفوفة [name, def] وتُسجّل داخل commands.js
 */
import crypto from 'node:crypto';
import { randInt, randomPick, escapeHtml, md5 as _md5 } from './utils.js';

export const extras = [];
const add = (name, def) => extras.push([name, def]);

const A = (arr) => arr; // اختصار

/* ==========================================================
 *  أدوات النصوص (تنفيذ حقيقي كامل)
 * ========================================================== */
const txt = (name, desc, fn, aliases = []) =>
  add(name, { category: 'أدوات النص', desc, aliases, handler: async (ctx) => ctx.reply(fn(ctx.argsStr, ctx)) });

txt('upper', 'تحويل النص إلى أحرف كبيرة', (s) => s.toUpperCase() || '✍️ اكتب النص بعد الأمر.', ['كبير']);
txt('lower', 'تحويل النص إلى أحرف صغيرة', (s) => s.toLowerCase() || '✍️ اكتب النص.', ['صغير']);
txt('title', 'تحويل أول حرف من كل كلمة لكبير', (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()), ['عنوان']);
txt('reverse', 'عكس النص', (s) => [...s].reverse().join(''), ['عكس']);
txt('revwords', 'عكس ترتيب الكلمات', (s) => s.split(/\s+/).reverse().join(' '), ['عكس_الكلمات']);
txt('nospace', 'حذف المسافات', (s) => s.replace(/\s+/g, ''), ['بدون_مسافات']);
txt('dedupe', 'حذف الأسطر المكررة', (s) => [...new Set(s.split('\n'))].join('\n'), ['حذف_المكرر']);
txt('sortlines', 'ترتيب الأسطر أبجدياً', (s) => s.split('\n').sort((a, b) => a.localeCompare(b, 'ar')).join('\n'), ['ترتيب']);
txt('shufflelines', 'خلط الأسطر عشوائياً', (s) => s.split('\n').sort(() => Math.random() - 0.5).join('\n'), ['خلط']);
txt('countchars', 'عدد الأحرف', (s) => `🔢 الأحرف: ${[...s].length}\n📝 بدون مسافات: ${s.replace(/\s/g, '').length}`, ['عدد_الاحرف']);
txt('countwords', 'عدد الكلمات', (s) => `📝 الكلمات: ${s.split(/\s+/).filter(Boolean).length}`, ['عدد_الكلمات']);
txt('countlines', 'عدد الأسطر', (s) => `📄 الأسطر: ${s.split('\n').length}`, ['عدد_الاسطر']);
txt('slugify', 'تحويل النص إلى slug لرابط', (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''));
txt('camel', 'تحويل إلى camelCase', (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+(.)/gu, (_, c) => c.toUpperCase()));
txt('pascal', 'تحويل إلى PascalCase', (s) => s.replace(/(?:^|[^\p{L}\p{N}]+)(.)/gu, (_, c) => c.toUpperCase()));
txt('snake', 'تحويل إلى snake_case', (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_'), ['سنيك']);
txt('kebab', 'تحويل إلى kebab-case', (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'), ['كيبي']);
txt('constant', 'تحويل إلى CONSTANT_CASE', (s) => s.trim().toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '_'));
txt('repeat', 'تكرار النص', (s) => { const m = s.match(/^(\d+)\s+([\s\S]+)$/); return m ? m[2].repeat(Math.min(+m[1], 50)) : '✍️ الصيغة: /repeat 3 نص'; }, ['تكرار']);
txt('replace', 'استبدال نص', (s) => { const m = s.match(/^(.+?)\s*\|\s*(.*?)\s*\|\s*(.*)$/s); return m ? m[1].split(m[2]).join(m[3]) : '✍️ الصيغة: /replace الأصل | القديم | الجديد'; }, ['استبدال']);
txt('b64e', 'ترميز Base64', (s) => Buffer.from(s, 'utf8').toString('base64'), ['base64', 'ترميز']);
txt('b64d', 'فك ترميز Base64', (s) => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return '❌ نص Base64 غير صالح'; } }, ['فك_ترميز']);
txt('urlenc', 'ترميز URL', (s) => encodeURIComponent(s), ['urlencode']);
txt('urldec', 'فك ترميز URL', (s) => { try { return decodeURIComponent(s); } catch { return '❌ غير صالح'; } }, ['urldecode']);
txt('hex', 'تحويل نص إلى Hex', (s) => Buffer.from(s, 'utf8').toString('hex'), ['هيكس']);
txt('unhex', 'فك Hex إلى نص', (s) => { try { return Buffer.from(s.replace(/\s/g, ''), 'hex').toString('utf8'); } catch { return '❌ غير صالح'; } });
txt('binary', 'تحويل نص إلى ثنائي', (s) => [...Buffer.from(s, 'utf8')].map((b) => b.toString(2).padStart(8, '0')).join(' '), ['ثنائي']);
txt('unbinary', 'فك الثنائي إلى نص', (s) => { try { return Buffer.from(s.trim().split(/\s+/).map((b) => parseInt(b, 2))).toString('utf8'); } catch { return '❌ غير صالح'; } });
/** إزاحة حروف إنجليزية بعدد ثابت (تستخدمها rot13 و caesar) */
const shiftLetters = (s, n) =>
  String(s).replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    const idx = c.charCodeAt(0) - base;
    return String.fromCharCode((((idx + n) % 26) + 26) % 26 + base);
  });

txt('rot13', 'تشفير ROT13', (s) => shiftLetters(s, 13));
txt('caesar', 'تشفير قيصر', (s) => {
  const m = s.match(/^(\d+)\s+([\s\S]+)$/);
  if (!m) return '✍️ الصيغة: /caesar 3 نص';
  return shiftLetters(m[2], Number(m[1]) || 0);
}, ['قيصر']);
txt('md5', 'تجزئة MD5', (s) => _md5(s), ['هاش']);
txt('sha256', 'تجزئة SHA-256', (s) => crypto.createHash('sha256').update(s).digest('hex'));
txt('uuid', 'توليد UUID عشوائي', () => globalThis.crypto.randomUUID(), ['معرف']);
txt('randstr', 'توليد نص عشوائي', (s) => { const n = Math.min(parseInt(s, 10) || 16, 200); return [...Array(n)].map(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[randInt(0, 61)]).join(''); }, ['عشوائي']);
txt('randnum', 'توليد رقم عشوائي', (s) => { const [a = 1, b = 100] = s.split(/\s+/).map(Number); return String(randInt(a, b)); });
txt('password', 'توليد كلمة مرور قوية', (s) => { const n = Math.min(parseInt(s, 10) || 16, 64); const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_'; return [...Array(n)].map(() => c[randInt(0, c.length - 1)]).join(''); }, ['كلمة_مرور']);
txt('otp', 'توليد رمز تحقق 6 أرقام', () => String(randInt(100000, 999999)), ['رمز']);
txt('lorem', 'نص لوريم إيبسوم', (s) => { const n = Math.min(parseInt(s, 10) || 30, 300); const w = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' '); return [...Array(n)].map(() => randomPick(w)).join(' '); });
txt('json', 'تنسيق JSON بشكل مقروء', (s) => { try { return '```\n' + JSON.stringify(JSON.parse(s), null, 2) + '\n```'; } catch (e) { return '❌ JSON غير صالح: ' + e.message; } });
txt('jsonmin', 'تصغير JSON', (s) => { try { return JSON.stringify(JSON.parse(s)); } catch { return '❌ JSON غير صالح'; } });
txt('bubble', 'تحويل النص إلى حروف دائرية', (s) =>
  [...s]
    .map((c) => {
      const i = 'abcdefghijklmnopqrstuvwxyz'.indexOf(c.toLowerCase());
      if (i < 0) return c;
      const upper = c === c.toUpperCase();
      return String.fromCodePoint((upper ? 0x1f150 : 0x24d0) + i);
    })
    .join(''));
txt('smallcaps', 'نص بأحرف صغيرة مرتفعة', (s) => s.toLowerCase().replace(/[a-z]/g, (c) => 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀꜱᴛᴜᴠᴡxʏᴢ'['abcdefghijklmnopqrstuvwxyz'.indexOf(c)] || c));
txt('removeemoji', 'حذف الإيموجيات من النص', (s) => s.replace(/\p{Extended_Pictographic}/gu, '').trim(), ['حذف_الايموجي']);
txt('removediacritics', 'إزالة التشكيل من النص العربي', (s) => s.replace(/[\u064B-\u0652\u0670\u0640]/g, ''), ['ازالة_التشكيل']);
txt('normarabic', 'تطبيع النص العربي (أ/إ/آ←ا)', (s) => s.replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي'), ['تطبيع']);
txt('num2words', 'تحويل الأرقام إلى كلمات عربية', (s) => { const ones = ['صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر']; const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون']; return s.replace(/\d+/g, (n) => { const v = +n; if (v < 20) return ones[v]; if (v < 100) { const t = Math.floor(v / 10); const o = v % 10; return o ? `${ones[o]} و${tens[t]}` : tens[t]; } return v.toLocaleString('ar-EG'); }); }, ['ارقام_لكلمات']);
txt('extracturls', 'استخراج الروابط من النص', (s) => { const m = s.match(/https?:\/\/\S+/g) || []; return m.length ? m.join('\n') : 'ℹ️ لا توجد روابط.'; }, ['الروابط']);
txt('extractemails', 'استخراج الإيميلات', (s) => { const m = s.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []; return m.length ? m.join('\n') : 'ℹ️ لا توجد إيميلات.'; }, ['الايميلات']);
txt('extractnumbers', 'استخراج الأرقام', (s) => { const m = s.match(/-?\d+(\.\d+)?/g) || []; return m.length ? m.join(' ') : 'ℹ️ لا توجد أرقام.'; }, ['الارقام']);
txt('sum', 'جمع الأرقام', (s) => { const m = s.match(/-?\d+(\.\d+)?/g) || []; return m.length ? `Σ = ${m.reduce((a, b) => a + +b, 0)}` : '✍️ اكتب أرقاماً.'; }, ['جمع']);
txt('avg', 'متوسط الأرقام', (s) => { const m = s.match(/-?\d+(\.\d+)?/g) || []; return m.length ? `x̄ = ${(m.reduce((a, b) => a + +b, 0) / m.length).toFixed(2)}` : '✍️ اكتب أرقاماً.'; }, ['متوسط']);
txt('calc', 'حاسبة رياضية آمنة', (s) => { if (!/^[\d\s+\-*/().%^]+$/.test(s)) return '❌ رموز غير مسموحة.'; try { return `= ${Function(`"use strict";return (${s.replace(/\^/g, '**')})`)()}`; } catch { return '❌ تعبير غير صالح.'; } }, ['حاسبة', 'حساب']);
txt('bmi', 'حساب مؤشر كتلة الجسم', (s) => { const [w, h] = s.split(/\s+/).map(Number); if (!w || !h) return '✍️ الصيغة: /bmi 70 175 (كجم سم)'; const v = w / ((h / 100) ** 2); const t = v < 18.5 ? 'نقص وزن' : v < 25 ? 'وزن طبيعي ✅' : v < 30 ? 'زيادة وزن' : 'سمنة'; return `⚖️ BMI = ${v.toFixed(1)} — ${t}`; }, ['كتلة']);
txt('age', 'حساب العمر من تاريخ', (s) => { const d = new Date(s); if (isNaN(d)) return '✍️ الصيغة: /age 1995-05-20'; const y = (Date.now() - d) / 31557600000; return `🎂 العمر: ${Math.floor(y)} سنة (${Math.floor(y * 12) } شهر)`; }, ['عمر']);
txt('percent', 'حساب النسبة المئوية', (s) => { const [a, b] = s.split(/\s+/).map(Number); if (!b) return '✍️ الصيغة: /percent 25 200'; return `${a} من ${b} = ${((a / b) * 100).toFixed(2)}%`; }, ['نسبة']);

/* ==========================================================
 *  ترفيه
 * ========================================================== */
add('dice', { category: 'ترفيه', desc: 'رمي حجر النرد', aliases: ['نرد'], handler: async (ctx) => ctx.reply(`🎲 النتيجة: <b>${randInt(1, 6)}</b>`) });
add('coin', { category: 'ترفيه', desc: 'رمي عملة', aliases: ['عملة'], handler: async (ctx) => ctx.reply(`🪙 ${randomPick(['صورة 👑', 'كتابة 🔢'])}`) });
add('rps', { category: 'ترفيه', desc: 'حجر ورقة مقص', usage: '/rps حجر', aliases: ['حجر_ورقة_مقص'], handler: async (ctx) => {
  const c = ['حجر', 'ورقة', 'مقص']; const u = ctx.args[0]; if (!c.includes(u)) return ctx.reply('✍️ اختر: حجر | ورقة | مقص');
  const b = randomPick(c); const win = (u === 'حجر' && b === 'مقص') || (u === 'ورقة' && b === 'حجر') || (u === 'مقص' && b === 'ورقة');
  await ctx.reply(`${u === b ? '🤝 تعادل' : win ? '🎉 فزت' : '😢 خسرت'}\nأنت: ${u} | البوت: ${b}`);
} });
add('8ball', { category: 'ترفيه', desc: 'كرة الحظ الثمانية', aliases: ['حظ'], handler: async (ctx) => {
  const a = ['نعم بالتأكيد ✅', 'لا أظن ذلك ❌', 'ربما 🤔', 'بكل تأكيد 💯', 'اسأل لاحقاً ⏳', 'لا تعتمد عليه 🚫', 'الفرص ضعيفة 📉', 'الأمر في يدك 🙌'];
  await ctx.reply(`🎱 ${randomPick(a)}`);
} });
add('joke', { category: 'ترفيه', desc: 'نكتة عشوائية', aliases: ['نكتة'], handler: async (ctx) => ctx.reply(`😄 ${randomPick([
  'قالوا للبرمجة إنها صعبة… ضحك الـ Stack Overflow.',
  'مبرمج دخل مطعم، طلب شاي… رجع له كوب فارغ. قال: NullReferenceException!',
  'زوجتي قالت: اشترِ خبزاً، وإذا وجدت بيضاً اشترِ ٦. رجعت بـ٦ خبزات.',
  'ليه المبرمج ما بينام؟ لأن الـ bugs بتصحى بالليل.',
  'واحد سأل ChatGPT: إنت مين؟ قال: أنا اللي كنت بتعمله قبل ما تنساه.'
])}`) });
add('quote', { category: 'ترفيه', desc: 'اقتباس تحفيزي', aliases: ['اقتباس'], handler: async (ctx) => ctx.reply(`💡 ${randomPick([
  '«النجاح ليس نهائياً، والفشل ليس قاتلاً، الشجاعة للاستمرار هي ما يهم.»',
  '«ابدأ من حيث أنت، استخدم ما لديك، افعل ما تستطيع.»',
  '«الانضباط هو الجسر بين الأهداف والإنجاز.»',
  '«من جدّ وجد، ومن زرع حصد.»'
])}`) });
add('fact', { category: 'ترفيه', desc: 'معلومة عامة', aliases: ['معلومة'], handler: async (ctx) => ctx.reply(`🧠 ${randomPick([
  'الأخطبوط يمتلك ثلاثة قلوب ودمه أزرق.',
  'العسل لا يفسد أبداً — وُجد عسل صالح للأكل في مقابر مصرية عمرها 3000 سنة.',
  'أطول مدة بلا نوم مسجّلة هي 264 ساعة.',
  'ضوء الشمس يحتاج ~8 دقائق للوصول إلى الأرض.',
  'القرش لا يملك عظاماً — هيكله كامل من الغضاريف.'
])}`) });
add('compliment', { category: 'ترفيه', desc: 'مجاملة عشوائية', aliases: ['مجاملة'], handler: async (ctx) => ctx.reply(`🌸 ${randomPick([
  'أنت أذكى مما تظن 💫', 'وجودك يفرق فعلاً 🙌', 'روحك جميلة ✨', 'قدرتك على الاستمرار ملهمة 🔥'
])}`) });
add('dare', { category: 'ترفيه', desc: 'تحدي عشوائي', aliases: ['تحدي'], handler: async (ctx) => ctx.reply(`🎯 ${randomPick([
  'أرسل آخر صورة في معرض هاتفك 📷', 'اكتب رسالة لصديق بدون حرف الألف ✍️', 'قلد صوت حيوان في التسجيل الصوتي 🎙'
])}`) });
add('truth', { category: 'ترفيه', desc: 'سؤال صراحة', aliases: ['صراحة'], handler: async (ctx) => ctx.reply(`❓ ${randomPick([
  'ما آخر مرة كذبت فيها؟', 'ما أكبر مخاوفك؟', 'من الشخص الذي تتمنى الاعتذار له؟'
])}`) });
add('wyr', { category: 'ترفيه', desc: 'هذا أم ذاك', aliases: ['هذا_ام_ذاك'], handler: async (ctx) => ctx.reply(`🤔 ${randomPick([
  'أن تكون غنياً بلا أصدقاء أم فقيراً بأصدقاء أوفياء؟',
  'تقرأ الأفكار أم ترى المستقبل؟',
  'بلا إنترنت شهراً أم بلا هاتف سنة؟'
])}`) });
add('nhie', { category: 'ترفيه', desc: 'لم أفعل هذا قبلاً', aliases: ['لم_افعل'], handler: async (ctx) => ctx.reply(`🙈 ${randomPick([
  'لم أفعل: نمت أكثر من 12 ساعة متواصلة', 'لم أفعل: أكلت وأنا واقف في المطبخ',
  'لم أفعل: نسيت اسم شخص أثناء الحديث معه'
])}`) });
add('choose', { category: 'ترفيه', desc: 'اختيار عشوائي من قائمة', usage: '/choose أ ب ج', aliases: ['اختر'], handler: async (ctx) => ctx.reply(ctx.args.length ? `🎯 اختياري: <b>${randomPick(ctx.args)}</b>` : '✍️ اكتب الخيارات مفصولة بمسافات.') });
add('rate', { category: 'ترفيه', desc: 'تقييم عشوائي من 10', aliases: ['تقييم'], handler: async (ctx) => ctx.reply(`⭐ تقييمي: <b>${randInt(1, 10)}/10</b>${ctx.argsStr ? ` لـ «${escapeHtml(ctx.argsStr)}»` : ''}`) });
add('ship', { category: 'ترفيه', desc: 'نسبة توافق بين اسمين', usage: '/ship اسم1 اسم2', aliases: ['توافق'], handler: async (ctx) => { if (ctx.args.length < 2) return ctx.reply('💞 اكتب اسمين.'); const p = randInt(10, 100); await ctx.reply(`💞 ${ctx.args[0]} + ${ctx.args[1]} = <b>${p}%</b>\n${'█'.repeat(Math.round(p / 10))}${'░'.repeat(10 - Math.round(p / 10))}`); } });
add('fortune', { category: 'ترفيه', desc: 'حظك اليوم', aliases: ['طالع'], handler: async (ctx) => ctx.reply(`🔮 ${randomPick([
  'يومك يحمل فرصة ذهبية — انتبه للتفاصيل.', 'تجنب القرارات المتسرعة اليوم.', 'شخص ما سيفاجئك بخبر سعيد.', 'ركز على صحتك اليوم.'
])}`) });
add('lottery', { category: 'ترفيه', desc: 'أرقام يانصيب عشوائية', aliases: ['يانصيب'], handler: async (ctx) => { const s = new Set(); while (s.size < 6) s.add(randInt(1, 49)); await ctx.reply(`🎟 أرقامك: <b>${[...s].join(' - ')}</b>`); } });
add('trivia', { category: 'ترفيه', desc: 'سؤال ثقافي مع إجابة', aliases: ['ثقافة'], handler: async (ctx) => { const q = randomPick([
  ['ما أطول نهر في العالم؟', 'النيل'], ['ما عاصمة اليابان؟', 'طوكيو'], ['كم عدد ألوان قوس قزح؟', '7'],
  ['ما أكبر كوكب في المجموعة الشمسية؟', 'المشتري'], ['من كتب «مقدمة ابن خلدون»؟', 'ابن خلدون']
]); await ctx.reply(`🧩 سؤال: ${q[0]}\n||الإجابة: ${q[1]}||`); } });

/* ==========================================================
 *  إسلاميات
 * ========================================================== */
const rel = (name, desc, fn, aliases = []) => add(name, { category: 'إسلاميات', desc, aliases, handler: async (ctx) => ctx.reply(fn()) });

rel('azkar', 'ذكر عشوائي', () => `📿 ${randomPick([
  'سبحان الله وبحمده، سبحان الله العظيم', 'لا حول ولا قوة إلا بالله', 'اللهم صلِّ وسلم على نبينا محمد',
  'أستغفر الله العظيم وأتوب إليه', 'لا إله إلا الله وحده لا شريك له'
])}`, ['ذكر']);
rel('azkarsabah', 'أذكار الصباح', () => '🌅 <b>أذكار الصباح</b>\n• أصبحنا وأصبح الملك لله\n• اللهم بك أصبحنا وبك أمسينا\n• حسبي الله لا إله إلا هو\n• بسم الله الذي لا يضر مع اسمه شيء', ['الصباح']);
rel('azkarmasaa', 'أذكار المساء', () => '🌙 <b>أذكار المساء</b>\n• أمسينا وأمسى الملك لله\n• اللهم بك أمسينا وبك أصبحنا\n• أعوذ بكلمات الله التامات من شر ما خلق', ['المساء']);
rel('istighfar', 'استغفار', () => '🤲 أستغفر الله العظيم الذي لا إله إلا هو الحي القيوم وأتوب إليه', ['استغفار']);
rel('salawat', 'الصلاة على النبي', () => '🕌 اللهم صلِّ وسلِّم وبارك على نبينا محمد وعلى آله وصحبه أجمعين', ['صلاة_على_النبي']);
rel('dua', 'دعاء عشوائي', () => `🤲 ${randomPick([
  'اللهم إني أسألك العفو والعافية في الدنيا والآخرة',
  'اللهم اشرح صدري ويسر أمري',
  'ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار',
  'اللهم اجعل القرآن ربيع قلوبنا'
])}`);
rel('asma', 'من أسماء الله الحسنى', () => { const n = ['الرحمن','الرحيم','الملك','القدوس','السلام','المؤمن','العزيز','الجبار','الخالق','الرزاق','الفتاح','العليم','الحكيم','الودود','الغفور']; return `✨ ${randomPick(n)}`; }, ['اسماء_الله']);
rel('ayah', 'آية عشوائية', () => `📖 ${randomPick([
  '﴿وَأَن لَّيْسَ لِلْإِنسَانِ إِلَّا مَا سَعَىٰ﴾',
  '﴿إِنَّ مَعَ الْعُسْرِ يُسْرًا﴾',
  '﴿وَقُل رَّبِّ زِدْنِي عِلْمًا﴾',
  '﴿فَاذْكُرُونِي أَذْكُرْكُمْ﴾'
])}`, ['ايه']);
rel('hadith', 'حديث شريف', () => `📗 ${randomPick([
  '«إنما الأعمال بالنيات» — متفق عليه',
  '«من كان يؤمن بالله واليوم الآخر فليقل خيراً أو ليصمت»',
  '«المسلم من سلم المسلمون من لسانه ويده»'
])}`, ['حديث']);
rel('hijri', 'التاريخ الهجري', () => `🗓 التاريخ الهجري: ${new Date().toLocaleDateString('ar-SA-u-ca-islamic', { day: 'numeric', month: 'long', year: 'numeric' })}`, ['هجري']);
rel('tasbih', 'عداد تسبيح', () => '📿 ابدأ التسبيح: سبحان الله ×33، الحمد لله ×33، الله أكبر ×34');

/* ==========================================================
 *  أدوات ويب (APIs مجانية بلا مفاتيح)
 * ========================================================== */
const web = (name, desc, fn, aliases = []) => add(name, { category: 'أدوات الويب', desc, aliases, handler: async (ctx) => { const r = await fn(ctx.argsStr, ctx); await ctx.reply(r); } });

web('wiki', 'بحث في ويكيبيديا', async (s) => {
  if (!s) return '✍️ اكتب كلمة للبحث.';
  const r = await fetch(`https://ar.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(s)}`, { headers: { 'User-Agent': 'tgwa-bot/1.0' } });
  if (!r.ok) return '❌ لم أجد نتيجة.';
  const j = await r.json();
  return `📚 <b>${escapeHtml(j.title)}</b>\n\n${escapeHtml((j.extract || '').slice(0, 900))}\n\n🔗 ${j.content_urls?.desktop?.page || ''}`;
}, ['ويكيبيديا']);

web('weather', 'حالة الطقس لمدينة', async (s) => {
  if (!s) return '✍️ اكتب اسم المدينة.';
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(s)}&count=1&language=ar`)).json();
  const c = g?.results?.[0];
  if (!c) return '❌ لم أجد المدينة.';
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.latitude}&longitude=${c.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`)).json();
  const cur = w.current;
  return `🌤 <b>${escapeHtml(c.name)}, ${escapeHtml(c.country || '')}</b>\n🌡 الحرارة: ${cur.temperature_2m}°C\n💧 الرطوبة: ${cur.relative_humidity_2m}%\n💨 الريح: ${cur.wind_speed_10m} كم/س`;
}, ['طقس']);

web('currency', 'تحويل العملات', async (s) => {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]{3})\s*(?:to|إلى|الى)?\s*([A-Za-z]{3})?$/);
  if (!m) return '💱 الصيغة: /currency 100 USD SAR';
  const [, amt, from, to = 'SAR'] = m;
  const j = await (await fetch(`https://open.er-api.com/v6/latest/${from.toUpperCase()}`)).json();
  const rate = j?.rates?.[to.toUpperCase()];
  if (!rate) return '❌ عملة غير مدعومة.';
  return `💱 ${amt} ${from.toUpperCase()} = <b>${(amt * rate).toFixed(2)} ${to.toUpperCase()}</b>\n📈 سعر الصرف: ${rate}`;
}, ['عملة', 'تحويل_عملة']);

web('time', 'الوقت في مدينة', async (s) => {
  if (!s) return '🕐 اكتب اسم المدينة.';
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(s)}&count=1`)).json();
  const c = g?.results?.[0];
  if (!c) return '❌ لم أجد المدينة.';
  const t = new Date().toLocaleString('ar-EG', { timeZone: c.timezone || 'UTC' });
  return `🕐 ${escapeHtml(c.name)}: <b>${t}</b>\n🌍 المنطقة: ${c.timezone}`;
}, ['وقت']);

web('ip', 'معلومات عنوان IP', async (s) => {
  const j = await (await fetch(`http://ip-api.com/json/${encodeURIComponent(s || '')}?lang=ar`)).json();
  if (j.status !== 'success') return '❌ تعذر جلب المعلومات.';
  return `🌐 <b>${j.query}</b>\n📍 ${j.country} — ${j.city}\n🏢 ${j.isp}\n🕐 ${j.timezone}`;
}, ['ايبي']);

web('qr', 'توليد رمز QR لنص أو رابط', async (s) => {
  if (!s) return '✍️ اكتب النص أو الرابط.';
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(s)}`;
  return `🔳 <a href="${url}">اضغط لعرض رمز QR</a>`;
}, ['كيو_ار']);

web('shorten', 'اختصار رابط', async (s) => {
  if (!/^https?:\/\//.test(s)) return '🔗 أرسل رابطاً صالحاً.';
  const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(s)}`);
  const t = await r.text();
  return `🔗 الرابط المختصر: ${t}`;
}, ['اختصار']);

/* ==========================================================
 *  وسائط (تحتاج مكتبات إضافية — تتحقق وتُعلم بوضوح)
 * ========================================================== */
const media = (name, desc, note, aliases = []) =>
  add(name, { category: 'الوسائط', desc, aliases, handler: async (ctx) => ctx.reply(note) });

media('tts', 'تحويل النص إلى كلام', '🔊 ميزة TTS تحتاج مفتاح API لمزود صوتي. أضف مفتاحك في .env ثم فعّل الأمر من src/commands.extra.js.', ['كلام']);
media('ocr', 'قراءة نص من صورة', '🔍 ميزة OCR تحتاج tesseract: <code>sudo apt install tesseract-ocr tesseract-ocr-ara</code> ثم npm i node-tesseract-ocr.', ['قراءة_صورة']);
media('removebg', 'إزالة خلفية صورة', '🖼 ميزة إزالة الخلفية تحتاج مفتاح API (remove.bg) أو مكتبة rembg محلياً.', ['ازالة_خلفية']);
media('upscale', 'تحسين جودة صورة', '✨ ميزة تحسين الجودة تحتاج مكتبة sharp أو خدمة خارجية.', ['تحسين']);
media('imgresize', 'تصغير/تكبير صورة', '📐 تحتاج sharp: <code>npm i sharp</code> — الأمر جاهز للتفعيل في commands.extra.js.', ['تحجيم']);
media('watermark', 'إضافة علامة مائية على صورة', '💧 تحتاج sharp: <code>npm i sharp</code>.', ['علامة_مائية']);
media('pdfmerge', 'دمج ملفات PDF', '📄 تحتاج pdf-lib: <code>npm i pdf-lib</code>.', ['دمج_pdf']);
media('pdfsplit', 'تقسيم ملف PDF', '📄 تحتاج pdf-lib: <code>npm i pdf-lib</code>.', ['تقسيم_pdf']);
media('voice', 'تحويل نص إلى رسالة صوتية واتساب', '🎙 يحتاج محرك TTS + ffmpeg.', ['صوتية']);
media('gif', 'تحويل فيديو إلى GIF', '🎞 يحتاج ffmpeg: <code>sudo apt install ffmpeg</code>.', ['متحرك']);

/* ==========================================================
 *  أوامر مساعدة إضافية
 * ========================================================== */
add('help', { category: 'النظام', desc: 'قائمة كل الأوامر', aliases: ['مساعدة', 'اوامر', 'menu', 'الأوامر'], handler: async (ctx) => {
  const { listCommands, countDistinct, countCommands } = await import('./commands.js');
  await ctx.reply(`📜 <b>قائمة الأوامر</b>\n🔢 الأوامر الأساسية: <b>${countDistinct()}</b> | مع المرادفات: <b>${countCommands()}</b>\n${listCommands()}`);
} });

add('version', { category: 'النظام', desc: 'إصدار البوت', aliases: ['اصدار'], handler: async (ctx) => ctx.reply(`⚙️ إصدار البوت: <b>1.0.0</b>\n📦 Node: ${process.version}`) });
add('uptime', { category: 'النظام', desc: 'مدة التشغيل', aliases: ['مدة_التشغيل'], handler: async (ctx) => {
  const { globalStats } = await import('./wa.js'); const { fmtUptime } = await import('./utils.js');
  await ctx.reply(`⏳ مدة التشغيل: <b>${fmtUptime(globalStats().uptime)}</b>`);
} });
add('echo', { category: 'أدوات النص', desc: 'إعادة نفس النص', aliases: ['صدى'], handler: async (ctx) => ctx.reply(ctx.argsStr || '✍️ اكتب نصاً.') });
add('myid', { category: 'النظام', desc: 'عرض آيديك', aliases: ['ايديي'], handler: async (ctx) => ctx.reply(`🆔 <code>${ctx.tgId}</code>`) });
add('source', { category: 'النظام', desc: 'معلومات المشروع', aliases: ['المصدر'], handler: async (ctx) => ctx.reply('📦 مشروع بوت تيليجرام + واتساب (Baileys Multi-Device)\n⚙️ Node 20+ | telegraf 4 | @whiskeysockets/baileys 7') });

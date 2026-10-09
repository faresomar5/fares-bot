// force-worker.js — يُستورد قبل config.js في worker.js فقط
// تشغيل worker.js يعني أن الدور «سيرفر عامل» بالضرورة — حتى لو نسى المستخدم ROLE=worker في .env
process.env.ROLE = 'worker';

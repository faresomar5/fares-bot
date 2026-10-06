/**
 * downloader.js — محرك التحميل من جميع المنصات (yt-dlp + بدائل مباشرة)
 *
 * ✳️ الإصلاحات في هذا الإصدار:
 *  - اكتشاف yt-dlp بعدة طرق (binary محلي / PATH / python -m yt_dlp) بدون تخزين نتيجة فاشلة.
 *  - تثبيت تلقائي عبر pip مع --break-system-packages (Debian/Ubuntu الجديدة) ثم
 *    تنزيل الملف التنفيذي المستقل من GitHub كخطة أخيرة.
 *  - إعادة المحاولة بعدة استراتيجيات (extractor-args خاصة بتيك توك، impersonate، IPv4...).
 *  - دعم ملف كوكيز (data/cookies.txt) للمحتوى المحمي.
 *  - بدائل مباشرة لتيك توك وتويتر/X عند فشل yt-dlp.
 *  - اكتشاف ffmpeg لضمان دمج الصوت/الفيديو.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from './config.js';

const run = promisify(execFile);

const PLATFORMS = [
  { name: 'YouTube', re: /(youtube\.com|youtu\.be|music\.youtube\.com)/i },
  { name: 'TikTok', re: /(tiktok\.com|vt\.tiktok|vm\.tiktok)/i },
  { name: 'Instagram', re: /(instagram\.com|instagr\.am)/i },
  { name: 'Facebook', re: /(facebook\.com|fb\.watch|fb\.me)/i },
  { name: 'Twitter/X', re: /(twitter\.com|x\.com|t\.co)/i },
  { name: 'Reddit', re: /(reddit\.com|redd\.it)/i },
  { name: 'Pinterest', re: /(pinterest\.|pin\.it)/i },
  { name: 'Snapchat', re: /(snapchat\.com)/i },
  { name: 'SoundCloud', re: /(soundcloud\.com)/i },
  { name: 'Threads', re: /(threads\.net)/i },
  { name: 'Vimeo', re: /(vimeo\.com)/i },
  { name: 'Dailymotion', re: /(dailymotion\.com|dai\.ly)/i },
  { name: 'Twitch', re: /(twitch\.tv)/i },
  { name: 'LinkedIn', re: /(linkedin\.com)/i },
  { name: 'Telegram', re: /(t\.me)/i }
];

export const detectPlatform = (url) => PLATFORMS.find((p) => p.re.test(String(url)))?.name || 'Generic';
export const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || '').trim());

const fileExists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

/* ==========================================================
 *  1) اكتشاف yt-dlp
 * ========================================================== */
let resolvedBin = null;

export async function resolveYtdlp({ force = false } = {}) {
  if (resolvedBin && !force) return resolvedBin;

  const local = path.join(CONFIG.BIN_DIR, 'yt-dlp');
  const candidates = [];
  if (fileExists(local)) candidates.push({ bin: local, prefix: [], label: 'local' });
  if (CONFIG.YTDLP_BIN) candidates.push({ bin: CONFIG.YTDLP_BIN, prefix: [], label: 'env' });
  candidates.push({ bin: 'yt-dlp', prefix: [], label: 'path' });
  candidates.push({ bin: 'python3', prefix: ['-m', 'yt_dlp'], label: 'python3' });
  candidates.push({ bin: 'python', prefix: ['-m', 'yt_dlp'], label: 'python' });

  for (const c of candidates) {
    try {
      await run(c.bin, [...c.prefix, '--version'], { timeout: 20000 });
      resolvedBin = c;
      return resolvedBin;
    } catch {
      /* جرّب المرشح التالي */
    }
  }
  resolvedBin = null;
  return null;
}

/** واجهة متوافقة مع الإصدار السابق */
export const ytdlpAvailable = async () => !!(await resolveYtdlp());

/** هل ffmpeg متاح؟ (ضروري لدمج الفيديو+الصوت وللتحويل إلى MP3) */
let ffmpegCache = null;
export async function ffmpegAvailable() {
  if (ffmpegCache !== null) return ffmpegCache;
  try {
    await run(CONFIG.FFMPEG_BIN || 'ffmpeg', ['-version'], { timeout: 15000 });
    ffmpegCache = true;
  } catch {
    ffmpegCache = false;
  }
  return ffmpegCache;
}

/** تنزيل الملف التنفيذي المستقل لـ yt-dlp */
async function downloadYtdlpBinary() {
  const dest = path.join(CONFIG.BIN_DIR, 'yt-dlp');
  const urls = [
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500_000) continue;
      fs.mkdirSync(CONFIG.BIN_DIR, { recursive: true });
      fs.writeFileSync(dest, buf);
      fs.chmodSync(dest, 0o755);
      if (await resolveYtdlp({ force: true })) return true;
    } catch {
      /* جرّب الرابط التالي */
    }
  }
  return false;
}

/**
 * تثبيت yt-dlp تلقائياً إذا لم تكن موجودة — لا توقف الإقلاع عند الفشل
 */
export async function ensureYtdlp() {
  if (await resolveYtdlp({ force: true })) return true;

  console.log('⚙️ yt-dlp غير متاح — جاري التثبيت التلقائي...');
  const attempts = [
    ['python3', ['-m', 'pip', 'install', '-U', '--user', 'yt-dlp']],
    ['python3', ['-m', 'pip', 'install', '-U', '--user', '--break-system-packages', 'yt-dlp']],
    ['pip3', ['install', '-U', '--break-system-packages', 'yt-dlp']],
    ['pip3', ['install', '-U', '--user', 'yt-dlp']],
    ['pip', ['install', '-U', 'yt-dlp']]
  ];
  for (const [bin, args] of attempts) {
    try {
      await run(bin, args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
      if (await resolveYtdlp({ force: true })) {
        console.log('✅ تم تثبيت yt-dlp بنجاح.');
        return true;
      }
    } catch {
      /* جرّب الطريقة التالية */
    }
  }
  if (await downloadYtdlpBinary()) {
    console.log('✅ تم تنزيل yt-dlp المستقل بنجاح.');
    return true;
  }
  console.error('❌ تعذر تثبيت yt-dlp تلقائياً. ثبّته يدوياً: python3 -m pip install -U --break-system-packages yt-dlp');
  return false;
}

/* ==========================================================
 *  2) التحميل
 * ========================================================== */
const cleanDirKeep = (dir) => {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.part') || f.endsWith('.ytdl')) continue;
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
};

const listFiles = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.startsWith('.'))
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });

/** استراتيجيات إعادة المحاولة بالترتيب */
const STRATEGIES = [
  { label: 'افتراضي', args: [] },
  {
    label: 'وسائط تيك توك',
    args: ['--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com;app_info=7355728856979392262']
  },
  { label: 'إنستجرام/فيسبوك', args: ['--extractor-args', 'instagram:api=graphql;facebook:tab=video'] },
  { label: 'يوتيوب (عميل أندرويد)', args: ['--extractor-args', 'youtube:player_client=android,web_safari'] },
  { label: 'انتحال المتصفح', args: ['--impersonate', 'chrome'] },
  { label: 'IPv4 بدون كاش', args: ['--force-ipv4', '--no-cache-dir'] }
];

/**
 * تحميل وسائط
 * @param {string} url
 * @param {{audio?:boolean, quality?:string, timeout?:number}} opts
 * @returns {Promise<{file:string, size:number, dir:string, title:string, platform:string, audio:boolean, mime:string}>}
 */
export async function download(url, opts = {}) {
  const { audio = false, quality = '720', timeout = 300_000 } = opts;

  if (!isUrl(url)) throw new Error('الرابط غير صالح — أرسل رابطاً يبدأ بـ http/https');

  const target = String(url).trim();
  const platform = detectPlatform(target);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgwa-'));
  const out = path.join(dir, '%(title).70s.%(ext)s');

  const ytdlp = await resolveYtdlp();
  if (!ytdlp) {
    // جرّب البدائل المباشرة قبل إعلان الفشل
    const direct = await tryDirect(target, dir, { audio });
    if (direct) return finish(direct, dir, platform, audio, target);
    cleanup(dir);
    throw new Error(
      'yt-dlp غير مثبت على السيرفر.\nثبّته بالأمر:\n' +
        'python3 -m pip install -U --break-system-packages yt-dlp\n' +
        'أو: sudo apt install -y yt-dlp ffmpeg'
    );
  }

  const hasFfmpeg = await ffmpegAvailable();

  const base = [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--no-check-certificates',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '--socket-timeout',
    '20',
    '--geo-bypass',
    '--user-agent',
    CONFIG.USER_AGENT,
    '--add-header',
    'Accept-Language: en-US,en;q=0.9',
    '-o',
    out
  ];

  if (fileExists(CONFIG.COOKIES_FILE)) base.push('--cookies', CONFIG.COOKIES_FILE);

  if (audio) {
    if (hasFfmpeg) base.push('-x', '--audio-format', 'mp3', '--audio-quality', '128K');
    else base.push('-f', 'ba[ext=m4a]/ba/b');
  } else {
    base.push(
      '-f',
      hasFfmpeg
        ? `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`
        : `b[height<=${quality}][ext=mp4]/b[ext=mp4]/b`
    );
    if (hasFfmpeg) base.push('--merge-output-format', 'mp4');
  }

  let lastErr = '';

  for (const strat of STRATEGIES) {
    const args = [...ytdlp.prefix, ...base, ...strat.args, target];
    try {
      await run(ytdlp.bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      const raw = String(e?.stderr || e?.message || '');
      lastErr = raw.split('\n').filter((l) => l.trim() && !/^WARNING/i.test(l)).slice(-2).join(' | ') || lastErr;
      if (/impersonate|not available|not supported/i.test(raw) && strat.label === 'انتحال المتصفح') continue;
    }

    const files = listFiles(dir);
    if (files.length) {
      files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
      return finish(files[0], dir, platform, audio, target);
    }
  }

  // الخطة الأخيرة: البدائل المباشرة (تيك توك / تويتر)
  const direct = await tryDirect(target, dir, { audio });
  if (direct) return finish(direct, dir, platform, audio, target);

  cleanup(dir);
  const hint = /login|sign in|cookies|rate.?limit|429/i.test(lastErr)
    ? '\n💡 هذا المحتوى يحتاج تسجيل دخول — ضع ملف الكوكيز في: data/cookies.txt'
    : '';
  throw new Error(`فشل التحميل من ${platform}: ${lastErr || 'خطأ غير معروف'}${hint}`);
}

function finish(file, dir, platform, audio, url) {
  const ext = path.extname(file).replace('.', '').toLowerCase() || (audio ? 'mp3' : 'mp4');
  const mime = audio
    ? ext === 'mp3'
      ? 'audio/mpeg'
      : 'audio/mp4'
    : ext === 'mp4'
      ? 'video/mp4'
      : ext === 'webm'
        ? 'video/webm'
        : 'application/octet-stream';
  return {
    file,
    dir,
    size: fs.statSync(file).size,
    title: path.basename(file),
    platform: detectPlatform(url) || platform,
    audio,
    ext,
    mime
  };
}

/* ==========================================================
 *  3) بدائل مباشرة (عند فشل yt-dlp)
 * ========================================================== */
async function fetchToFile(url, dir, name) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': CONFIG.USER_AGENT, Accept: '*/*' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('ملف فارغ');
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf);
  return dest;
}

/** تيك توك عبر واجهة tikwm */
async function tiktokDirect(url, dir) {
  const api = `https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(url)}`;
  const res = await fetch(api, { headers: { 'User-Agent': CONFIG.USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j?.code !== 0 || !j?.data) throw new Error(j?.msg || 'استجابة غير صالحة');
  const link = j.data.hdplay || j.data.play || j.data.wmplay;
  if (!link) throw new Error('لا يوجد رابط فيديو');
  const title = String(j.data.title || 'tiktok').replace(/[^\w\u0600-\u06FF .-]/g, '').slice(0, 60) || 'tiktok';
  return fetchToFile(link, dir, `${title}.mp4`);
}

/** تويتر/X عبر fxtwitter */
async function twitterDirect(url, dir) {
  const m = url.match(/status\/(\d+)/);
  if (!m) throw new Error('رابط غير صالح');
  const res = await fetch(`https://api.fxtwitter.com/i/status/${m[1]}`, {
    headers: { 'User-Agent': CONFIG.USER_AGENT }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const media = j?.tweet?.media?.videos?.[0] || j?.tweet?.media?.photos?.[0];
  const link = media?.url;
  if (!link) throw new Error('لا توجد وسائط');
  const ext = /\.(jpg|jpeg|png|webp)$/i.test(link) ? link.split('.').pop() : 'mp4';
  return fetchToFile(link, dir, `twitter.${ext}`);
}

async function tryDirect(url, dir, { audio = false } = {}) {
  const p = detectPlatform(url);
  try {
    if (p === 'TikTok' && !audio) return await tiktokDirect(url, dir);
    if (p === 'Twitter/X') return await twitterDirect(url, dir);
  } catch {
    /* البديل فشل أيضاً */
  }
  return null;
}

/* ==========================================================
 *  4) أدوات
 * ========================================================== */
export function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** جلب معلومات فقط بدون تحميل */
export async function info(url) {
  const ytdlp = await resolveYtdlp();
  if (!ytdlp) throw new Error('yt-dlp غير مثبت — ثبّته بالأمر: python3 -m pip install -U --break-system-packages yt-dlp');
  const { stdout } = await run(
    ytdlp.bin,
    [...ytdlp.prefix, '--no-warnings', '-J', '--no-playlist', String(url).trim()],
    { timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const j = JSON.parse(stdout);
  return {
    title: j.title,
    duration: j.duration,
    uploader: j.uploader,
    views: j.view_count,
    thumbnail: j.thumbnail,
    platform: detectPlatform(url)
  };
}

export { PLATFORMS };

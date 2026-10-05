/**
 * downloader.js — تحميل الوسائط من جميع المنصات عبر yt-dlp
 * يدعم: يوتيوب، تيك توك، إنستجرام، فيسبوك، تويتر/X، ريديت، سنابشات، بينترست، ساوندكلاود... إلخ
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

let cachedAvailable = null;
export async function ytdlpAvailable() {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    await run(CONFIG.YTDLP_BIN, ['--version'], { timeout: 15000 });
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/**
 * تحميل وسائط
 * @param {string} url رابط الفيديو/الصوت
 * @param {{audio?:boolean, quality?:string, timeout?:number}} opts
 * @returns {Promise<{file:string, size:number, dir:string, title:string, platform:string, audio:boolean}>}
 */
export async function download(url, opts = {}) {
  const { audio = false, quality = '720', timeout = 300_000 } = opts;

  if (!isUrl(url)) throw new Error('الرابط غير صالح — أرسل رابطاً يبدأ بـ http/https');
  if (!(await ytdlpAvailable())) {
    throw new Error(`لم يتم العثور على ${CONFIG.YTDLP_BIN} على السيرفر. ثبّته بالأمر: pip install -U yt-dlp`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgwa-'));
  const out = path.join(dir, '%(title).70s.%(ext)s');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--no-check-certificates',
    '--retries',
    '3',
    '-o',
    out
  ];

  if (audio) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '128K');
  } else {
    args.push(
      '-f',
      `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}]/bv*[height<=${quality}]+ba/b`,
      '--merge-output-format',
      'mp4'
    );
  }
  args.push(String(url).trim());

  try {
    await run(CONFIG.YTDLP_BIN, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    cleanup(dir);
    const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(-2).join(' | ');
    throw new Error(`فشل التحميل: ${msg || 'خطأ غير معروف'}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'))
    .map((f) => path.join(dir, f));

  if (!files.length) {
    cleanup(dir);
    throw new Error('لم يتم إنتاج أي ملف — قد يكون الرابط محمياً أو غير مدعوم');
  }

  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const file = files[0];

  return {
    file,
    dir,
    size: fs.statSync(file).size,
    title: path.basename(file),
    platform: detectPlatform(url),
    audio
  };
}

export function cleanup(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** جلب معلومات فقط بدون تحميل */
export async function info(url) {
  if (!(await ytdlpAvailable())) throw new Error('yt-dlp غير مثبت');
  const { stdout } = await run(CONFIG.YTDLP_BIN, ['--no-warnings', '-J', '--no-playlist', String(url).trim()], {
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024
  });
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

// bootstrap.js — تجهيز أدوات التحميل تلقائياً (yt-dlp + ffmpeg) عند تشغيل السيرفر
// ─────────────────────────────────────────────────────────────────────────────
// الهدف: لا مزيد من رسالة «أداة yt-dlp غير مثبّتة على السيرفر».
//
// ترتيب البحث عن yt-dlp:
//   1) مسار صريح في YTDLP_BIN  (إن كان يحتوي على / ووُجد فعلاً)
//   2) داخل PATH              (yt-dlp)
//   3) bin/yt-dlp             (نسخة مرافقة للمشروع)
//   4) مسار محفوظ في data/tools.json  (نتيجة تهيئة سابقة)
//   5) وحدة بايثون            (python3 -m yt_dlp)
//
// وإن لم نجدها نُثبّتها تلقائياً بهذا الترتيب:
//   • python3 -m pip install -U yt-dlp   (مع --break-system-packages ثم --user ثم بلا شيء)
//   • تنزيل الملف التنفيذي المستقل yt-dlp_linux / _aarch64 (بلا حاجة لبايثون)
//   • apt-get install -y yt-dlp          (إن كنّا root)
//   • pipx install yt-dlp                (خيار أخير)
//
// وترتيب ffmpeg (لازم لدمج الصوت مع الصورة واستخراج MP3):
//   1) PATH  2) bin/ffmpeg  3) حزمة npm ffmpeg-static  4) imageio-ffmpeg عبر pip
//   5) نسخة ثابتة من johnvansickle.com  6) apt-get install -y ffmpeg
//
// كما يُحدّث yt-dlp تلقائياً عند كل إقلاع (يمكن تعطيله بـ YTDLP_AUTO_UPDATE=false).
// كل النتائج تُخزَّن في data/tools.json ليستخدمها محرّك التحميل مباشرة.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import config from './config.js';
import logger from './utils/logger.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BIN_DIR = process.env.TOOLS_BIN_DIR || (config.tools && config.tools.binDir) || path.join(__dirname, 'bin');
export const TOOLS_FILE = path.join(config.dataDir, 'tools.json');

const bool = (v, d = true) => (v === undefined || v === '' ? d : String(v).toLowerCase() !== 'false');
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';

function ensureBinDir() {
  try { fs.mkdirSync(BIN_DIR, { recursive: true }); } catch { /* تجاهل */ }
}

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }
    });
    const err = `${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`.trim();
    return { ok: r.status === 0, status: r.status, out: String(r.stdout || '').trim(), err };
  } catch (e) {
    return { ok: false, status: -1, out: '', err: e?.message || String(e) };
  }
}

/** إيجاد ملف تنفيذي داخل PATH */
export function whichBin(name) {
  if (!name) return null;
  try {
    if (name.includes('/') || name.includes('\\')) {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    }
    for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const p = path.join(d, name);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* التالي */ }
    }
  } catch { /* تجاهل */ }
  return null;
}

let pyCache;
/** كشف مفسّر بايثون 3 المتاح */
export function detectPython() {
  if (pyCache !== undefined) return pyCache;
  for (const c of [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean)) {
    const r = run(c, ['-c', 'import sys;print(sys.version_info[0])'], { timeoutMs: 15000 });
    if (r.ok && r.out.trim().startsWith('3')) { pyCache = c; return pyCache; }
  }
  pyCache = null;
  return pyCache;
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function aptAvailable() {
  return !!whichBin('apt-get') && (isRoot() || run('sudo', ['-n', 'true'], { timeoutMs: 5000 }).ok);
}

function aptInstall(pkgs, { timeoutMs = 420000 } = {}) {
  const sudo = isRoot() ? [] : ['sudo', '-n'];
  run(sudo[0] || 'true', sudo.length ? [sudo[1], 'true'] : [], { timeoutMs: 4000 });
  run([...sudo, 'apt-get'][0], [...sudo.slice(1), 'update'].length ? ['-o', 'Acquire::Retries=3', 'update'] : [], { timeoutMs: 180000 });
  return run('apt-get', [...sudo.slice(1), 'install', '-y', '-qq', ...pkgs], { timeoutMs });
}

/** تنزيل ملف (بعقدة fetch الأصلية) مع تحقق بسيط من الحجم */
async function fetchToFile(url, dest, { timeoutMs = 420000, minBytes = 200000, exec = false } = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'wa-tg-bot/3.0 (+loader)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} من ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error(`حجم الملف المُنزَّل صغير جداً (${buf.length} بايت)`);
  ensureBinDir();
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buf);
  if (exec) fs.chmodSync(dest, 0o755);
  return buf.length;
}

// ══════════════════════ yt-dlp ══════════════════════

const ytdlpUrl = () => {
  const arch = os.arch();
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
  if (process.platform === 'linux' && arch === 'x64') return `${base}yt-dlp_linux`;
  if (process.platform === 'linux' && arch === 'arm64') return `${base}yt-dlp_linux_aarch64`;
  if (process.platform === 'linux' && /arm/.test(arch)) return `${base}yt-dlp_linux_armv7l`;
  return `${base}yt-dlp`; // zipapp يعمل بأي نظام فيه بايثون
};

/** إيجاد yt-dlp متاح فعلاً على السيرفر */
export function resolveYtdlp() {
  const explicit = String(process.env.YTDLP_BIN || '').trim();

  const tryCmd = (cmd, prefixArgs, source) => {
    const r = run(cmd, [...prefixArgs, '--version'], { timeoutMs: 25000 });
    const version = firstLine(r.out);
    if (r.ok && /^\d{4}\.\d{2}\.\d{2}/.test(version)) return { ok: true, cmd, prefixArgs, version, source, path: cmd };
    return null;
  };

  // 1) مسار صريح
  if (explicit && explicit !== 'yt-dlp' && fs.existsSync(explicit)) {
    const hit = tryCmd(explicit, [], 'env');
    if (hit) return hit;
  }

  // 2) داخل PATH
  const inPath = whichBin(explicit || 'yt-dlp') || whichBin('yt-dlp');
  if (inPath) {
    const hit = tryCmd(inPath, [], 'path');
    if (hit) return hit;
  }

  // 3) نسخة المشروع المرافقة
  const bundled = path.join(BIN_DIR, 'yt-dlp');
  if (fs.existsSync(bundled)) {
    try { fs.chmodSync(bundled, 0o755); } catch { /* تجاهل */ }
    const hit = tryCmd(bundled, [], 'bundled');
    if (hit) return hit;
  }

  // 4) المسار المحفوظ من تهيئة سابقة
  const cached = readToolsFile();
  if (cached?.ytdlp?.cmd && cached.ytdlp.source !== 'env') {
    const hit = tryCmd(cached.ytdlp.cmd, cached.ytdlp.prefixArgs || [], cached.ytdlp.source || 'cache');
    if (hit) return hit;
  }

  // 5) وحدة بايثون
  const py = detectPython();
  if (py) {
    const hit = tryCmd(py, ['-m', 'yt_dlp'], 'python-module');
    if (hit) return hit;
  }

  return { ok: false, cmd: explicit || 'yt-dlp', prefixArgs: [], version: '', source: 'missing', path: null };
}

/** تثبيت yt-dlp بكل الطرق الممكنة حتى تنجح إحداها */
export async function installYtdlp({ log = () => {} } = {}) {
  ensureBinDir();
  const py = detectPython();

  // (أ) عبر pip
  if (py) {
    const variants = [
      ['-m', 'pip', 'install', '-U', '--break-system-packages', '--no-input', 'yt-dlp'],
      ['-m', 'pip', 'install', '-U', '--user', '--no-input', 'yt-dlp'],
      ['-m', 'pip', 'install', '-U', '--no-input', 'yt-dlp'],
      ['-m', 'pip', 'install', '-U', '--user', '--break-system-packages', 'yt-dlp']
    ];
    for (const v of variants) {
      log(`تثبيت yt-dlp عبر: ${py} ${v.join(' ')}`);
      const r = run(py, v, { timeoutMs: 420000 });
      const check = run(py, ['-m', 'yt_dlp', '--version'], { timeoutMs: 25000 });
      if (check.ok && /^\d{4}\.\d{2}\.\d{2}/.test(firstLine(check.out))) {
        log('✔ تم تثبيت yt-dlp عبر pip');
        return resolveYtdlp();
      }
      if (!r.ok && /No module named pip|not found|command not found/i.test(`${r.err}`)) break;
    }
    // محاولة تجهيز pip نفسه (لبيئات slim)
    if (run(py, ['-m', 'ensurepip', '--upgrade'], { timeoutMs: 180000 }).ok) {
      const r2 = run(py, ['-m', 'pip', 'install', '-U', '--break-system-packages', 'yt-dlp'], { timeoutMs: 420000 });
      if (r2.ok || run(py, ['-m', 'yt_dlp', '--version'], { timeoutMs: 25000 }).ok) return resolveYtdlp();
    }
  }

  // (ب) الملف التنفيذي المستقل — يعمل حتى بلا بايثون
  const target = path.join(BIN_DIR, 'yt-dlp');
  for (const url of [ytdlpUrl(), 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp']) {
    try {
      log(`تنزيل yt-dlp المستقل: ${url}`);
      await fetchToFile(url, target, { exec: true, minBytes: 300000 });
      const hit = resolveYtdlp();
      if (hit.ok) { log('✔ تم تنزيل yt-dlp المستقل'); return hit; }
    } catch (e) {
      log(`✖ فشل تنزيل yt-dlp: ${e?.message || e}`);
    }
  }

  // (ج) apt
  if (aptAvailable()) {
    log('محاولة تثبيت yt-dlp عبر apt…');
    aptInstall(['yt-dlp']);
    const hit = resolveYtdlp();
    if (hit.ok) { log('✔ تم تثبيت yt-dlp عبر apt'); return hit; }
  }

  // (د) pipx
  if (py && whichBin('pipx')) {
    log('محاولة تثبيت yt-dlp عبر pipx…');
    run('pipx', ['install', 'yt-dlp'], { timeoutMs: 420000 });
    run('pipx', ['ensurepath'], { timeoutMs: 60000 });
    const hit = resolveYtdlp();
    if (hit.ok) { log('✔ تم تثبيت yt-dlp عبر pipx'); return hit; }
  }

  log('✖ تعذّر تثبيت yt-dlp تلقائياً — ثبّته يدوياً: pip install -U yt-dlp أو ضع الملف التنفيذي في bin/yt-dlp');
  return resolveYtdlp();
}

// ══════════════════════ ffmpeg ══════════════════════

function ffmpegFromNpm() {
  try {
    const p = require('ffmpeg-static');
    if (p && typeof p === 'string' && fs.existsSync(p)) {
      try { fs.chmodSync(p, 0o755); } catch { /* تجاهل */ }
      return p;
    }
  } catch { /* غير مثبّتة */ }
  return null;
}

const ffmpegTarUrl = () =>
  os.arch() === 'arm64'
    ? 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz'
    : 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

export function resolveFfmpeg() {
  const explicit = String(process.env.FFMPEG_BIN || '').trim();
  if (explicit && explicit !== '/usr/bin/ffmpeg' && fs.existsSync(explicit)) return { ok: true, bin: explicit, source: 'env' };

  const inPath = whichBin('ffmpeg');
  if (inPath) return { ok: true, bin: inPath, source: 'path' };

  const bundled = path.join(BIN_DIR, 'ffmpeg');
  if (fs.existsSync(bundled)) {
    try { fs.chmodSync(bundled, 0o755); } catch { /* تجاهل */ }
    return { ok: true, bin: bundled, source: 'bundled' };
  }

  const fromNpm = ffmpegFromNpm();
  if (fromNpm) return { ok: true, bin: fromNpm, source: 'npm' };

  const cached = readToolsFile();
  if (cached?.ffmpeg?.bin && cached.ffmpeg.source !== 'env' && fs.existsSync(cached.ffmpeg.bin)) {
    return { ok: true, bin: cached.ffmpeg.bin, source: cached.ffmpeg.source || 'cache' };
  }

  return { ok: false, bin: explicit || 'ffmpeg', source: 'missing' };
}

/** تثبيت ffmpeg بكل الطرق الممكنة حتى تنجح إحداها */
export async function installFfmpeg({ log = () => {} } = {}) {
  ensureBinDir();

  // (أ) حزمة npm الجاهزة (سريعة وبلا صلاحيات)
  try {
    log('تنزيل ffmpeg عبر npm (ffmpeg-static)…');
    const r = run('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'ffmpeg-static@^5.2.0'], { timeoutMs: 420000 });
    if (r.ok) {
      const p = ffmpegFromNpm();
      if (p) { log('✔ تم تجهيز ffmpeg من npm'); return { ok: true, bin: p, source: 'npm' }; }
    } else log(`✖ npm: ${firstLine(r.err) || 'فشل'}`);
  } catch { /* تجاهل */ }

  // (ب) imageio-ffmpeg عبر pip
  const py = detectPython();
  if (py) {
    log('تنزيل ffmpeg عبر imageio-ffmpeg (pip)…');
    run(py, ['-m', 'pip', 'install', '-U', '--break-system-packages', '--no-input', 'imageio-ffmpeg'], { timeoutMs: 420000 });
    const r = run(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { timeoutMs: 60000 });
    const p = firstLine(r.out);
    if (r.ok && p && fs.existsSync(p)) {
      const dest = path.join(BIN_DIR, 'ffmpeg');
      try { fs.copyFileSync(p, dest); fs.chmodSync(dest, 0o755); return { ok: true, bin: dest, source: 'pip' }; }
      catch { return { ok: true, bin: p, source: 'pip' }; }
      log('✔ تم تجهيز ffmpeg من imageio-ffmpeg');
    }
  }

  // (ج) نسخة ثابتة
  try {
    log('تنزيل نسخة ffmpeg الثابتة…');
    const tar = path.join(os.tmpdir(), `ffmpeg-${Date.now()}.tar.xz`);
    await fetchToFile(ffmpegTarUrl(), tar, { timeoutMs: 600000, minBytes: 1000000 });
    const ex = run('tar', ['-xJf', tar, '-C', os.tmpdir()], { timeoutMs: 300000 });
    if (ex.ok) {
      const dir = (await fsp.readdir(os.tmpdir())).find((d) => /^ffmpeg-.*-static$/.test(d));
      if (dir) {
        const src = path.join(os.tmpdir(), dir, 'ffmpeg');
        if (fs.existsSync(src)) {
          const dest = path.join(BIN_DIR, 'ffmpeg');
          fs.copyFileSync(src, dest);
          fs.chmodSync(dest, 0o755);
          try { fs.rmSync(path.join(os.tmpdir(), dir), { recursive: true, force: true }); } catch { /* تجاهل */ }
          log('✔ تم تنزيل ffmpeg الثابت');
          return { ok: true, bin: dest, source: 'static' };
        }
      }
    }
  } catch (e) {
    log(`✖ فشل تنزيل ffmpeg الثابت: ${e?.message || e}`);
  }

  // (د) apt
  if (aptAvailable()) {
    log('تثبيت ffmpeg عبر apt…');
    aptInstall(['ffmpeg']);
    const hit = resolveFfmpeg();
    if (hit.ok) { log('✔ تم تثبيت ffmpeg عبر apt'); return hit; }
  }

  log('✖ تعذّر تثبيت ffmpeg — سيعمل التحميل بالجودة المتاحة بلا دمج (قد يفشل مع بعض المنصات).');
  return resolveFfmpeg();
}

// ══════════════════════ تخزين النتيجة ══════════════════════

let toolsCache = null;

/** قراءة ملف الأدوات المحلولة (data/tools.json) */
export function readToolsFile() {
  if (toolsCache) return toolsCache;
  try {
    toolsCache = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  } catch { toolsCache = null; }
  return toolsCache;
}

function writeToolsFile(data) {
  try {
    fs.mkdirSync(path.dirname(TOOLS_FILE), { recursive: true });
    fs.writeFileSync(TOOLS_FILE, JSON.stringify(data, null, 2), 'utf8');
    toolsCache = data;
  } catch (err) {
    logger.debug({ err: err?.message || err }, 'تعذّر حفظ data/tools.json');
  }
}

/** الأدوات المحلولة الحالية (للقراءة السريعة من محرّك التحميل) */
export function getYtdlp() {
  const cached = readToolsFile();
  if (cached?.ytdlp?.ok && cached.ytdlp.cmd) {
    const cmd = cached.ytdlp.cmd;
    const ok = (cached.ytdlp.prefixArgs || []).length ? true : fs.existsSync(cmd) || !!whichBin(cmd);
    if (ok) return cached.ytdlp;
  }
  return resolveYtdlp();
}

export function getFfmpeg() {
  const cached = readToolsFile();
  if (cached?.ffmpeg?.ok && cached.ffmpeg.bin && fs.existsSync(cached.ffmpeg.bin)) return cached.ffmpeg;
  return resolveFfmpeg();
}

// ══════════════════════ المنسّق العام ══════════════════════

async function maybeUpdateYtdlp(tools, log = () => {}) {
  if (!tools.ok) return tools;
  if (!bool(process.env.YTDLP_AUTO_UPDATE, true)) return tools;
  try {
    if (tools.source === 'bundled' || tools.source === 'path' || tools.source === 'env') {
      const r = run(tools.cmd, [...(tools.prefixArgs || []), '-U'], { timeoutMs: 180000 });
      const v = firstLine(r.out) || run(tools.cmd, [...(tools.prefixArgs || []), '--version'], { timeoutMs: 25000 }).out;
      if (r.ok || /updated|up to date/i.test(r.out + r.err)) {
        log('🔄 تم فحص تحديث yt-dlp');
        return { ...tools, version: firstLine(v) ? v.trim() : tools.version };
      }
    } else if (tools.source === 'python-module' && detectPython()) {
      const py = detectPython();
      run(py, ['-m', 'pip', 'install', '-U', '--break-system-packages', '--no-input', 'yt-dlp'], { timeoutMs: 420000 });
      const v = run(py, ['-m', 'yt_dlp', '--version'], { timeoutMs: 25000 });
      log('🔄 تم فحص تحديث yt-dlp');
      return { ...tools, version: firstLine(v.out) || tools.version };
    }
  } catch (e) {
    log(`⚠️ تعذّر تحديث yt-dlp: ${e?.message || e}`);
  }
  return tools;
}

/**
 * تهيئة كل الأدوات عند الإقلاع.
 * @param {{autoInstall?:boolean, autoUpdate?:boolean, quiet?:boolean}} opts
 * @returns {Promise<{ytdlp:object, ffmpeg:object}>}
 */
export async function bootstrapTools(opts = {}) {
  const autoInstall = opts.autoInstall === undefined
    ? (config.tools ? config.tools.autoInstall : bool(process.env.AUTO_INSTALL_TOOLS, true))
    : !!opts.autoInstall;
  const autoUpdate = opts.autoUpdate === undefined ? bool(process.env.YTDLP_AUTO_UPDATE, true) : !!opts.autoUpdate;
  const quiet = !!opts.quiet;
  const log = (m) => { if (!quiet) logger.info(`🧰 ${m}`); };

  log('فحص أدوات التحميل (yt-dlp + ffmpeg)…');

  let ytdlp = resolveYtdlp();
  if (!ytdlp.ok && autoInstall) {
    logger.warn('⚠️ yt-dlp غير مثبّت — جارٍ تجهيزه تلقائياً…');
    ytdlp = await installYtdlp({ log });
  }
  if (ytdlp.ok && autoUpdate) ytdlp = await maybeUpdateYtdlp(ytdlp, log);

  let ffmpeg = resolveFfmpeg();
  if (!ffmpeg.ok && autoInstall) {
    logger.warn('⚠️ ffmpeg غير مثبّت — جارٍ تجهيزه تلقائياً (قد يستغرق دقائق أول مرة)…');
    ffmpeg = await installFfmpeg({ log });
  }

  const data = {
    at: new Date().toISOString(),
    platform: `${process.platform}-${os.arch()}`,
    node: process.version,
    ytdlp: { ok: !!ytdlp.ok, cmd: ytdlp.cmd, prefixArgs: ytdlp.prefixArgs || [], version: ytdlp.version || '', source: ytdlp.source },
    ffmpeg: { ok: !!ffmpeg.ok, bin: ffmpeg.bin, source: ffmpeg.source }
  };
  writeToolsFile(data);

  if (ytdlp.ok && ffmpeg.ok) logger.info(`✅ محرّك التحميل جاهز — yt-dlp v${ytdlp.version} (${ytdlp.source}) + ffmpeg (${ffmpeg.source})`);
  else if (ytdlp.ok) logger.warn(`⚠️ yt-dlp جاهز (v${ytdlp.version}) لكن ffmpeg غير متاح — قد يتعذّر دمج بعض الملفات.`);
  else logger.warn('⚠️ yt-dlp غير متاح — ميزة التحميل لن تعمل حتى يتوفر الاتصال بالتثبيت. (باقي النظام يعمل طبيعياً)');

  return data;
}

export default {
  bootstrapTools, installYtdlp, installFfmpeg, resolveYtdlp, resolveFfmpeg,
  getYtdlp, getFfmpeg, readToolsFile, whichBin, detectPython, BIN_DIR, TOOLS_FILE
};

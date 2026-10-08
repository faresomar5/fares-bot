#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
بوت تيليجرام لتنزيل فيديوهات تيك توك وإنستجرام مع لوحة مطور، إذاعة، واشتراك إجباري.

أهم التحسينات في هذه النسخة:
- تقليل الضغط على الاستضافة المجانية: البوت لا يحمل فيديو المعاينة محلياً لكل طلب.
- محاولة إرسال روابط الفيديو/الصوت مباشرة عبر تيليجرام أولاً لتخفيف استهلاك الرام والمعالج.
- دعم تنزيل فيديوهات إنستجرام (Reels / Posts) بدون الاعتماد الإجباري على RapidAPI مع بدائل احتياطية.
- حصر التحميل المحلي الثقيل داخل Semaphore لتجنب توقف البوت عند الضغط على HD.
- إعادة تشغيل تلقائية عند حدوث خطأ قاتل أثناء التشغيل.
- حفظ الإعدادات والمستخدمين في ملفات JSON.
- لوحة مطور داخل البوت:
  * تغيير رسالة /start
  * إذاعة للمشتركين
  * تفعيل/تعطيل الاشتراك الإجباري
  * عرض الإحصائيات
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


# ==============================
# Bootstrap dependencies
# ==============================
def _ensure_package(import_name: str, pip_name: str) -> None:
    try:
        importlib.import_module(import_name)
        return
    except ImportError:
        print(f"[bootstrap] Installing missing package: {pip_name}", flush=True)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--no-cache-dir", pip_name]
        )
        importlib.import_module(import_name)


for _import_name, _pip_name in (
    ("requests", "requests>=2.31.0"),
    ("bs4", "beautifulsoup4>=4.12.0"),
    ("telegram", 'python-telegram-bot[webhooks]==21.6'),
    ("urllib3", "urllib3>=2.0.0"),
    ("yt_dlp", "yt-dlp>=2026.8.19"),
):
    _ensure_package(_import_name, _pip_name)

try:
    _ensure_package("curl_cffi", "curl-cffi>=0.11.0")
except Exception as _curl_cffi_exc:
    print(f"[bootstrap] Optional Facebook impersonation unavailable: {_curl_cffi_exc}", flush=True)


import requests
import yt_dlp
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatAction
from telegram.error import BadRequest, Forbidden, NetworkError, TimedOut
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)
from urllib3.util.retry import Retry


# ==============================
# الإعدادات الأساسية
# ==============================
BOT_TOKEN = os.getenv(
    "BOT_TOKEN",
    "8487375085:AAEzlpOgEPgWBwUMWe650xjxDZkrI8lUzgA",
).strip()
DEVELOPER_ID = int(os.getenv("DEVELOPER_ID", "7231690686") or "7231690686")

SOURCE_PREFIX = "tiktokio.com"
SOURCE_SITE = "https://tiktokio.com/"
SOURCE_API = "https://tiktokio.com/api/v1/tk/html"
DEFAULT_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0 Safari/537.36"
)

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "").strip()
INSTAGRAM_RAPIDAPI_HOST = os.getenv(
    "INSTAGRAM_RAPIDAPI_HOST",
    "instagram-reels-downloader-api.p.rapidapi.com",
).strip() or "instagram-reels-downloader-api.p.rapidapi.com"
INSTAGRAM_RAPIDAPI_ENDPOINT = os.getenv(
    "INSTAGRAM_RAPIDAPI_ENDPOINT",
    "https://instagram-reels-downloader-api.p.rapidapi.com/download",
).strip() or "https://instagram-reels-downloader-api.p.rapidapi.com/download"
INSTAGRAM_SESSIONID = os.getenv("INSTAGRAM_SESSIONID", "").strip()
INSTAGRAM_COOKIES = os.getenv("INSTAGRAM_COOKIES", "").strip()
INSTAGRAM_COOKIES_FILE = os.getenv("INSTAGRAM_COOKIES_FILE", "").strip()
INSTAGRAM_COOKIES_FROM_BROWSER = os.getenv("INSTAGRAM_COOKIES_FROM_BROWSER", "").strip()
INSTAGRAM_APP_ID = os.getenv("INSTAGRAM_APP_ID", "936619743392459").strip() or "936619743392459"
YTDLP_COOKIES_FILE = os.getenv("YTDLP_COOKIES_FILE", "").strip()
YTDLP_COOKIES_FROM_BROWSER = os.getenv("YTDLP_COOKIES_FROM_BROWSER", "").strip()
YTDLP_IMPERSONATE = os.getenv("YTDLP_IMPERSONATE", "chrome").strip() or "chrome"

HOST = os.getenv("HOST", "0.0.0.0").strip() or "0.0.0.0"
PORT = int(os.getenv("PORT", "8080"))
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "").strip()
WEBHOOK_SECRET_TOKEN = os.getenv("WEBHOOK_SECRET_TOKEN", "").strip()
WEBHOOK_PATH = os.getenv("WEBHOOK_PATH", "/telegram").strip() or "/telegram"
USE_WEBHOOK = os.getenv("USE_WEBHOOK", "").strip().lower() in {"1", "true", "yes", "on"}

REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "25"))
DOWNLOAD_TIMEOUT = int(os.getenv("DOWNLOAD_TIMEOUT", "60"))
MAX_DOWNLOAD_MB = int(os.getenv("MAX_DOWNLOAD_MB", "100"))
MAX_LOCAL_UPLOAD_MB = int(os.getenv("MAX_LOCAL_UPLOAD_MB", "48"))
MAX_TRANSFER_SECONDS = int(os.getenv("MAX_TRANSFER_SECONDS", "300"))
MAX_COMPRESSION_SECONDS = int(os.getenv("MAX_COMPRESSION_SECONDS", "600"))
SNAPCHAT_CROP_TOP_PERCENT = int(os.getenv("SNAPCHAT_CROP_TOP_PERCENT", "22"))
DOWNLOAD_STORE_TTL = int(os.getenv("DOWNLOAD_STORE_TTL", "7200"))
LOCAL_DOWNLOAD_CONCURRENCY = int(os.getenv("LOCAL_DOWNLOAD_CONCURRENCY", "1"))
FETCH_CACHE_TTL = int(os.getenv("FETCH_CACHE_TTL", "900"))
WARMUP_INTERVAL_SECONDS = int(os.getenv("WARMUP_INTERVAL_SECONDS", "900"))
RESTART_DELAY_SECONDS = int(os.getenv("RESTART_DELAY_SECONDS", "8"))

STORAGE_DIR = Path(os.getenv("STORAGE_DIR", ".bot_storage")).resolve()
USERS_FILE = STORAGE_DIR / "users.json"
SETTINGS_FILE = STORAGE_DIR / "settings.json"

START_MESSAGE_DEFAULT = (
    "أهلاً بيك 👋\n\n"
    "ابعت رابط TikTok أو Instagram أو YouTube أو Snapchat Spotlight أو Facebook أو X أو SoundCloud أو Pinterest أو Likee أو Kwai.\n\n"
    "المتاح حالياً:\n"
    "• TikTok / Instagram: أعلى جودة متاحة أو نسخة مضغوطة بحجم أقل\n"
    "• TikTok: تحميل الملف الصوتي MP3\n"
    "• Snapchat Spotlight: قصّ الجزء العلوي لإخفاء علامة السناب واسم المستخدم\n"
    "• YouTube: أعلى جودة متاحة أو نسخة مضغوطة\n"
    "• Facebook / X(Twitter) / Pinterest / Likee / Kwai: حسب دعم الرابط\n"
    "• SoundCloud: تنزيل الصوت MP3\n"
    "• علامات ونسب أصحاب المحتوى في بقية المنصات تبقى كما في المصدر\n"
    "• يمكن تنزيل فيديو يصل إلى 100MB ثم ضغطه للإرسال\n\n"
    "لو واجهت رابط لا يعمل، ابعته مرة ثانية وسأحاول من جديد."
)

FORCE_SUB_TEXT_DEFAULT = (
    "لازم تشترك أولاً في القناة/القناة المطلوبة ثم اضغط تحقق ✅"
)

RAW_COOKIES = [
    {
        "name": "__eoi",
        "value": "ID=6ff0e30c63a9450a:T=1777480916:RT=1777480916:S=AA-AfjZWlh1Lu7Eg1qpsevX14nDR",
        "domain": ".tiktokio.com",
        "path": "/",
    },
    {
        "name": "__gads",
        "value": "ID=72bd49fdd6164587:T=1777480916:RT=1777480916:S=ALNI_MbRi_jU4Hahc7-PGbYeovxzpo_bBg",
        "domain": ".tiktokio.com",
        "path": "/",
    },
    {
        "name": "__gpi",
        "value": "UID=000013da5adbd05c:T=1777480916:RT=1777480916:S=ALNI_MZr0VQ2NF5j3GmcXX8CP3aGd9jCtw",
        "domain": ".tiktokio.com",
        "path": "/",
    },
    {
        "name": "cf_clearance",
        "value": "wrNXzToPK1vQlgJsAO_zVXepi8tTzuo9n1yR3XP2n.o-1777480913-1.2.1.1-YOXPlWx0KxagD8jUvT0KKqyj8K9nM6fRxfBeUUKNo4DhEXKsppwMgL4zXC2uXFzM6ulFquFgwHmyx5CMzRIUZSp438eXnVhp83ICInYHWELNB94.U.9TQ8wBC9NUOjxCluvXI9RcbG2atD8V8EUkmMEjEALEPD6O8nVWR6w3kTPat1d8zGSsr0Wn306hxeazkMhKmCcgWiy3uhbS4YVDB8QLNg3yVQ2xpeK3g.dGXWHKCiTFzI7hgP5F4csOfHKXFOawgG2vmWvEKGckbZJjC2Br7_.YvHnAlYXmICVQzUKTY9BCU8rP43vZwOKefC_x0XzwwYllWDq.DWWuWeW4Yg",
        "domain": ".tiktokio.com",
        "path": "/",
    },
]


# ==============================
# السجل العام
# ==============================
logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("tiktok_store_bot")
APP_START_TIME = time.time()
JSON_LOCK = threading.Lock()
TIKTOK_URL_RE = re.compile(
    r"https?://(?:www\.)?(?:vt\.tiktok\.com|vm\.tiktok\.com|m\.tiktok\.com|tiktok\.com)/\S+",
    re.IGNORECASE,
)
INSTAGRAM_URL_RE = re.compile(
    r"https?://(?:www\.)?instagram\.com/(?:reel|reels|p|tv|stories|share)/\S+",
    re.IGNORECASE,
)
YOUTUBE_URL_RE = re.compile(
    r"https?://(?:(?:www|m|music)\.)?youtube\.com/(?:watch\?\S+|shorts/\S+|live/\S+|embed/\S+|v/\S+|clip/\S+)"
    r"|https?://youtu\.be/\S+",
    re.IGNORECASE,
)
SNAPCHAT_URL_RE = re.compile(
    r"https?://(?:www\.)?snapchat\.com/spotlight/\S+|https?://t\.snapchat\.com/\S+",
    re.IGNORECASE,
)
FACEBOOK_URL_RE = re.compile(
    r"https?://(?:(?:www|m|web)\.)?facebook\.com/\S+|https?://fb\.watch/\S+",
    re.IGNORECASE,
)
TWITTER_URL_RE = re.compile(
    r"https?://(?:(?:www|mobile)\.)?(?:x\.com|twitter\.com)/\S+|https?://t\.co/\S+",
    re.IGNORECASE,
)
SOUNDCLOUD_URL_RE = re.compile(r"https?://(?:www\.)?soundcloud\.com/\S+", re.IGNORECASE)
PINTEREST_URL_RE = re.compile(
    r"https?://(?:(?:www|[a-z]{2})\.)?pinterest\.com/\S+|https?://pin\.it/\S+",
    re.IGNORECASE,
)
LIKEE_URL_RE = re.compile(r"https?://(?:(?:www|l)\.)?likee\.video/\S+|https?://(?:www\.)?likee\.com/\S+", re.IGNORECASE)
KWAI_URL_RE = re.compile(
    r"https?://(?:(?:www|m|k|v)\.)?(?:kwai\.com|kwai-video\.com|kuaishou\.com)/\S+",
    re.IGNORECASE,
)


def _video_platform(url: str) -> str | None:
    host = (urlsplit(url or "").hostname or "").lower().rstrip(".")
    if host == "youtu.be" or host == "youtube.com" or host.endswith(".youtube.com"):
        return "YouTube"
    if host == "snapchat.com" or host.endswith(".snapchat.com"):
        return "Snapchat"
    if host == "facebook.com" or host.endswith(".facebook.com") or host == "fb.watch":
        return "Facebook"
    if host in {"x.com", "twitter.com", "t.co"} or host.endswith((".x.com", ".twitter.com")):
        return "X/Twitter"
    if host == "soundcloud.com" or host.endswith(".soundcloud.com"):
        return "SoundCloud"
    if host == "pin.it" or host == "pinterest.com" or host.endswith(".pinterest.com"):
        return "Pinterest"
    if host == "likee.video" or host.endswith(".likee.video") or host == "likee.com" or host.endswith(".likee.com"):
        return "Likee"
    if host in {"kwai.com", "kwai-video.com", "kuaishou.com"} or host.endswith((".kwai.com", ".kwai-video.com", ".kuaishou.com")):
        return "Kwai"
    return None


def _ytdlp_attempt_options(base_options: dict[str, Any], platform: str) -> list[dict[str, Any]]:
    attempts = [dict(base_options)]
    if platform != "Facebook":
        return attempts

    has_curl_cffi = False
    try:
        importlib.import_module("curl_cffi")
        has_curl_cffi = True
    except ImportError:
        pass

    if has_curl_cffi:
        attempts.append({**base_options, "impersonate": YTDLP_IMPERSONATE})
    attempts.append({**base_options, "force_generic_extractor": True})
    if has_curl_cffi:
        attempts.append({**base_options, "impersonate": YTDLP_IMPERSONATE, "force_generic_extractor": True})
    return attempts


def _external_platform_error(platform: str, errors: list[Exception]) -> str:
    details = " | ".join(str(error) for error in errors[-3:])
    if platform == "Pinterest" and any("Requested format is not available" in str(error) for error in errors):
        return (
            "Pinterest لم يعرض صيغة فيديو قابلة للتنزيل لهذا الرابط. تأكد أن الرابط يشير إلى Pin فيديو وليس صورة. "
            "إذا كان الـ Pin خاصاً، يحتاج البوت إلى YTDLP_COOKIES_FILE أو YTDLP_COOKIES_FROM_BROWSER لحساب مخوّل برؤيته؛ "
            "لا يمكن فتح محتوى لا يستطيع ذلك الحساب مشاهدته."
        )
    if platform == "Facebook" and any("Cannot parse data" in str(error) for error in errors):
        cookie_configured = bool(YTDLP_COOKIES_FILE or YTDLP_COOKIES_FROM_BROWSER)
        if cookie_configured:
            return (
                "Facebook رفض تحليل صفحة الفيديو. قد يكون هناك تحديد مؤقت للطلبات أو أن الرابط لا يظهر للحساب المُعدّ. "
                "انتظر قليلاً وقلّل المحاولات، وتأكد أن الحساب المصرّح به يستطيع فتح الرابط. "
                "قد يقيّد Facebook الحسابات عند اكتشاف أدوات تنزيل خارجية."
            )
        return (
            "Facebook رفض تحليل صفحة الفيديو؛ يحدث هذا أحياناً بسبب تحديد الطلبات المجهولة أو اشتراط تسجيل الدخول. "
            "انتظر قليلاً وقلّل المحاولات. إذا كان الفيديو متاحاً لحسابك فقط، يمكن إعداد YTDLP_COOKIES_FILE "
            "أو YTDLP_COOKIES_FROM_BROWSER على الخادم لحساب مخوّل برؤيته. لا ترسل ملف الكوكيز في المحادثة؛ "
            "وقد يقيّد Facebook الحسابات عند اكتشاف أدوات تنزيل خارجية."
        )
    return f"تعذر تنزيل فيديو {platform}. {details or 'قد يكون الرابط خاصاً أو غير متاح.'}"


# ==============================
# أدوات مساعدة عامة
# ==============================
def _should_use_webhook() -> bool:
    return bool(WEBHOOK_URL) or USE_WEBHOOK


def _normalize_webhook_path(path: str) -> str:
    path = (path or "/telegram").strip()
    if not path.startswith("/"):
        path = "/" + path
    return path


def _truncate(text: str, limit: int = 3900) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _notify_developer_sync(text: str) -> None:
    if not BOT_TOKEN or not DEVELOPER_ID:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={"chat_id": DEVELOPER_ID, "text": _truncate(text)},
            timeout=20,
        )
    except Exception:
        logger.exception("Could not notify developer via direct API call")


def ensure_storage() -> None:
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    if not USERS_FILE.exists():
        USERS_FILE.write_text("{}", encoding="utf-8")
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(
            json.dumps(
                {
                    "start_message": START_MESSAGE_DEFAULT,
                    "force_sub_enabled": False,
                    "force_sub_chat_id": "",
                    "force_sub_url": "",
                    "force_sub_text": FORCE_SUB_TEXT_DEFAULT,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def _load_json(path: Path, default: Any) -> Any:
    try:
        with JSON_LOCK:
            if not path.exists():
                return default
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("Could not load JSON file: %s", path)
        return default


def _save_json(path: Path, data: Any) -> None:
    with JSON_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.with_suffix(path.suffix + ".tmp")
        temp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(path)


def get_settings(context: ContextTypes.DEFAULT_TYPE | None = None) -> dict[str, Any]:
    if context and "settings" in context.bot_data:
        return context.bot_data["settings"]
    ensure_storage()
    return _load_json(
        SETTINGS_FILE,
        {
            "start_message": START_MESSAGE_DEFAULT,
            "force_sub_enabled": False,
            "force_sub_chat_id": "",
            "force_sub_url": "",
            "force_sub_text": FORCE_SUB_TEXT_DEFAULT,
        },
    )


def save_settings(context: ContextTypes.DEFAULT_TYPE, settings: dict[str, Any]) -> None:
    context.bot_data["settings"] = settings
    _save_json(SETTINGS_FILE, settings)


def get_users() -> dict[str, Any]:
    ensure_storage()
    return _load_json(USERS_FILE, {})


def save_users(data: dict[str, Any]) -> None:
    _save_json(USERS_FILE, data)


def is_developer(user_id: int | None) -> bool:
    return bool(user_id and DEVELOPER_ID and user_id == DEVELOPER_ID)


def format_uptime(seconds: int) -> str:
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}ي")
    if hours:
        parts.append(f"{hours}س")
    if minutes:
        parts.append(f"{minutes}د")
    parts.append(f"{secs}ث")
    return " ".join(parts)


def register_user(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not user:
        return

    users = context.bot_data.setdefault("users", get_users())
    key = str(user.id)
    users[key] = {
        "id": user.id,
        "first_name": user.first_name or "",
        "last_name": user.last_name or "",
        "full_name": user.full_name,
        "username": user.username or "",
        "is_bot": bool(user.is_bot),
        "last_seen": int(time.time()),
    }
    save_users(users)


def _cleanup_expired_results(context: ContextTypes.DEFAULT_TYPE) -> None:
    store = context.bot_data.setdefault("downloads", {})
    now = time.time()
    expired_keys = [
        key for key, value in store.items() if now - float(value.get("created_at", now)) > DOWNLOAD_STORE_TTL
    ]
    for key in expired_keys:
        store.pop(key, None)


# ==============================
# TikTok استخراج
# ==============================
@dataclass
class TikTokResult:
    source_url: str
    title: str
    cover_url: str | None
    preview_video_url: str | None
    no_watermark_url: str | None
    hd_url: str | None
    mp3_url: str | None
    watermark_url: str | None
    raw_links: dict[str, str]


@dataclass
class MediaProbe:
    final_url: str
    content_type: str
    content_length: int | None


class TikTokIOClient:
    def __init__(self) -> None:
        self.session = requests.Session()
        self._cache: dict[str, dict[str, Any]] = {}
        self._cache_lock = threading.Lock()
        self._warmup_lock = threading.Lock()
        self._last_warmup = 0.0
        self._reset_session()

    def _reset_session(self) -> None:
        retry = Retry(
            total=3,
            read=3,
            connect=3,
            backoff_factor=1,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("HEAD", "GET", "POST"),
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=20, pool_maxsize=20)
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

        self.session.headers.clear()
        self.session.headers.update(
            {
                "User-Agent": DEFAULT_BROWSER_UA,
                "Origin": SOURCE_SITE.rstrip("/"),
                "Referer": SOURCE_SITE,
                "Accept": "text/plain, text/html, application/json, */*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
                "Connection": "keep-alive",
            }
        )
        self.session.cookies.clear()
        self._load_cookies(RAW_COOKIES)
        self._load_instagram_runtime_cookies()

    def _load_cookies(self, cookies: list[dict[str, Any]]) -> None:
        for cookie in cookies:
            self.session.cookies.set(
                name=cookie["name"],
                value=str(cookie["value"]),
                domain=cookie.get("domain", ".tiktokio.com"),
                path=cookie.get("path", "/"),
            )

    @staticmethod
    def _parse_cookie_header(cookie_header: str) -> dict[str, str]:
        parsed: dict[str, str] = {}
        for part in (cookie_header or "").split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            value = value.strip()
            if name and value:
                parsed[name] = value
        return parsed

    @classmethod
    def _read_instagram_cookie_file(cls, cookie_file: str) -> dict[str, str]:
        path = Path(cookie_file).expanduser()
        if not path.exists():
            return {}

        text = path.read_text(encoding="utf-8", errors="ignore")
        if "\t" not in text and "sessionid=" in text:
            return cls._parse_cookie_header(text)

        parsed: dict[str, str] = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 7:
                continue
            domain, _include_subdomains, _path, _secure, _expires, name, value = parts[:7]
            if "instagram.com" not in domain.lower():
                continue
            if name and value:
                parsed[name] = value
        return parsed

    def _load_instagram_runtime_cookies(self) -> None:
        cookie_map: dict[str, str] = {}

        if INSTAGRAM_COOKIES_FILE:
            try:
                cookie_map.update(self._read_instagram_cookie_file(INSTAGRAM_COOKIES_FILE))
            except Exception as exc:
                logger.warning("Could not load Instagram cookie file: %s", exc)

        if INSTAGRAM_COOKIES:
            cookie_map.update(self._parse_cookie_header(INSTAGRAM_COOKIES))

        if INSTAGRAM_SESSIONID and "sessionid" not in cookie_map:
            cookie_map["sessionid"] = INSTAGRAM_SESSIONID

        for name, value in cookie_map.items():
            if not name or not value:
                continue
            self.session.cookies.set(
                name=name,
                value=str(value),
                domain=".instagram.com",
                path="/",
            )

    def _create_instagram_cookiefile_for_ytdlp(self) -> str | None:
        persistent_cookie_path = Path(INSTAGRAM_COOKIES_FILE).expanduser() if INSTAGRAM_COOKIES_FILE else None
        if persistent_cookie_path and persistent_cookie_path.exists():
            return str(persistent_cookie_path)

        instagram_cookies = [
            cookie
            for cookie in self.session.cookies
            if "instagram.com" in (cookie.domain or "").lower()
        ]
        if not instagram_cookies:
            return None

        fd, temp_path = tempfile.mkstemp(prefix="instagram_cookie_", suffix=".txt")
        os.close(fd)
        cookie_file = Path(temp_path)
        with cookie_file.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write("# Netscape HTTP Cookie File\n")
            for cookie in instagram_cookies:
                domain = cookie.domain or ".instagram.com"
                include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
                secure = "TRUE" if bool(getattr(cookie, "secure", False)) else "FALSE"
                expires = str(int(cookie.expires or 0))
                handle.write(
                    "\t".join(
                        [
                            domain,
                            include_subdomains,
                            cookie.path or "/",
                            secure,
                            expires,
                            cookie.name,
                            cookie.value,
                        ]
                    )
                    + "\n"
                )
        return str(cookie_file)

    def _warmup(self, *, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_warmup < WARMUP_INTERVAL_SECONDS:
            return

        with self._warmup_lock:
            now = time.time()
            if not force and now - self._last_warmup < WARMUP_INTERVAL_SECONDS:
                return
            try:
                self.session.get(SOURCE_SITE, timeout=12)
                self._last_warmup = now
            except Exception:
                logger.debug("Warmup request failed", exc_info=True)

    def _get_cached_result(self, tiktok_url: str) -> TikTokResult | None:
        with self._cache_lock:
            cached = self._cache.get(tiktok_url)
            if not cached:
                return None
            if time.time() - float(cached.get("saved_at", 0)) > FETCH_CACHE_TTL:
                self._cache.pop(tiktok_url, None)
                return None
            result = cached.get("result")
            return result if isinstance(result, TikTokResult) else None

    def _set_cached_result(self, tiktok_url: str, result: TikTokResult) -> None:
        with self._cache_lock:
            self._cache[tiktok_url] = {"saved_at": time.time(), "result": result}
            expired = [
                key
                for key, value in self._cache.items()
                if time.time() - float(value.get("saved_at", 0)) > FETCH_CACHE_TTL
            ]
            for key in expired:
                self._cache.pop(key, None)

    def probe_media(self, url: str) -> MediaProbe:
        content_type = ""
        content_length: int | None = None
        final_url = url

        try:
            response = self.session.head(
                url,
                allow_redirects=True,
                timeout=min(15, DOWNLOAD_TIMEOUT),
                headers=self._build_request_headers(url),
            )
            response.raise_for_status()
            final_url = response.url or url
            content_type = (response.headers.get("Content-Type") or "").lower()
            header = (response.headers.get("Content-Length") or "").strip()
            if header.isdigit():
                content_length = int(header)
        except Exception:
            logger.debug("HEAD probe failed for media url", exc_info=True)

        if content_length is None or not content_type or "text/html" in content_type:
            try:
                response = self.session.get(
                    final_url,
                    stream=True,
                    allow_redirects=True,
                    timeout=min(20, DOWNLOAD_TIMEOUT),
                    headers=self._build_request_headers(final_url, {"Range": "bytes=0-0"}),
                )
                response.raise_for_status()
                final_url = response.url or final_url
                content_type = (response.headers.get("Content-Type") or content_type or "").lower()
                content_range = response.headers.get("Content-Range") or ""
                if "/" in content_range:
                    total = content_range.rsplit("/", 1)[-1].strip()
                    if total.isdigit():
                        content_length = int(total)
                if content_length is None:
                    header = (response.headers.get("Content-Length") or "").strip()
                    if header.isdigit():
                        content_length = int(header)
                response.close()
            except Exception:
                logger.debug("Range probe failed for media url", exc_info=True)

        return MediaProbe(final_url=final_url, content_type=content_type, content_length=content_length)

    @staticmethod
    def _extract_html_payload(response_text: str) -> str:
        raw_text = (response_text or "").strip()
        if not raw_text:
            return ""

        if raw_text.startswith("{") and raw_text.endswith("}"):
            try:
                data = json.loads(raw_text)
                if isinstance(data, dict):
                    direct_message = data.get("message") or data.get("error")
                    for key in ("html", "data", "result", "content"):
                        value = data.get(key)
                        if isinstance(value, str) and value.strip():
                            return value.strip()
                        if isinstance(value, dict):
                            for inner_key in ("html", "content", "result"):
                                inner_value = value.get(inner_key)
                                if isinstance(inner_value, str) and inner_value.strip():
                                    return inner_value.strip()
                    if direct_message:
                        raise RuntimeError(str(direct_message))
            except json.JSONDecodeError:
                pass
        return raw_text

    @staticmethod
    def _extract_text_error(html: str) -> str | None:
        soup = BeautifulSoup(html, "html.parser")
        for selector in (".tk-error", ".alert-danger", ".error", ".text-danger"):
            err = soup.select_one(selector)
            if err:
                message = err.get_text(" ", strip=True)
                if message:
                    return message
        return None

    @staticmethod
    def _normalize_text(text: str) -> str:
        return " ".join((text or "").split())

    @staticmethod
    def _absolute_url(url: str | None) -> str | None:
        if not url:
            return None
        url = url.strip()
        if not url:
            return None
        if url.startswith("//"):
            return "https:" + url
        return requests.compat.urljoin(SOURCE_SITE, url)

    @staticmethod
    def _canonical_instagram_url(url: str) -> str:
        raw = (url or "").strip()
        if not raw:
            return ""
        parts = urlsplit(raw)
        cleaned_path = parts.path.rstrip("/") + "/"
        return urlunsplit((parts.scheme or "https", parts.netloc, cleaned_path, "", ""))

    @staticmethod
    def _build_request_headers(
        url: str,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, str]:
        lowered = (url or "").lower()
        headers = {
            "User-Agent": DEFAULT_BROWSER_UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Connection": "keep-alive",
        }
        if any(host in lowered for host in ("instagram.com", "cdninstagram.com", "fbcdn.net")):
            headers["Referer"] = "https://www.instagram.com/"
            headers["Origin"] = "https://www.instagram.com"
            # إضافة رؤوس إضافية لتجاوز حماية 403 في بعض روابط CDN
            headers["Sec-Fetch-Dest"] = "video"
            headers["Sec-Fetch-Mode"] = "no-cors"
            headers["Sec-Fetch-Site"] = "cross-site"
        else:
            headers["Referer"] = SOURCE_SITE
            headers["Origin"] = SOURCE_SITE.rstrip("/")
        if extra_headers:
            headers.update(extra_headers)
        return headers

    @staticmethod
    def _decode_escaped_url(value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            return ""
        cleaned = cleaned.replace(r"\/", "/").replace(r"\u0026", "&").replace("&amp;", "&")
        try:
            return json.loads(f'"{cleaned}"')
        except Exception:
            return cleaned

    def fetch(self, tiktok_url: str) -> TikTokResult:
        cleaned_url = tiktok_url.strip()
        cached = self._get_cached_result(cleaned_url)
        if cached:
            return cached

        last_error: Exception | None = None

        for attempt in range(1, 4):
            try:
                self._warmup()
                response = self.session.post(
                    SOURCE_API,
                    json={"vid": cleaned_url, "prefix": SOURCE_PREFIX},
                    timeout=REQUEST_TIMEOUT,
                )
                response.raise_for_status()

                html = self._extract_html_payload(response.text)
                if not html:
                    raise RuntimeError("الموقع أعاد نتيجة فارغة. غالباً الجلسة أو الكوكيز تحتاج تحديث.")

                if "tk-error" in html.lower():
                    raise RuntimeError(self._extract_text_error(html) or "تعذر جلب بيانات الرابط من المصدر.")

                result = self._parse_html(cleaned_url, html)
                if not any([result.no_watermark_url, result.hd_url, result.mp3_url]):
                    raise RuntimeError("تمت قراءة الصفحة لكن لم يتم العثور على روابط تنزيل صالحة.")
                self._set_cached_result(cleaned_url, result)
                return result
            except Exception as exc:
                last_error = exc
                logger.warning("Fetch attempt %s/3 failed: %s", attempt, exc)
                if attempt < 3:
                    time.sleep(attempt)
                    self._reset_session()

        raise RuntimeError(f"فشل جلب روابط التحميل بعد عدة محاولات: {last_error}")

    def _parse_html(self, source_url: str, html: str) -> TikTokResult:
        soup = BeautifulSoup(html, "html.parser")

        title = "مقطع تيك توك"
        for selector in ("h1", "h2", "h3", "title", 'meta[property="og:title"]'):
            node = soup.select_one(selector)
            if not node:
                continue
            value = node.get("content") if node.name == "meta" else node.get_text(" ", strip=True)
            if value:
                title = self._normalize_text(value) or title
                break

        cover_url = None
        for selector in ('meta[property="og:image"]', "img", "video[poster]"):
            node = soup.select_one(selector)
            if not node:
                continue
            if node.name == "meta":
                cover_url = self._absolute_url(node.get("content"))
            else:
                cover_url = self._absolute_url(node.get("src") or node.get("poster"))
            if cover_url:
                break

        preview_video_url = None
        for selector in ("video", "video source", 'meta[property="og:video"]'):
            node = soup.select_one(selector)
            if not node:
                continue
            if node.name == "meta":
                preview_video_url = self._absolute_url(node.get("content"))
            else:
                preview_video_url = self._absolute_url(node.get("src"))
            if preview_video_url:
                break

        raw_links: dict[str, str] = {}
        for a in soup.find_all("a", href=True):
            href = self._absolute_url(a.get("href"))
            if not href or href.lower().startswith("javascript:"):
                continue

            label_parts = [
                a.get_text(" ", strip=True),
                a.get("title", ""),
                a.get("aria-label", ""),
                a.get("download", ""),
                " ".join(a.get("class", [])),
            ]
            label = self._normalize_text(" ".join(part for part in label_parts if part))
            if not label:
                label = href
            raw_links[label] = href

        def pick_link(
            required_any: tuple[str, ...] = (),
            required_all: tuple[str, ...] = (),
            excluded: tuple[str, ...] = (),
            href_suffixes: tuple[str, ...] = (),
        ) -> str | None:
            for label, href in raw_links.items():
                lowered = label.lower()
                if required_any and not any(token in lowered for token in required_any):
                    continue
                if required_all and not all(token in lowered for token in required_all):
                    continue
                if excluded and any(token in lowered for token in excluded):
                    continue
                if href_suffixes and not href.lower().split("?", 1)[0].endswith(href_suffixes):
                    continue
                return href
            return None

        mp3_url = pick_link(
            required_any=("mp3", "audio", "music"),
            excluded=("mp4", "video"),
        ) or pick_link(href_suffixes=(".mp3",))

        hd_url = pick_link(
            required_any=("hd", "high quality", "high-quality", "original"),
            excluded=("mp3", "audio"),
        )

        no_watermark_url = pick_link(
            required_any=("without watermark", "no watermark", "download without watermark"),
            excluded=("mp3", "audio"),
        )

        watermark_url = pick_link(
            required_any=("with watermark", "watermark"),
            excluded=("without",),
        )

        if hd_url and no_watermark_url == hd_url:
            alt_no_watermark = pick_link(
                required_any=("without watermark", "no watermark", "download without watermark"),
                excluded=("hd", "high quality", "mp3", "audio"),
            )
            if alt_no_watermark:
                no_watermark_url = alt_no_watermark

        if not no_watermark_url and hd_url:
            no_watermark_url = hd_url

        if not preview_video_url:
            preview_video_url = no_watermark_url or hd_url or watermark_url

        return TikTokResult(
            source_url=source_url,
            title=title,
            cover_url=cover_url,
            preview_video_url=preview_video_url,
            no_watermark_url=no_watermark_url,
            hd_url=hd_url,
            mp3_url=mp3_url,
            watermark_url=watermark_url,
            raw_links=raw_links,
        )

    @staticmethod
    def _safe_string(value: Any, default: str = "") -> str:
        if value is None:
            return default
        text = str(value).strip()
        return text or default

    def _format_has_video(self, fmt: dict[str, Any]) -> bool:
        vcodec = self._safe_string(fmt.get("vcodec")).lower()
        return vcodec not in {"", "none"}

    def _format_has_audio(self, fmt: dict[str, Any]) -> bool:
        acodec = self._safe_string(fmt.get("acodec")).lower()
        return acodec not in {"", "none"}

    def _score_instagram_video_format(self, fmt: dict[str, Any], *, default_base: int = 0) -> int:
        fmt_url = self._safe_string(fmt.get("url"))
        if not fmt_url:
            return -10**9

        ext = self._safe_string(fmt.get("ext")).lower()
        protocol = self._safe_string(fmt.get("protocol")).lower()
        height = fmt.get("height") if isinstance(fmt.get("height"), int) else 0
        has_video = self._format_has_video(fmt)
        has_audio = self._format_has_audio(fmt)

        score = default_base + int(height or 0)
        if has_video:
            score += 400
        if has_audio:
            score += 260
        if has_video and has_audio:
            score += 500
        if ext == "mp4" or fmt_url.lower().split("?", 1)[0].endswith(".mp4"):
            score += 150
        if protocol in {"https", "http"}:
            score += 40
        if protocol.startswith("m3u8"):
            score -= 120
        if not has_video:
            score -= 1000
        elif not has_audio:
            score -= 450
        return score

    def _pick_first_video_entry(self, payload: Any) -> dict[str, Any] | None:
        if not isinstance(payload, dict):
            return None

        nested_entries = payload.get("entries")
        if isinstance(nested_entries, list):
            for entry in nested_entries:
                picked = self._pick_first_video_entry(entry)
                if picked:
                    return picked

        direct_url = self._safe_string(payload.get("url"))
        if direct_url and direct_url.lower().split("?", 1)[0].endswith(".mp4"):
            return payload

        formats = payload.get("formats")
        if isinstance(formats, list):
            for fmt in formats:
                if not isinstance(fmt, dict):
                    continue
                fmt_url = self._safe_string(fmt.get("url"))
                ext = self._safe_string(fmt.get("ext")).lower()
                vcodec = self._safe_string(fmt.get("vcodec")).lower()
                if fmt_url and (ext == "mp4" or fmt_url.lower().split("?", 1)[0].endswith(".mp4") or vcodec not in {"", "none"}):
                    return payload
        return None

    def _extract_instagram_result_from_ytdlp(self, source_url: str, info: Any) -> TikTokResult:
        entry = self._pick_first_video_entry(info)
        if not entry:
            raise RuntimeError("yt-dlp لم يجد فيديو داخل رابط Instagram.")

        raw_links: dict[str, str] = {}
        ranked_formats: list[tuple[int, str]] = []
        seen_urls: set[str] = set()

        def add_candidate(label: str, fmt: dict[str, Any], *, default_base: int = 0) -> None:
            candidate_url = self._safe_string(fmt.get("url"))
            if not candidate_url or candidate_url in seen_urls:
                return
            score = self._score_instagram_video_format(fmt, default_base=default_base)
            if score <= -10**8:
                return
            seen_urls.add(candidate_url)
            raw_links[label] = candidate_url
            ranked_formats.append((score, candidate_url))

        direct_url = self._safe_string(entry.get("url"))
        if direct_url:
            add_candidate(
                "instagram_direct",
                {
                    "url": direct_url,
                    "ext": entry.get("ext"),
                    "height": entry.get("height"),
                    "protocol": entry.get("protocol"),
                    "vcodec": entry.get("vcodec"),
                    "acodec": entry.get("acodec"),
                },
                default_base=200,
            )

        requested_formats = entry.get("requested_formats")
        if isinstance(requested_formats, list):
            for index, fmt in enumerate(requested_formats, start=1):
                if not isinstance(fmt, dict):
                    continue
                add_candidate(f"instagram_requested_{index}", fmt, default_base=120)

        formats = entry.get("formats")
        if isinstance(formats, list):
            for index, fmt in enumerate(formats, start=1):
                if not isinstance(fmt, dict):
                    continue
                add_candidate(f"instagram_format_{index}", fmt)

        video_url = max(ranked_formats, key=lambda item: item[0])[1] if ranked_formats else ""
        if not video_url:
            raise RuntimeError("yt-dlp لم يرجع رابط فيديو مباشر صالح.")

        cover_url = self._safe_string(entry.get("thumbnail"))
        thumbnails = entry.get("thumbnails")
        if not cover_url and isinstance(thumbnails, list):
            for thumb in reversed(thumbnails):
                if not isinstance(thumb, dict):
                    continue
                candidate_thumb = self._safe_string(thumb.get("url"))
                if candidate_thumb:
                    cover_url = candidate_thumb
                    break

        title = self._normalize_text(
            self._safe_string(
                entry.get("title")
                or entry.get("description")
                or (info.get("title") if isinstance(info, dict) else "")
                or (info.get("description") if isinstance(info, dict) else "")
                or "Instagram Download"
            )
        ) or "Instagram Download"

        return TikTokResult(
            source_url=source_url,
            title=title,
            cover_url=cover_url or None,
            preview_video_url=video_url,
            no_watermark_url=video_url,
            hd_url=video_url,
            mp3_url=None,
            watermark_url=None,
            raw_links=raw_links,
        )

    def _build_instagram_headers(
        self,
        url: str,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, str]:
        headers = self._build_request_headers(
            url,
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "X-IG-App-ID": INSTAGRAM_APP_ID,
                "X-ASBD-ID": "129477",
            },
        )
        if extra_headers:
            headers.update(extra_headers)
        return headers

    @staticmethod
    def _looks_like_video_url(url: str) -> bool:
        lowered = (url or "").lower()
        return lowered.startswith("http") and any(
            token in lowered
            for token in (
                ".mp4",
                ".m4v",
                ".mov",
                ".webm",
                "mime_type=video_mp4",
                "video_dashinit",
                "cdninstagram.com",
                "fbcdn.net",
            )
        )

    def _extract_direct_video_urls_from_text(self, text: str) -> list[str]:
        normalized = (text or "").replace(r"\/", "/").replace(r"\u0026", "&").replace("&amp;", "&")
        found: list[str] = []
        for raw_url in re.findall(r'https?://[^"\'\s<>]+', normalized):
            candidate = raw_url.strip("'\" ")
            if self._looks_like_video_url(candidate):
                found.append(candidate)
        return found

    def _collect_instagram_video_urls_from_payload(self, payload: Any, collected: list[str] | None = None) -> list[str]:
        results = collected or []
        if isinstance(payload, dict):
            for key, value in payload.items():
                key_lower = str(key).lower()
                if isinstance(value, str):
                    decoded = self._decode_escaped_url(value)
                    if self._looks_like_video_url(decoded) and (
                        key_lower in {"url", "video_url", "contenturl", "src", "playback_url"}
                        or "video" in key_lower
                    ):
                        results.append(decoded)
                    results.extend(self._extract_direct_video_urls_from_text(decoded))
                else:
                    self._collect_instagram_video_urls_from_payload(value, results)
        elif isinstance(payload, list):
            for item in payload:
                self._collect_instagram_video_urls_from_payload(item, results)
        return results

    @staticmethod
    def _rank_direct_video_url(url: str) -> int:
        lowered = (url or "").lower()
        score = 0
        if ".mp4" in lowered or "mime_type=video_mp4" in lowered:
            score += 200
        if "fbcdn.net" in lowered or "cdninstagram.com" in lowered:
            score += 150
        if ".m3u8" in lowered:
            score -= 180
        score += min(len(url or ""), 220)
        return score

    def _pick_best_direct_video_url(self, urls: list[str]) -> str:
        deduped: list[str] = []
        seen: set[str] = set()
        for url in urls:
            candidate = self._decode_escaped_url(url).strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            deduped.append(candidate)
        return max(deduped, key=self._rank_direct_video_url) if deduped else ""

    def _build_instagram_result_from_video_url(
        self,
        source_url: str,
        video_url: str,
        *,
        title: str = "Instagram Download",
        cover_url: str | None = None,
        raw_links: dict[str, str] | None = None,
    ) -> TikTokResult:
        final_title = self._normalize_text(title) or "Instagram Download"
        return TikTokResult(
            source_url=source_url,
            title=final_title,
            cover_url=cover_url or None,
            preview_video_url=video_url,
            no_watermark_url=video_url,
            hd_url=video_url,
            mp3_url=None,
            watermark_url=None,
            raw_links=raw_links or {"instagram_video": video_url},
        )

    def _fetch_instagram_via_ytdlp(self, instagram_url: str) -> TikTokResult:
        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": False,
            "extract_flat": False,
            "socket_timeout": DOWNLOAD_TIMEOUT,
            "http_headers": self._build_instagram_headers(instagram_url),
        }

        cookiefile_path = None
        persistent_cookiefile = str(Path(INSTAGRAM_COOKIES_FILE).expanduser()) if INSTAGRAM_COOKIES_FILE else ""
        try:
            cookiefile_path = self._create_instagram_cookiefile_for_ytdlp()
            if cookiefile_path:
                options["cookiefile"] = cookiefile_path

            browser_name = (INSTAGRAM_COOKIES_FROM_BROWSER or "").split(":", 1)[0].strip().lower()
            if browser_name and not cookiefile_path:
                options["cookiesfrombrowser"] = (browser_name,)

            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(instagram_url, download=False)
            return self._extract_instagram_result_from_ytdlp(instagram_url, info)
        finally:
            if cookiefile_path:
                try:
                    resolved_temp = str(Path(cookiefile_path).expanduser().resolve())
                    resolved_persistent = str(Path(persistent_cookiefile).expanduser().resolve()) if persistent_cookiefile else ""
                    if not resolved_persistent or resolved_temp != resolved_persistent:
                        Path(cookiefile_path).unlink(missing_ok=True)
                except Exception:
                    logger.debug("Could not remove temporary Instagram cookie file", exc_info=True)

    def _extract_instagram_meta_content(self, soup: BeautifulSoup, *selectors: str) -> str:
        for selector in selectors:
            node = soup.select_one(selector)
            if not node:
                continue
            value = self._safe_string(node.get("content") or node.get("href") or node.get_text(" ", strip=True))
            if value:
                return value
        return ""

    def _fetch_instagram_via_webpage(self, instagram_url: str) -> TikTokResult:
        response = self.session.get(
            instagram_url,
            headers=self._build_instagram_headers(
                instagram_url,
                {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
            ),
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        response.raise_for_status()

        content_type = (response.headers.get("Content-Type") or "").lower()
        if "video/" in content_type and response.url:
            return self._build_instagram_result_from_video_url(
                instagram_url,
                response.url,
                raw_links={"instagram_response_video": response.url},
            )

        html = response.text or ""
        soup = BeautifulSoup(html, "html.parser")

        title = self._extract_instagram_meta_content(
            soup,
            'meta[property="og:title"]',
            'meta[name="twitter:title"]',
            "title",
        ) or "Instagram Download"
        cover_url = self._extract_instagram_meta_content(
            soup,
            'meta[property="og:image"]',
            'meta[property="og:image:secure_url"]',
            'meta[name="twitter:image"]',
        )
        video_url = self._extract_instagram_meta_content(
            soup,
            'meta[property="og:video"]',
            'meta[property="og:video:secure_url"]',
            'meta[name="twitter:player:stream"]',
        )

        if not video_url:
            for pattern in (
                r'"video_url":"([^"]+)"',
                r'"contentUrl":"([^"]+)"',
                r'"video_versions":\\[\\{\"type\":[^\\]]*\"url\":\"([^\"]+)\"',
            ):
                match = re.search(pattern, html)
                if match:
                    video_url = self._decode_escaped_url(match.group(1))
                    if video_url:
                        break

        if not video_url:
            video_url = self._pick_best_direct_video_url(self._extract_direct_video_urls_from_text(html))

        if not video_url:
            raise RuntimeError("تعذر استخراج رابط الفيديو من صفحة Instagram مباشرة.")

        return self._build_instagram_result_from_video_url(
            instagram_url,
            video_url,
            title=title,
            cover_url=cover_url or None,
            raw_links={"instagram_meta_video": video_url},
        )

    def _fetch_instagram_via_embed_json(self, instagram_url: str) -> TikTokResult:
        endpoints = [
            f"{instagram_url}?__a=1&__d=dis",
            requests.compat.urljoin(instagram_url, "embed/captioned/"),
        ]
        last_error: Exception | None = None

        for endpoint in endpoints:
            try:
                response = self.session.get(
                    endpoint,
                    headers=self._build_instagram_headers(
                        endpoint,
                        {"Accept": "application/json,text/plain,*/*"},
                    ),
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                )
                response.raise_for_status()
                raw_text = response.text or ""
                payload_text = raw_text.split("\n", 1)[-1] if raw_text.startswith("for (;;);") else raw_text

                parsed_payload: Any = None
                if payload_text.strip().startswith(("{", "[")):
                    try:
                        parsed_payload = json.loads(payload_text)
                    except Exception:
                        parsed_payload = None

                title = "Instagram Download"
                cover_url = None
                video_url = ""
                raw_links: dict[str, str] = {"instagram_embed_endpoint": endpoint}

                if parsed_payload is not None:
                    candidates = self._collect_instagram_video_urls_from_payload(parsed_payload)
                    video_url = self._pick_best_direct_video_url(candidates)
                    if video_url:
                        raw_links["instagram_embed_video"] = video_url

                if not video_url:
                    soup = BeautifulSoup(raw_text, "html.parser")
                    title = self._extract_instagram_meta_content(
                        soup,
                        'meta[property="og:title"]',
                        'meta[name="twitter:title"]',
                        "title",
                    ) or title
                    cover_url = self._extract_instagram_meta_content(
                        soup,
                        'meta[property="og:image"]',
                        'meta[property="og:image:secure_url"]',
                        'meta[name="twitter:image"]',
                    ) or None
                    video_url = self._extract_instagram_meta_content(
                        soup,
                        'meta[property="og:video"]',
                        'meta[property="og:video:secure_url"]',
                        'meta[name="twitter:player:stream"]',
                    )
                    if not video_url:
                        video_url = self._pick_best_direct_video_url(self._extract_direct_video_urls_from_text(raw_text))
                    if video_url:
                        raw_links["instagram_embed_video"] = video_url

                if video_url:
                    return self._build_instagram_result_from_video_url(
                        instagram_url,
                        video_url,
                        title=title,
                        cover_url=cover_url,
                        raw_links=raw_links,
                    )
            except Exception as exc:
                last_error = exc

        raise RuntimeError(f"تعذر استخراج فيديو Instagram من واجهة JSON/Embed: {last_error}")

    def _fetch_instagram_via_instafix(self, instagram_url: str) -> TikTokResult:
        path_parts = urlsplit(instagram_url)
        normalized_path = (path_parts.path.rstrip("/") or "/") + "/"
        candidate_urls = [
            urlunsplit(("https", host, normalized_path, "", ""))
            for host in ("www.ddinstagram.com", "ddinstagram.com", "d.ddinstagram.com")
        ]

        last_error: Exception | None = None
        for candidate_url in candidate_urls:
            try:
                response = self.session.get(
                    candidate_url,
                    headers=self._build_request_headers(
                        candidate_url,
                        {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
                    ),
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                )
                response.raise_for_status()

                content_type = (response.headers.get("Content-Type") or "").lower()
                if "video/" in content_type and response.url:
                    return self._build_instagram_result_from_video_url(
                        instagram_url,
                        response.url,
                        raw_links={"instafix_direct": response.url, "instafix_page": candidate_url},
                    )

                html = response.text or ""
                soup = BeautifulSoup(html, "html.parser")
                title = self._extract_instagram_meta_content(
                    soup,
                    'meta[property="og:title"]',
                    'meta[name="twitter:title"]',
                    "title",
                ) or "Instagram Download"
                cover_url = self._extract_instagram_meta_content(
                    soup,
                    'meta[property="og:image"]',
                    'meta[property="og:image:secure_url"]',
                    'meta[name="twitter:image"]',
                ) or None
                video_url = self._extract_instagram_meta_content(
                    soup,
                    'meta[property="og:video"]',
                    'meta[property="og:video:secure_url"]',
                    'meta[name="twitter:player:stream"]',
                )
                if not video_url:
                    video_url = self._pick_best_direct_video_url(self._extract_direct_video_urls_from_text(html))

                if video_url:
                    return self._build_instagram_result_from_video_url(
                        instagram_url,
                        video_url,
                        title=title,
                        cover_url=cover_url,
                        raw_links={
                            "instafix_page": candidate_url,
                            "instafix_video": video_url,
                        },
                    )
            except Exception as exc:
                last_error = exc

        raise RuntimeError(f"تعذر استخراج فيديو Instagram عبر ddinstagram/InstaFix: {last_error}")

    def _extract_instagram_result(self, source_url: str, payload: Any) -> TikTokResult:
        if not isinstance(payload, dict):
            raise RuntimeError("استجابة Instagram API غير صالحة.")

        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        medias = data.get("medias") if isinstance(data, dict) else None
        if not isinstance(medias, list) or not medias:
            raise RuntimeError("لم يتم العثور على أي وسائط داخل استجابة Instagram API.")

        media_url = None
        cover_url = None
        raw_links: dict[str, str] = {}

        for index, media in enumerate(medias, start=1):
            if not isinstance(media, dict):
                continue
            candidate_url = self._safe_string(media.get("url"))
            candidate_cover = self._safe_string(
                media.get("thumbnail") or media.get("thumb") or media.get("cover") or media.get("image")
            )
            media_type = self._safe_string(media.get("type") or media.get("media_type")).lower()

            if candidate_url:
                raw_links[f"instagram_media_{index}"] = candidate_url
            if candidate_cover and not cover_url:
                cover_url = candidate_cover
            if candidate_url and (
                media_type in {"video", "reel", "mp4"}
                or candidate_url.lower().split("?", 1)[0].endswith((".mp4", ".m4v", ".mov", ".webm"))
            ):
                media_url = candidate_url
                break

        if not media_url:
            raise RuntimeError("لم يتم استخراج رابط فيديو صالح من Instagram API.")

        title = self._safe_string(
            data.get("caption") if isinstance(data, dict) else "",
            default="Instagram Download",
        )
        title = self._normalize_text(title) or "Instagram Download"

        return TikTokResult(
            source_url=source_url,
            title=title,
            cover_url=cover_url,
            preview_video_url=media_url,
            no_watermark_url=media_url,
            hd_url=media_url,
            mp3_url=None,
            watermark_url=None,
            raw_links=raw_links,
        )

    def _fetch_instagram_via_rapidapi(self, instagram_url: str) -> TikTokResult:
        if not RAPIDAPI_KEY:
            raise RuntimeError("RAPIDAPI_KEY غير مضبوط.")

        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                response = requests.get(
                    INSTAGRAM_RAPIDAPI_ENDPOINT,
                    params={"url": instagram_url},
                    headers={
                        "x-rapidapi-key": RAPIDAPI_KEY,
                        "x-rapidapi-host": INSTAGRAM_RAPIDAPI_HOST,
                    },
                    timeout=REQUEST_TIMEOUT,
                )
                response.raise_for_status()
                return self._extract_instagram_result(instagram_url, response.json())
            except Exception as exc:
                last_error = exc
                logger.warning("Instagram RapidAPI attempt %s/3 failed: %s", attempt, exc)
                if attempt < 3:
                    time.sleep(attempt)

        raise RuntimeError(f"RapidAPI فشل بعد عدة محاولات: {last_error}")

    def fetch_instagram(self, instagram_url: str, *, force_refresh: bool = False) -> TikTokResult:
        cleaned_url = self._canonical_instagram_url(instagram_url)
        cache_key = f"instagram::{cleaned_url}"
        cached = None if force_refresh else self._get_cached_result(cache_key)
        if cached:
            return cached

        has_instagram_auth = any(
            (
                INSTAGRAM_SESSIONID,
                INSTAGRAM_COOKIES,
                INSTAGRAM_COOKIES_FILE,
                INSTAGRAM_COOKIES_FROM_BROWSER,
            )
        )

        attempts: list[tuple[str, Any]] = []
        if has_instagram_auth:
            attempts.append(("yt-dlp-auth", self._fetch_instagram_via_ytdlp))

        attempts.extend(
            [
                ("webpage", self._fetch_instagram_via_webpage),
                ("embed/json", self._fetch_instagram_via_embed_json),
                ("instafix", self._fetch_instagram_via_instafix),
            ]
        )

        if not has_instagram_auth:
            attempts.append(("yt-dlp", self._fetch_instagram_via_ytdlp))

        if RAPIDAPI_KEY:
            attempts.append(("rapidapi", self._fetch_instagram_via_rapidapi))

        errors: list[str] = []
        for method_name, method in attempts:
            try:
                result = method(cleaned_url)
                self._set_cached_result(cache_key, result)
                return result
            except Exception as exc:
                logger.warning("Instagram fetch via %s failed: %s", method_name, exc)
                errors.append(f"{method_name}: {exc}")

        joined_errors = " | ".join(errors) if errors else "لا توجد تفاصيل إضافية."
        raise RuntimeError(
            "تعذر تجهيز فيديو Instagram بهذا الرابط. للمنشور الخاص يجب أن يكون حساب البوت مسجلاً ومسموحاً له بمشاهدة المنشور.\n"
            "أضف جلسة صالحة عبر INSTAGRAM_COOKIES_FILE أو INSTAGRAM_COOKIES؛ لا يمكن فتح محتوى لا يراه الحساب.\n"
            f"تفاصيل المحاولات: {joined_errors}"
        )

    def download_instagram_via_ytdlp(self, instagram_url: str) -> Path:
        """Download from the post URL so yt-dlp can refresh CDN URLs and use authorized cookies."""
        work_dir = Path(tempfile.mkdtemp(prefix="instagram_ytdlp_"))
        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "merge_output_format": "mp4",
            "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
            "socket_timeout": DOWNLOAD_TIMEOUT,
            "retries": 3,
            "fragment_retries": 3,
            "extractor_retries": 3,
            "file_access_retries": 2,
            "max_filesize": MAX_DOWNLOAD_MB * 1024 * 1024,
            "http_headers": self._build_instagram_headers(instagram_url),
        }
        cookiefile_path = None
        persistent_cookiefile = str(Path(INSTAGRAM_COOKIES_FILE).expanduser()) if INSTAGRAM_COOKIES_FILE else ""
        try:
            cookiefile_path = self._create_instagram_cookiefile_for_ytdlp()
            if cookiefile_path:
                options["cookiefile"] = cookiefile_path
            browser_name = (INSTAGRAM_COOKIES_FROM_BROWSER or "").split(":", 1)[0].strip().lower()
            if browser_name and not cookiefile_path:
                options["cookiesfrombrowser"] = (browser_name,)

            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([instagram_url])

            allowed_extensions = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}
            candidates = [
                path for path in work_dir.iterdir()
                if path.is_file() and path.suffix.lower() in allowed_extensions and not path.name.endswith(".part")
            ]
            if not candidates:
                raise RuntimeError("yt-dlp لم يُنتج ملف فيديو صالحاً من رابط المنشور.")
            downloaded = max(candidates, key=lambda path: path.stat().st_size)
            if downloaded.stat().st_size > MAX_DOWNLOAD_MB * 1024 * 1024:
                raise RuntimeError(f"حجم فيديو Instagram يتجاوز الحد المسموح {MAX_DOWNLOAD_MB}MB.")
            return downloaded
        except Exception as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise RuntimeError(
                "فشل التنزيل المباشر من منشور Instagram. إذا كان خاصاً، اضبط INSTAGRAM_COOKIES_FILE "
                "بملف كوكيز لحساب مسموح له بمشاهدته؛ لا يمكن تجاوز إعدادات الخصوصية."
            ) from exc
        finally:
            if cookiefile_path:
                try:
                    resolved_temp = str(Path(cookiefile_path).expanduser().resolve())
                    resolved_persistent = str(Path(persistent_cookiefile).expanduser().resolve()) if persistent_cookiefile else ""
                    if not resolved_persistent or resolved_temp != resolved_persistent:
                        Path(cookiefile_path).unlink(missing_ok=True)
                except Exception:
                    logger.debug("Could not remove temporary Instagram cookie file", exc_info=True)

    def fetch_external_video(self, source_url: str, platform: str) -> TikTokResult:
        options = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "extract_flat": False,
            "socket_timeout": REQUEST_TIMEOUT,
        }
        cookies_file = Path(YTDLP_COOKIES_FILE).expanduser() if YTDLP_COOKIES_FILE else None
        if cookies_file and cookies_file.is_file():
            options["cookiefile"] = str(cookies_file)
        browser_name = YTDLP_COOKIES_FROM_BROWSER.split(":", 1)[0].strip().lower()
        if browser_name and "cookiefile" not in options:
            options["cookiesfrombrowser"] = (browser_name,)

        errors: list[Exception] = []
        info = None
        attempts = _ytdlp_attempt_options(options, platform)
        for attempt_number, attempt_options in enumerate(attempts, start=1):
            try:
                with yt_dlp.YoutubeDL(attempt_options) as ydl:
                    info = ydl.extract_info(source_url, download=False)
                break
            except Exception as exc:
                errors.append(exc)
                logger.warning(
                    "yt-dlp metadata attempt %s/%s failed for %s: %s",
                    attempt_number, len(attempts), platform, exc,
                )
        if isinstance(info, dict) and isinstance(info.get("entries"), list):
            info = next((entry for entry in info["entries"] if isinstance(entry, dict)), None)
        if not isinstance(info, dict):
            if not errors:
                errors.append(RuntimeError(f"لم يعثر yt-dlp على فيديو صالح في رابط {platform}."))
            raise RuntimeError(_external_platform_error(platform, errors))

        title = self._normalize_text(self._safe_string(info.get("title"), default=f"فيديو {platform}"))
        cover_url = self._safe_string(info.get("thumbnail")) or None
        is_soundcloud = platform == "SoundCloud"
        return TikTokResult(
            source_url=source_url,
            title=title or f"فيديو {platform}",
            cover_url=cover_url,
            preview_video_url=None if is_soundcloud else source_url,
            no_watermark_url=None if is_soundcloud else source_url,
            hd_url=None if is_soundcloud else source_url,
            mp3_url=source_url if is_soundcloud else None,
            watermark_url=None,
            raw_links={"source_page": source_url},
        )

    def download_external_audio_via_ytdlp(self, source_url: str, platform: str) -> Path:
        work_dir = Path(tempfile.mkdtemp(prefix="ytdlp_audio_"))
        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bestaudio/best",
            "outtmpl": str(work_dir / "%(id)s.%(ext)s"),
            "socket_timeout": DOWNLOAD_TIMEOUT,
            "retries": 3,
            "max_filesize": MAX_DOWNLOAD_MB * 1024 * 1024,
        }
        cookies_file = Path(YTDLP_COOKIES_FILE).expanduser() if YTDLP_COOKIES_FILE else None
        if cookies_file and cookies_file.is_file():
            options["cookiefile"] = str(cookies_file)
        browser_name = YTDLP_COOKIES_FROM_BROWSER.split(":", 1)[0].strip().lower()
        if browser_name and "cookiefile" not in options:
            options["cookiesfrombrowser"] = (browser_name,)
        if shutil.which("ffmpeg"):
            options["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]

        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([source_url])
            allowed_extensions = {".mp3", ".m4a", ".ogg", ".opus", ".webm", ".wav", ".flac"}
            candidates = [
                path for path in work_dir.iterdir()
                if path.is_file() and path.suffix.lower() in allowed_extensions and not path.name.endswith(".part")
            ]
            if not candidates:
                raise RuntimeError("لم ينتج yt-dlp ملفاً صوتياً صالحاً.")
            downloaded = max(candidates, key=lambda path: path.stat().st_size)
            if downloaded.stat().st_size > MAX_DOWNLOAD_MB * 1024 * 1024:
                raise RuntimeError(f"حجم الصوت يتجاوز الحد المسموح {MAX_DOWNLOAD_MB}MB.")
            return downloaded
        except Exception as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise RuntimeError(f"تعذر تنزيل الصوت من {platform}. قد يكون الرابط خاصاً أو غير متاح.") from exc

    def download_external_video_via_ytdlp(self, source_url: str, platform: str) -> Path:
        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "format": "bestvideo*+bestaudio/best",
            "merge_output_format": "mp4",
            "socket_timeout": DOWNLOAD_TIMEOUT,
            "retries": 3,
            "fragment_retries": 3,
            "concurrent_fragment_downloads": 8,
            "extractor_retries": 3,
            "file_access_retries": 2,
            "max_filesize": MAX_DOWNLOAD_MB * 1024 * 1024,
        }
        if not shutil.which("ffmpeg"):
            options["format"] = "best[ext=mp4]/best"
            options.pop("merge_output_format", None)
        cookies_file = Path(YTDLP_COOKIES_FILE).expanduser() if YTDLP_COOKIES_FILE else None
        if cookies_file and cookies_file.is_file():
            options["cookiefile"] = str(cookies_file)
        browser_name = YTDLP_COOKIES_FROM_BROWSER.split(":", 1)[0].strip().lower()
        if browser_name and "cookiefile" not in options:
            options["cookiesfrombrowser"] = (browser_name,)
        if platform == "Snapchat" and shutil.which("aria2c"):
            options["external_downloader"] = "aria2c"
            options["external_downloader_args"] = {
                "aria2c": ["-c", "-x", "8", "-s", "8", "-k", "1M"],
            }

        errors: list[Exception] = []
        attempts = _ytdlp_attempt_options(options, platform)
        allowed_extensions = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}
        for attempt_number, attempt_options in enumerate(attempts, start=1):
            work_dir = Path(tempfile.mkdtemp(prefix="ytdlp_video_"))
            attempt_options = {**attempt_options, "outtmpl": str(work_dir / "%(id)s.%(ext)s")}
            try:
                with yt_dlp.YoutubeDL(attempt_options) as ydl:
                    ydl.download([source_url])
                candidates = [
                    path for path in work_dir.iterdir()
                    if path.is_file() and path.suffix.lower() in allowed_extensions and not path.name.endswith(".part")
                ]
                if not candidates:
                    raise RuntimeError("لم ينتج yt-dlp ملف فيديو.")
                downloaded = max(candidates, key=lambda path: path.stat().st_size)
                if downloaded.stat().st_size > MAX_DOWNLOAD_MB * 1024 * 1024:
                    raise RuntimeError(f"حجم الفيديو يتجاوز الحد المسموح {MAX_DOWNLOAD_MB}MB.")
                return downloaded
            except Exception as exc:
                errors.append(exc)
                shutil.rmtree(work_dir, ignore_errors=True)
                logger.warning(
                    "yt-dlp download attempt %s/%s failed for %s: %s",
                    attempt_number, len(attempts), platform, exc,
                )
        raise RuntimeError(_external_platform_error(platform, errors)) from (errors[-1] if errors else None)

    def download_file(self, url: str, suffix: str) -> Path:
        fd, temp_path = tempfile.mkstemp(prefix="tiktok_store_", suffix=suffix)
        os.close(fd)
        path = Path(temp_path)
        total_bytes = 0
        started_at = time.monotonic()
        try:
            response = self.session.get(
                url,
                stream=True,
                allow_redirects=True,
                timeout=DOWNLOAD_TIMEOUT,
                headers=self._build_request_headers(url),
            )
            response.raise_for_status()
            content_length_header = (response.headers.get("Content-Length") or "0").strip()
            if content_length_header.isdigit() and int(content_length_header) > MAX_DOWNLOAD_MB * 1024 * 1024:
                raise RuntimeError(f"حجم المصدر يتجاوز الحد المسموح {MAX_DOWNLOAD_MB}MB.")
            content_type = (response.headers.get("Content-Type") or "").lower()
            if "text/html" in content_type:
                raise RuntimeError("أعاد الخادم صفحة خطأ بدلاً من ملف الفيديو؛ قد يكون رابط CDN انتهت صلاحيته (403).")
            with path.open("wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 64):
                    if not chunk:
                        continue
                    if time.monotonic() - started_at > MAX_TRANSFER_SECONDS:
                        raise RuntimeError(f"تجاوز تنزيل الفيديو {MAX_TRANSFER_SECONDS} ثانية وتم إيقافه.")
                    total_bytes += len(chunk)
                    if total_bytes > MAX_DOWNLOAD_MB * 1024 * 1024:
                        raise RuntimeError(f"تم إيقاف التحميل لأن الملف تجاوز {MAX_DOWNLOAD_MB}MB.")
                    f.write(chunk)
            response.close()

            if total_bytes == 0:
                raise RuntimeError("تم إنشاء ملف فارغ. رابط التنزيل غير صالح أو انتهت صلاحيته.")
            return path
        except Exception:
            try:
                response.close()
            except (UnboundLocalError, Exception):
                pass
            path.unlink(missing_ok=True)
            raise


def compress_video_file(input_path: Path, *, crop_top_percent: int = 0) -> Path:
    """Encode a broadly compatible MP4 sized for Telegram's hosted Bot API limit."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("لا يوجد ffmpeg على الخادم؛ ثبّته لتفعيل خيار ضغط الفيديو.")
    deadline = time.monotonic() + max(60, MAX_COMPRESSION_SECONDS)

    ffprobe = shutil.which("ffprobe")
    duration = 0.0
    if ffprobe:
        try:
            result = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(input_path)],
                check=True, capture_output=True, text=True, timeout=30,
            )
            duration = float(result.stdout.strip() or 0)
        except Exception:
            logger.warning("Could not read video duration; will use conservative compression", exc_info=True)

    cap_bytes = max(8, MAX_LOCAL_UPLOAD_MB - 2) * 1024 * 1024
    target_bytes = min(cap_bytes, 46 * 1024 * 1024)
    output_path = input_path.with_name(input_path.stem + "_compressed.mp4")
    audio_bitrate = 96000
    base_video_bitrate = int((target_bytes * 8 / duration - audio_bitrate - 24000) if duration > 0 else 700000)
    base_video_bitrate = max(180000, min(base_video_bitrate, 5000000))

    try:
        for scale_width, factor in ((1280, 1.0), (960, 0.72), (720, 0.48), (480, 0.30)):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"تجاوز ضغط الفيديو {MAX_COMPRESSION_SECONDS} ثانية وتم إيقافه.")
            video_bitrate = max(140000, int(base_video_bitrate * factor))
            filters: list[str] = []
            if crop_top_percent:
                crop_percent = max(5, min(40, int(crop_top_percent)))
                filters.append(
                    f"crop=iw:trunc(ih*{100 - crop_percent}/200)*2:0:trunc(ih*{crop_percent}/200)*2"
                )
            filters.append(f"scale=w='min({scale_width},iw)':h=-2")
            encode_preset = "ultrafast" if crop_top_percent else "veryfast"
            command = [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_path),
                "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn",
                "-vf", ",".join(filters),
                "-c:v", "libx264", "-preset", encode_preset, "-b:v", str(video_bitrate),
                "-maxrate", str(video_bitrate), "-bufsize", str(video_bitrate * 2),
                "-c:a", "aac", "-b:a", str(audio_bitrate), "-movflags", "+faststart", str(output_path),
            ]
            proc = subprocess.run(command, capture_output=True, text=True, timeout=remaining)
            if proc.returncode == 0 and output_path.exists() and output_path.stat().st_size <= cap_bytes:
                input_path.unlink(missing_ok=True)
                return output_path
            output_path.unlink(missing_ok=True)

        raise RuntimeError(
            f"تعذر ضغط الفيديو إلى أقل من {MAX_LOCAL_UPLOAD_MB}MB. جرّب فيديو أقصر أو ارفع حد الرفع في MAX_LOCAL_UPLOAD_MB."
        )
    except subprocess.TimeoutExpired as exc:
        output_path.unlink(missing_ok=True)
        raise RuntimeError("استغرق ضغط الفيديو وقتاً أطول من المسموح.") from exc
    except Exception:
        output_path.unlink(missing_ok=True)
        raise


def crop_snapchat_video_file(input_path: Path) -> Path:
    """Crop the Snapchat Spotlight overlay at the top edge, preserving the soundtrack."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("يلزم تثبيت ffmpeg على الخادم لقص علامة Snapchat من أعلى الفيديو.")
    crop_percent = max(5, min(40, SNAPCHAT_CROP_TOP_PERCENT))
    output_path = input_path.with_name(input_path.stem + "_cropped.mp4")
    crop_filter = (
        f"crop=iw:trunc(ih*{100 - crop_percent}/200)*2:0:trunc(ih*{crop_percent}/200)*2"
    )
    duration = 0.0
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            probe = subprocess.run(
                [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(input_path)],
                check=True, capture_output=True, text=True, timeout=20,
            )
            duration = float(probe.stdout.strip() or 0)
        except Exception:
            logger.debug("Could not read Snapchat clip duration for fast crop encoding", exc_info=True)
    upload_cap = max(8, min(MAX_LOCAL_UPLOAD_MB, 48) - 2) * 1024 * 1024
    target_bytes = min(upload_cap, max(1024 * 1024, int(input_path.stat().st_size * 1.10)))
    audio_bitrate = 96000
    video_bitrate = int(target_bytes * 8 / duration - audio_bitrate) if duration > 0 else 1000000
    video_bitrate = max(200000, min(video_bitrate, 6000000))
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(input_path),
        "-map", "0:v:0", "-map", "0:a?", "-sn", "-dn", "-vf", crop_filter,
        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", str(video_bitrate),
        "-maxrate", str(video_bitrate), "-bufsize", str(video_bitrate * 2),
        "-c:a", "aac", "-b:a", str(audio_bitrate), "-movflags", "+faststart", str(output_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=max(180, DOWNLOAD_TIMEOUT * 4))
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("لم ينتج ffmpeg فيديو مقصوصاً صالحاً.")
        input_path.unlink(missing_ok=True)
        return output_path
    except subprocess.TimeoutExpired as exc:
        output_path.unlink(missing_ok=True)
        raise RuntimeError("استغرق قصّ فيديو Snapchat وقتاً أطول من المسموح.") from exc
    except Exception:
        output_path.unlink(missing_ok=True)
        raise


client = TikTokIOClient()
LOCAL_DOWNLOAD_SEMAPHORE: asyncio.Semaphore | None = None


# ==============================
# واجهات تيليجرام
# ==============================
def build_choice_keyboard(result: TikTokResult, ref_id: str) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []

    if result.mp3_url:
        rows.append([InlineKeyboardButton("تحميل MP3", callback_data=f"dl:mp3:{ref_id}")])

    if result.hd_url or result.no_watermark_url:
        rows.append([InlineKeyboardButton("أعلى دقة (قد يُضغط للحجم)", callback_data=f"dl:hd:{ref_id}")])
        rows.append([InlineKeyboardButton("تحميل بحجم أقل (ضغط)", callback_data=f"dl:compressed:{ref_id}")])

    rows.append([InlineKeyboardButton("إعادة التحضير", callback_data=f"dl:refresh:{ref_id}")])
    return InlineKeyboardMarkup(rows)


def build_admin_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("تغيير رسالة /start", callback_data="admin:set_start")],
            [InlineKeyboardButton("إذاعة للمستخدمين", callback_data="admin:broadcast")],
            [InlineKeyboardButton("إعداد الاشتراك الإجباري", callback_data="admin:force_sub")],
            [InlineKeyboardButton("تعطيل الاشتراك الإجباري", callback_data="admin:disable_force_sub")],
            [InlineKeyboardButton("الإحصائيات", callback_data="admin:stats")],
            [InlineKeyboardButton("عرض رسالة /start الحالية", callback_data="admin:view_start")],
        ]
    )


def build_subscription_keyboard(settings: dict[str, Any]) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    join_url = (settings.get("force_sub_url") or "").strip()
    if join_url:
        rows.append([InlineKeyboardButton("اشترك الآن", url=join_url)])
    rows.append([InlineKeyboardButton("تحقق من الاشتراك", callback_data="sub:verify")])
    return InlineKeyboardMarkup(rows)


def save_result(context: ContextTypes.DEFAULT_TYPE, user_id: int, result: TikTokResult) -> str:
    _cleanup_expired_results(context)
    store = context.bot_data.setdefault("downloads", {})
    ref_id = uuid.uuid4().hex[:12]
    store[ref_id] = {
        "user_id": user_id,
        "title": result.title,
        "source_url": result.source_url,
        "cover_url": result.cover_url,
        "preview_video_url": result.preview_video_url,
        "no_watermark_url": result.no_watermark_url,
        "hd_url": result.hd_url,
        "mp3_url": result.mp3_url,
        "watermark_url": result.watermark_url,
        "created_at": time.time(),
    }
    return ref_id


async def enforce_force_subscription(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    prompt: bool = True,
) -> bool:
    user = update.effective_user
    if not user or is_developer(user.id):
        return True

    settings = get_settings(context)
    if not settings.get("force_sub_enabled"):
        return True

    target_chat = str(settings.get("force_sub_chat_id") or "").strip()
    if not target_chat:
        return True

    try:
        member = await context.bot.get_chat_member(chat_id=target_chat, user_id=user.id)
        if member.status in {"member", "administrator", "creator"}:
            return True
    except Exception as exc:
        logger.warning("Force subscription check failed: %s", exc)
        # لو فحص العضوية فشل بسبب إعدادات القناة، لا نمنع المستخدم حتى لا يتعطل البوت بالكامل.
        return True

    if prompt:
        text = settings.get("force_sub_text") or FORCE_SUB_TEXT_DEFAULT
        keyboard = build_subscription_keyboard(settings)
        if update.callback_query and update.callback_query.message:
            await update.callback_query.message.reply_text(text, reply_markup=keyboard)
        elif update.effective_message:
            await update.effective_message.reply_text(text, reply_markup=keyboard)
    return False


async def send_start_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message:
        return

    settings = get_settings(context)
    text = settings.get("start_message") or START_MESSAGE_DEFAULT

    if update.effective_user and is_developer(update.effective_user.id):
        text += (
            "\n\n━━━━━━━━━━\n"
            "أوامر المطور:\n"
            "/admin - لوحة المطور\n"
            "/stats - الإحصائيات\n"
            "/ping - فحص حالة البوت\n"
            "/cancel - إلغاء العملية الحالية\n"
        )
        await update.effective_message.reply_text(text, reply_markup=build_admin_keyboard())
    else:
        await update.effective_message.reply_text(text)


async def start_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message:
        return
    register_user(update, context)
    if not await enforce_force_subscription(update, context):
        return
    await send_start_message(update, context)


async def help_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message:
        return
    register_user(update, context)
    if not await enforce_force_subscription(update, context):
        return
    await update.effective_message.reply_text(
        "ابعت أي رابط TikTok مباشر أو مختصر، والبوت هيطلعلك خيارات التحميل المتاحة."
    )


async def cancel_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data.pop("pending_action", None)
    if update.effective_message:
        await update.effective_message.reply_text("تم إلغاء العملية الحالية.")


async def ping_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message or not update.effective_user:
        return
    if not is_developer(update.effective_user.id):
        await update.effective_message.reply_text("هذا الأمر للمطور فقط.")
        return

    store = context.bot_data.get("downloads", {})
    users = context.bot_data.setdefault("users", get_users())
    mode = "Webhook" if _should_use_webhook() else "Polling"
    await update.effective_message.reply_text(
        "البوت شغال ✅\n"
        f"الوضع: {mode}\n"
        f"عدد المستخدمين: {len(users)}\n"
        f"العناصر المؤقتة: {len(store)}\n"
        f"المنفذ: {PORT}\n"
        f"مدة التشغيل: {format_uptime(int(time.time() - APP_START_TIME))}"
    )


async def stats_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message or not update.effective_user:
        return
    if not is_developer(update.effective_user.id):
        await update.effective_message.reply_text("هذا الأمر للمطور فقط.")
        return

    users = context.bot_data.setdefault("users", get_users())
    settings = get_settings(context)
    store = context.bot_data.get("downloads", {})
    mode = "Webhook" if _should_use_webhook() else "Polling"
    force_sub = "مفعل" if settings.get("force_sub_enabled") else "معطل"
    force_sub_target = settings.get("force_sub_chat_id") or "غير محدد"

    await update.effective_message.reply_text(
        "إحصائيات البوت 📊\n\n"
        f"المستخدمون المسجلون: {len(users)}\n"
        f"الطلبات المؤقتة: {len(store)}\n"
        f"الاشتراك الإجباري: {force_sub}\n"
        f"القناة/المعرف: {force_sub_target}\n"
        f"الوضع: {mode}\n"
        f"مدة التشغيل: {format_uptime(int(time.time() - APP_START_TIME))}"
    )


async def admin_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message or not update.effective_user:
        return
    if not is_developer(update.effective_user.id):
        await update.effective_message.reply_text("هذا الأمر للمطور فقط.")
        return
    await update.effective_message.reply_text("لوحة المطور", reply_markup=build_admin_keyboard())


async def process_admin_pending_text(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str) -> bool:
    user = update.effective_user
    message = update.effective_message
    if not user or not message or not is_developer(user.id):
        return False

    pending = context.user_data.get("pending_action")
    if not pending:
        return False

    settings = get_settings(context)

    if pending == "set_start_message":
        settings["start_message"] = text.strip() or START_MESSAGE_DEFAULT
        save_settings(context, settings)
        context.user_data.pop("pending_action", None)
        await message.reply_text("تم حفظ رسالة /start الجديدة ✅", reply_markup=build_admin_keyboard())
        return True

    if pending == "set_force_sub":
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            await message.reply_text(
                "الصيغة غير صحيحة.\nأرسل في السطر الأول معرف القناة أو يوزر القناة مثل @channel\n"
                "وفي السطر الثاني رابط الانضمام إن وجد."
            )
            return True

        chat_id_value = lines[0]
        join_url = lines[1] if len(lines) > 1 else ""
        custom_text = "\n".join(lines[2:]).strip() if len(lines) > 2 else ""

        settings["force_sub_enabled"] = True
        settings["force_sub_chat_id"] = chat_id_value
        settings["force_sub_url"] = join_url
        if custom_text:
            settings["force_sub_text"] = custom_text
        save_settings(context, settings)
        context.user_data.pop("pending_action", None)
        await message.reply_text(
            "تم حفظ إعدادات الاشتراك الإجباري ✅\n"
            f"المعرف/القناة: {chat_id_value}\n"
            f"الرابط: {join_url or 'غير مضاف'}",
            reply_markup=build_admin_keyboard(),
        )
        return True

    if pending == "broadcast_message":
        context.user_data.pop("pending_action", None)
        users = context.bot_data.setdefault("users", get_users())
        total = 0
        success = 0
        failed = 0

        progress = await message.reply_text("بدأت الإذاعة... انتظر حتى تنتهي.")

        for user_id in list(users.keys()):
            total += 1
            try:
                await context.bot.send_message(chat_id=int(user_id), text=text)
                success += 1
            except Exception:
                failed += 1
            if total % 25 == 0:
                try:
                    await progress.edit_text(
                        f"جاري الإذاعة...\nتمت المحاولة: {total}\nنجح: {success}\nفشل: {failed}"
                    )
                except Exception:
                    pass
                await asyncio.sleep(0.1)

        await progress.edit_text(
            "انتهت الإذاعة ✅\n"
            f"إجمالي المحاولات: {total}\n"
            f"نجح: {success}\n"
            f"فشل: {failed}"
        )
        return True

    return False


async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.effective_message or not update.effective_user or not update.effective_chat:
        return

    register_user(update, context)

    text = (update.effective_message.text or "").strip()
    if await process_admin_pending_text(update, context, text):
        return

    if not await enforce_force_subscription(update, context):
        return

    instagram_match = INSTAGRAM_URL_RE.search(text)
    tiktok_match = TIKTOK_URL_RE.search(text)
    youtube_match = YOUTUBE_URL_RE.search(text)
    snapchat_match = SNAPCHAT_URL_RE.search(text)
    facebook_match = FACEBOOK_URL_RE.search(text)
    twitter_match = TWITTER_URL_RE.search(text)
    soundcloud_match = SOUNDCLOUD_URL_RE.search(text)
    pinterest_match = PINTEREST_URL_RE.search(text)
    likee_match = LIKEE_URL_RE.search(text)
    kwai_match = KWAI_URL_RE.search(text)

    if instagram_match:
        source_label = "Instagram"
        target_url = instagram_match.group(0)
        fetcher = client.fetch_instagram
    elif tiktok_match:
        source_label = "TikTok"
        target_url = tiktok_match.group(0)
        fetcher = client.fetch
    elif youtube_match:
        source_label = "YouTube"
        target_url = youtube_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "YouTube")
    elif snapchat_match:
        source_label = "Snapchat Spotlight"
        target_url = snapchat_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "Snapchat")
    elif facebook_match:
        source_label = "Facebook"
        target_url = facebook_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "Facebook")
    elif twitter_match:
        source_label = "X/Twitter"
        target_url = twitter_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "X/Twitter")
    elif soundcloud_match:
        source_label = "SoundCloud"
        target_url = soundcloud_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "SoundCloud")
    elif pinterest_match:
        source_label = "Pinterest"
        target_url = pinterest_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "Pinterest")
    elif likee_match:
        source_label = "Likee"
        target_url = likee_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "Likee")
    elif kwai_match:
        source_label = "Kwai"
        target_url = kwai_match.group(0)
        fetcher = lambda url: client.fetch_external_video(url, "Kwai")
    else:
        await update.effective_message.reply_text(
            "ابعت رابطاً من TikTok أو Instagram أو YouTube أو Snapchat Spotlight أو Facebook أو X/Twitter أو SoundCloud أو Pinterest أو Likee أو Kwai."
        )
        return

    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.TYPING)
    status = await update.effective_message.reply_text(f"جاري تجهيز رابط {source_label}، انتظر لحظة...")

    try:
        result = await asyncio.to_thread(fetcher, target_url)
    except Exception as exc:
        logger.exception("Failed to fetch media link from %s", source_label)
        await status.edit_text(f"حصل خطأ أثناء معالجة رابط {source_label}:\n{exc}")
        return

    ref_id = save_result(context, update.effective_user.id, result)
    keyboard = build_choice_keyboard(result, ref_id)
    caption = result.title if len(result.title) <= 900 else result.title[:900] + "..."

    try:
        await status.delete()
    except Exception:
        logger.debug("Could not delete status message", exc_info=True)

    if result.cover_url:
        try:
            await context.bot.send_chat_action(chat_id=update.effective_chat.id, action=ChatAction.UPLOAD_PHOTO)
            await update.effective_message.reply_photo(
                photo=result.cover_url,
                caption=f"{caption}\n\nاختر طريقة التحميل من الأزرار بالأسفل:",
                reply_markup=keyboard,
            )
            return
        except Exception as exc:
            logger.warning("Remote preview photo send failed: %s", exc)

    await update.effective_message.reply_text(
        f"تم تجهيز رابط {source_label}: {caption}\n\nاختر طريقة التحميل:",
        reply_markup=keyboard,
    )


def _format_size_mb(byte_count: int | None) -> str:
    if not byte_count or byte_count <= 0:
        return "غير معروف"
    return f"{byte_count / (1024 * 1024):.1f}MB"


def _is_instagram_media_like_url(url: str) -> bool:
    lowered = (url or "").lower()
    return any(
        token in lowered
        for token in (
            "instagram.com",
            "cdninstagram.com",
            "fbcdn.net",
            "scontent",
        )
    )


async def deliver_remote_or_local(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
    *,
    direct_url: str,
    kind: str,
    title: str,
    source_url: str | None = None,
    progress_message: Any | None = None,
) -> None:
    message = update.callback_query.message if update.callback_query else update.effective_message
    if not message:
        raise RuntimeError("تعذر الوصول للرسالة الحالية.")

    async def report_progress(text: str) -> None:
        if not progress_message:
            return
        try:
            await progress_message.edit_text(text)
        except Exception:
            logger.debug("Could not update download progress message", exc_info=True)

    source_platform = _video_platform(source_url or "")
    if kind == "mp3" and source_platform != "SoundCloud":
        try:
            await message.reply_audio(
                audio=direct_url,
                caption=title,
                title=(title[:64] if title else "TikTok Audio"),
                performer=source_platform or "TikTok",
            )
            return
        except Exception as exc:
            logger.warning("Direct remote audio send failed: %s", exc)
    semaphore = context.bot_data.get("local_download_semaphore")
    if semaphore is None:
        semaphore = asyncio.Semaphore(max(1, LOCAL_DOWNLOAD_CONCURRENCY))
        context.bot_data["local_download_semaphore"] = semaphore

    suffix = ".mp3" if kind == "mp3" else ".mp4"
    action = ChatAction.UPLOAD_AUDIO if kind == "mp3" else ChatAction.UPLOAD_VIDEO

    async with semaphore:
        file_path: Path | None = None
        try:
            await report_progress("جارٍ تنزيل الفيديو من المصدر؛ قد يستغرق ذلك بعض الوقت...")
            await context.bot.send_chat_action(chat_id=message.chat_id, action=action)
            if kind == "mp3" and source_platform == "SoundCloud":
                await report_progress("جارٍ تنزيل الصوت من SoundCloud وتحويله إلى MP3...")
                file_path = await asyncio.to_thread(
                    client.download_external_audio_via_ytdlp,
                    source_url or direct_url,
                    source_platform,
                )
            elif kind != "mp3" and source_platform:
                await report_progress(f"جارٍ تنزيل فيديو {source_platform} بأعلى جودة متاحة عبر yt-dlp...")
                file_path = await asyncio.to_thread(
                    client.download_external_video_via_ytdlp,
                    source_url or direct_url,
                    source_platform,
                )
            else:
                try:
                    file_path = await asyncio.to_thread(client.download_file, direct_url, suffix)
                except Exception as initial_exc:
                    if (
                        kind == "mp3"
                        or not source_url
                        or not _is_instagram_media_like_url(source_url)
                        or "يتجاوز الحد المسموح" in str(initial_exc)
                        or "تجاوز التحميل" in str(initial_exc)
                    ):
                        raise
                    logger.warning("Instagram CDN download failed; refreshing link then falling back to yt-dlp: %s", initial_exc)
                    await report_progress("تعذر رابط CDN المؤقت؛ جارٍ تجديده ثم تجربة التنزيل من رابط المنشور...")
                    try:
                        refreshed = await asyncio.to_thread(client.fetch_instagram, source_url, force_refresh=True)
                        refreshed_url = refreshed.hd_url or refreshed.no_watermark_url or refreshed.preview_video_url
                        if refreshed_url:
                            file_path = await asyncio.to_thread(client.download_file, refreshed_url, suffix)
                    except Exception as refresh_exc:
                        logger.warning("Refreshing Instagram CDN URL failed; trying yt-dlp: %s", refresh_exc)

                    if file_path is None:
                        try:
                            await report_progress("جارٍ تنزيل الفيديو من صفحة إنستغرام مباشرةً باستخدام yt-dlp...")
                            file_path = await asyncio.to_thread(client.download_instagram_via_ytdlp, source_url)
                        except Exception as ytdlp_exc:
                            logger.exception("Instagram post-page download fallback failed")
                            raise RuntimeError(str(ytdlp_exc)) from initial_exc

            if kind == "mp3":
                await report_progress("اكتمل التنزيل؛ جارٍ إرسال الملف الصوتي...")
                with file_path.open("rb") as audio_file:
                    await message.reply_audio(
                        audio=audio_file,
                        caption=title,
                        title=(title[:64] if title else "TikTok Audio"),
                        performer=source_platform or "TikTok",
                    )
            else:
                upload_limit = min(MAX_LOCAL_UPLOAD_MB, 48) * 1024 * 1024
                downloaded_mb = file_path.stat().st_size / (1024 * 1024)
                crop_percent = SNAPCHAT_CROP_TOP_PERCENT if source_platform == "Snapchat" else 0
                if kind == "compressed" or file_path.suffix.lower() != ".mp4" or file_path.stat().st_size > upload_limit:
                    stage = "جارٍ قصّ الشريط العلوي وإزالة علامة Snapchat ثم ضغط الفيديو..." if crop_percent else "جارٍ ضغط الفيديو..."
                    await report_progress(f"اكتمل التنزيل ({downloaded_mb:.1f}MB)؛ {stage}")
                    file_path = await asyncio.to_thread(compress_video_file, file_path, crop_top_percent=crop_percent)
                elif crop_percent:
                    await report_progress("جارٍ قصّ الشريط العلوي لإزالة علامة Snapchat واسم المستخدم...")
                    file_path = await asyncio.to_thread(crop_snapchat_video_file, file_path)
                if file_path.stat().st_size > upload_limit:
                    raise RuntimeError("حجم الفيديو بعد الضغط ما زال أكبر من حد الرفع المسموح.")
                uploaded_mb = file_path.stat().st_size / (1024 * 1024)
                await report_progress(f"اكتملت المعالجة ({uploaded_mb:.1f}MB)؛ جارٍ رفع الفيديو إلى تيليجرام...")
                try:
                    with file_path.open("rb") as video_file:
                        await message.reply_video(video=video_file, caption=title, supports_streaming=True)
                except BadRequest as video_exc:
                    logger.warning("Video upload failed; trying document upload: %s", video_exc)
                    with file_path.open("rb") as doc_file:
                        await message.reply_document(document=doc_file, caption=title, filename="video.mp4")
        finally:
            if file_path and file_path.exists():
                if file_path.parent.name.startswith(("instagram_ytdlp_", "ytdlp_video_", "ytdlp_audio_")):
                    shutil.rmtree(file_path.parent, ignore_errors=True)
                else:
                    file_path.unlink(missing_ok=True)


async def download_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query or not update.effective_user:
        return

    await query.answer()

    if not await enforce_force_subscription(update, context, prompt=True):
        return

    parts = (query.data or "").split(":", 2)
    if len(parts) != 3 or parts[0] != "dl":
        await query.answer("الطلب غير صالح.", show_alert=True)
        return

    kind, ref_id = parts[1], parts[2]
    payload = context.bot_data.get("downloads", {}).get(ref_id)
    if not payload:
        await query.message.reply_text("انتهت صلاحية هذا الطلب. ابعت الرابط مرة ثانية.")
        return

    if payload.get("user_id") != update.effective_user.id and not is_developer(update.effective_user.id):
        await query.answer("هذا الزر ليس تابعاً لطلبك.", show_alert=True)
        return

    if kind == "refresh":
        await query.message.reply_text("ابعت الرابط مرة ثانية وأنا هجهزه من جديد.")
        return

    if kind == "mp3":
        direct_url = payload.get("mp3_url")
        label = "الملف الصوتي"
    elif kind == "hd":
        direct_url = payload.get("hd_url") or payload.get("no_watermark_url")
        label = "الفيديو"
    elif kind == "compressed":
        direct_url = payload.get("hd_url") or payload.get("no_watermark_url") or payload.get("preview_video_url")
        label = "الفيديو المضغوط"
    else:
        await query.answer("الخيار غير معروف.", show_alert=True)
        return

    if not direct_url:
        await query.answer("هذا الخيار غير متاح لهذا الرابط.", show_alert=True)
        return

    waiting = await query.message.reply_text(f"جارٍ بدء تجهيز {label}...")
    try:
        title = payload.get("title") or "TikTok Download"
        await deliver_remote_or_local(
            update,
            context,
            direct_url=direct_url,
            kind=kind,
            title=title,
            source_url=payload.get("source_url"),
            progress_message=waiting,
        )
        try:
            await waiting.delete()
        except Exception:
            pass
    except Exception as exc:
        logger.exception("Download callback failed")
        try:
            await waiting.delete()
        except Exception:
            pass
        status_code = getattr(getattr(exc, "response", None), "status_code", None)
        safe_reason = (
            "رفض إنستغرام رابط الفيديو (403) حتى بعد محاولة تحديثه. أرسل رابط المنشور مجدداً."
            if status_code == 403
            else str(exc)[:500]
        )
        await query.message.reply_text(
            f"حصل خطأ أثناء تجهيز {label}.\n"
            f"السبب: {safe_reason}\n\n"
            "قد يكون الفيديو خاصاً أو انتهت صلاحية رابط التنزيل؛ أرسل رابط المنشور من جديد للمحاولة."
        )


async def admin_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    user = update.effective_user
    if not query or not user:
        return

    await query.answer()
    if not is_developer(user.id):
        await query.answer("هذا القسم للمطور فقط.", show_alert=True)
        return

    action = (query.data or "").split(":", 1)[1]
    settings = get_settings(context)

    if action == "set_start":
        context.user_data["pending_action"] = "set_start_message"
        await query.message.reply_text(
            "أرسل الآن رسالة /start الجديدة كاملة.\nاكتب /cancel للإلغاء.",
            reply_markup=build_admin_keyboard(),
        )
        return

    if action == "broadcast":
        context.user_data["pending_action"] = "broadcast_message"
        await query.message.reply_text(
            "أرسل الآن نص الإذاعة الذي تريد إرساله لكل المستخدمين.\nاكتب /cancel للإلغاء.",
            reply_markup=build_admin_keyboard(),
        )
        return

    if action == "force_sub":
        context.user_data["pending_action"] = "set_force_sub"
        await query.message.reply_text(
            "أرسل إعدادات الاشتراك الإجباري بهذا الشكل:\n\n"
            "السطر الأول: معرف القناة أو اليوزر مثل @channel\n"
            "السطر الثاني: رابط الانضمام (اختياري)\n"
            "من السطر الثالث وما بعده: رسالة الاشتراك الإجباري (اختياري)\n\n"
            "مثال:\n"
            "@mychannel\n"
            "https://t.me/mychannel\n"
            "اشترك بالقناة ثم اضغط تحقق ✅",
            reply_markup=build_admin_keyboard(),
        )
        return

    if action == "disable_force_sub":
        settings["force_sub_enabled"] = False
        save_settings(context, settings)
        await query.message.reply_text("تم تعطيل الاشتراك الإجباري ✅", reply_markup=build_admin_keyboard())
        return

    if action == "stats":
        users = context.bot_data.setdefault("users", get_users())
        force_sub = "مفعل" if settings.get("force_sub_enabled") else "معطل"
        await query.message.reply_text(
            "إحصائيات البوت 📊\n\n"
            f"عدد المستخدمين: {len(users)}\n"
            f"الاشتراك الإجباري: {force_sub}\n"
            f"القناة/المعرف: {settings.get('force_sub_chat_id') or 'غير محدد'}\n"
            f"مدة التشغيل: {format_uptime(int(time.time() - APP_START_TIME))}",
            reply_markup=build_admin_keyboard(),
        )
        return

    if action == "view_start":
        await query.message.reply_text(
            "رسالة /start الحالية:\n\n" + (settings.get("start_message") or START_MESSAGE_DEFAULT),
            reply_markup=build_admin_keyboard(),
        )
        return


async def subscription_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query:
        return

    await query.answer()
    ok = await enforce_force_subscription(update, context, prompt=False)
    if ok:
        await query.message.reply_text("تم التحقق بنجاح ✅ يمكنك الآن استخدام البوت.")
    else:
        settings = get_settings(context)
        await query.message.reply_text(
            settings.get("force_sub_text") or FORCE_SUB_TEXT_DEFAULT,
            reply_markup=build_subscription_keyboard(settings),
        )


async def post_init(application: Application) -> None:
    ensure_storage()
    application.bot_data["settings"] = get_settings(None)
    application.bot_data["users"] = get_users()
    application.bot_data["downloads"] = {}
    application.bot_data["local_download_semaphore"] = asyncio.Semaphore(
        max(1, LOCAL_DOWNLOAD_CONCURRENCY)
    )

    try:
        await application.bot.set_my_commands(
            [
                ("start", "تشغيل البوت"),
                ("help", "المساعدة"),
                ("ping", "فحص البوت"),
                ("stats", "إحصائيات المطور"),
                ("admin", "لوحة المطور"),
                ("cancel", "إلغاء العملية الحالية"),
            ]
        )
    except Exception:
        logger.exception("Could not set bot commands")

    mode = "Webhook" if _should_use_webhook() else "Polling"
    extra = ""
    if _should_use_webhook():
        public_webhook = WEBHOOK_URL.rstrip("/") + _normalize_webhook_path(WEBHOOK_PATH)
        extra = f"\nWebhook: {public_webhook}"

    try:
        if DEVELOPER_ID:
            await application.bot.send_message(
                chat_id=DEVELOPER_ID,
                text=(
                    "تم تشغيل بوت تنزيل فيديوهات تيك توك وإنستجرام بنجاح ✅\n"
                    f"الوضع: {mode}\n"
                    f"Python: {sys.version.split()[0]}\n"
                    f"Port: {PORT}{extra}"
                ),
            )
    except Exception:
        logger.exception("Could not send startup notification to developer")


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    error_text = "".join(
        traceback.format_exception(
            None,
            context.error,
            context.error.__traceback__ if context.error else None,
        )
    )
    logger.error("Unhandled exception: %s", error_text)

    try:
        if isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text(
                "حصل خطأ داخلي غير متوقع. جرب مرة ثانية بعد لحظات."
            )
    except Exception:
        logger.debug("Could not reply to user with error message", exc_info=True)

    try:
        if DEVELOPER_ID:
            await context.bot.send_message(
                chat_id=DEVELOPER_ID,
                text=_truncate(f"⚠️ خطأ داخلي داخل البوت:\n{error_text}"),
            )
    except Exception:
        logger.exception("Could not send error report to developer")


def build_app() -> Application:
    builder = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .connect_timeout(30)
        .read_timeout(180)
        .write_timeout(60)
        .media_write_timeout(600)
        .pool_timeout(60)
        .concurrent_updates(True)
    )
    app = builder.build()

    app.add_error_handler(error_handler)
    app.add_handler(CommandHandler("start", start_handler))
    app.add_handler(CommandHandler("help", help_handler))
    app.add_handler(CommandHandler("cancel", cancel_handler))
    app.add_handler(CommandHandler("ping", ping_handler))
    app.add_handler(CommandHandler("stats", stats_handler))
    app.add_handler(CommandHandler("admin", admin_handler))
    app.add_handler(CallbackQueryHandler(download_callback_handler, pattern=r"^dl:"))
    app.add_handler(CallbackQueryHandler(admin_callback_handler, pattern=r"^admin:"))
    app.add_handler(CallbackQueryHandler(subscription_callback_handler, pattern=r"^sub:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))
    return app


def validate_configuration() -> None:
    ensure_storage()
    if not BOT_TOKEN or ":" not in BOT_TOKEN:
        raise RuntimeError("قيمة BOT_TOKEN غير صالحة أو غير موجودة.")
    if DEVELOPER_ID <= 0:
        raise RuntimeError("قيمة DEVELOPER_ID غير صالحة.")
    if PORT <= 0:
        raise RuntimeError("قيمة PORT غير صالحة.")
    if _should_use_webhook() and not WEBHOOK_URL.startswith(("http://", "https://")):
        raise RuntimeError("لازم WEBHOOK_URL يكون رابط كامل يبدأ بـ http:// أو https://")


def run_app(application: Application) -> None:
    if _should_use_webhook():
        webhook_path = _normalize_webhook_path(WEBHOOK_PATH)
        public_webhook = WEBHOOK_URL.rstrip("/") + webhook_path
        logger.info(
            "Running in webhook mode | listen=%s | port=%s | path=%s | public=%s",
            HOST,
            PORT,
            webhook_path,
            public_webhook,
        )
        application.run_webhook(
            listen=HOST,
            port=PORT,
            url_path=webhook_path.lstrip("/"),
            webhook_url=public_webhook,
            secret_token=WEBHOOK_SECRET_TOKEN or None,
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=False,
            close_loop=False,
        )
    else:
        logger.info("Running in polling mode")
        application.run_polling(
            allowed_updates=Update.ALL_TYPES,
            drop_pending_updates=False,
            close_loop=False,
        )


if __name__ == "__main__":
    while True:
        try:
            logger.info("Starting TikTok/Instagram Store bot...")
            validate_configuration()
            application = build_app()
            run_app(application)
            break
        except KeyboardInterrupt:
            logger.info("Bot stopped by keyboard interrupt")
            break
        except Exception as exc:
            logger.exception("Fatal startup/runtime error")
            _notify_developer_sync(
                "❌ تعطل بوت تنزيل فيديوهات تيك توك/إنستجرام وسيتم محاولة إعادة تشغيله\n"
                f"السبب: {exc}\n"
                f"Python: {sys.version.split()[0]}\n"
                f"الوضع: {'Webhook' if _should_use_webhook() else 'Polling'}\n"
                f"PORT: {PORT}\n"
                f"إعادة المحاولة بعد {RESTART_DELAY_SECONDS} ثوانٍ"
            )
            time.sleep(max(3, RESTART_DELAY_SECONDS))

# Dockerfile — تشغيل wa-tg-bot مع تجهيز أدوات التحميل (yt-dlp + ffmpeg) مسبقاً
# البناء:  docker build -t wa-tg-bot .
# التشغيل: docker run -d --name wa-tg -p 3000:3000 --env-file .env -v wa-tg-data:/app/data wa-tg-bot
# ملاحظة: النظام يثبّت الأدوات تلقائياً عند الإقلاع حتى بدون هذه الصورة — لكن الصورة
#         تجعل الإقلاع فورياً وبلا حاجة لإنترنت عند أول تشغيل.
FROM node:20-bookworm-slim

# أدوات النظام: بايثون + ffmpeg (دمج الصوت/الصورة + الضغط + استخراج MP3)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp (أحدث إصدار) من المستودع الرسمي داخل صورة بايثون
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=production \
    AUTO_INSTALL_TOOLS=true \
    YTDLP_AUTO_UPDATE=true \
    YTDLP_BIN=yt-dlp \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    ROLE=main \
    MAIN_PORT=3000

EXPOSE 3000
CMD ["npm", "start"]

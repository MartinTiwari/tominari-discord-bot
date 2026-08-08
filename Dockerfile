# Tominari — Nepal news, sports and tikho reminders.
#
# Runs the long-lived bot process. There is no HTTP server: this is a worker,
# so hosts that only offer free *web* services (Render's free tier, for one)
# will spin it down. It needs a host that keeps a process alive.

FROM node:22-slim

# better-sqlite3 ships prebuilt binaries for linux/x64 and arm64; the toolchain
# is only pulled in when npm has to fall back to building from source.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Kathmandu \
    # puppeteer is an optionalDependency we do not use in the container; without
    # this npm downloads ~150MB of Chromium that never gets executed.
    PUPPETEER_SKIP_DOWNLOAD=1 \
    # Keep SQLite on the mounted volume so streaks and dedupe survive redeploys.
    DB_PATH=/data/tominari.db

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY . .

# The image must not ship a database — /data is a volume, and baking a stale
# copy in would shadow it on first boot if the mount were ever missing.
RUN rm -rf data/*.db data/*.db-journal data/*.db-wal data/*.db-shm logs

VOLUME ["/data"]

# Registering slash commands is idempotent, so doing it on every boot keeps
# Discord in sync with the code without a separate deploy step.
CMD ["sh", "-c", "node deploy-commands.js || true; exec node bot.js"]

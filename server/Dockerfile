# One image that serves both halves: the torrent client's API and the app itself,
# on one origin. That makes `docker run` a complete product — and it sidesteps
# CORS and mixed content entirely, since the page and the API share an origin.

# The dependencies are installed where there is a compiler. uTP comes from
# utp-native, a native module with a prebuilt binary for amd64 but none for arm64,
# where npm builds it from source — with python3, make and g++, none of which the
# slim image has. Without them npm leaves the module out without a word, and the
# arm64 image ran TCP only. The image itself stays slim: only node_modules is kept.
FROM node:22-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim

WORKDIR /app

# Dependencies first, so a change to the code does not reinstall them.
COPY server/package.json server/package-lock.json* ./server/
COPY --from=deps /app/server/node_modules ./server/node_modules

COPY server/app.mjs server/entrypoint.sh ./server/
# The app itself, served from here: index.html and everything it loads.
COPY index.html app.js saver.js sw.js styles.css manifest.webmanifest icon.svg ./web/
COPY icons ./web/icons
COPY vendor ./web/vendor

ENV WEB_DIR=/app/web \
    DOWNLOAD_DIR=/data/downloads \
    PORT=8080 \
    TORRENT_PORT=6881 \
    DHT_PORT=6882 \
    NODE_ENV=production

# Downloaded files live here. Without a volume they sit in the container's
# writable layer and vanish with it.
VOLUME ["/data"]

EXPOSE 8080
# The BitTorrent side listens here — TCP and uTP on 6881, the DHT on 6882 — forward
# them and peers can connect back to you, which is the difference between leeching
# and taking part.
EXPOSE 6881/tcp
EXPOSE 6881/udp
EXPOSE 6882/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Non-root: this process runs a torrent client against whatever is submitted. The entrypoint
# starts as root only to hand the download directory to `app` (a disk Fly or Render mounts
# over /data arrives owned by root), then runs the server as `app`.
RUN useradd --create-home --uid 10001 app && mkdir -p /data/downloads && chown -R app:app /data

ENTRYPOINT ["/bin/sh", "/app/server/entrypoint.sh"]
CMD ["node", "server/app.mjs"]

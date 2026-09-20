# One image that serves both halves: the torrent client's API and the app itself,
# on one origin. That makes `docker run` a complete product — and it sidesteps
# CORS and mixed content entirely, since the page and the API share an origin.
FROM node:22-slim

WORKDIR /app

# Dependencies first, so a change to the code does not reinstall them.
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server/app.mjs ./server/app.mjs
# The app itself, served from here: index.html and everything it loads.
COPY index.html app.js saver.js sw.js styles.css manifest.webmanifest icon.svg ./web/
COPY icons ./web/icons
COPY vendor ./web/vendor

ENV WEB_DIR=/app/web \
    DOWNLOAD_DIR=/data/downloads \
    PORT=8080 \
    NODE_ENV=production

# Downloaded files live here. Without a volume they sit in the container's
# writable layer and vanish with it.
VOLUME ["/data"]

EXPOSE 8080
# The BitTorrent side listens here; forward it and peers can connect back to you,
# which is the difference between leeching and taking part.
EXPOSE 6881/tcp
EXPOSE 6881/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Non-root: this process runs a torrent client against whatever is submitted.
RUN useradd --create-home --uid 10001 app && mkdir -p /data/downloads && chown -R app /data
USER app

CMD ["node", "server/app.mjs"]

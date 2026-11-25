FROM node:22-bookworm-slim

ARG DITTO_APT_MIRROR=""
ARG DITTO_NPM_REGISTRY=""

RUN set -eu; \
    if [ -n "$DITTO_APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|$DITTO_APT_MIRROR|g; s|https://deb.debian.org|$DITTO_APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update; \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
      chromium ca-certificates fonts-noto-cjk fonts-noto-color-emoji; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN set -eu; \
    if [ -n "$DITTO_NPM_REGISTRY" ]; then npm config set registry "$DITTO_NPM_REGISTRY"; fi; \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts --no-fund --no-audit; \
    npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY skills ./skills

RUN mkdir -p /data /logs && chown -R node:node /data /logs && chmod 0755 /app/scripts/docker-entrypoint.sh

ENV HOME=/data \
    DITTO_DATA_DIR=/data \
    DITTO_LOG_FILE=/logs/ditto.log \
    DITTO_CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 3217
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "src/main.js"]

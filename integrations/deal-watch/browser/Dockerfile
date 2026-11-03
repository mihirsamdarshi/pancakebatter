# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
LABEL org.opencontainers.image.source="https://github.com/mihirsamdarshi/pancakebatter"
WORKDIR /app
# tini runs as PID 1 and reaps orphaned Chromium/Xvfb children.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
# playwright-core only; Chrome stable is installed below.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Google Chrome stable via Playwright's own installer (needs root; linux/amd64 only).
USER root
RUN npx playwright-core install --with-deps chrome \
    && rm -rf /var/lib/apt/lists/* \
    && /opt/google/chrome/chrome --version > /app/chrome-version \
    && cat /app/chrome-version
COPY server.mjs entrypoint.sh ./
ENV NODE_ENV=production PORT=3000 \
    HOME=/home/pwuser \
    TMPDIR=/tmp \
    XDG_CONFIG_HOME=/home/pwuser/.config \
    XDG_CACHE_HOME=/home/pwuser/.cache \
    XDG_DATA_HOME=/home/pwuser/.local/share \
    XDG_RUNTIME_DIR=/tmp/runtime
# Mount writable emptyDirs at /tmp, /home/pwuser and a memory-backed /dev/shm.
USER 1001:1001
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/app/entrypoint.sh"]

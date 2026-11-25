#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "${ROOT_DIR}"

LOG_DIR="${DITTO_LOG_DIR:-${ROOT_DIR}/logs}"
CONTAINER="ditto-browser"

mkdir -p "${LOG_DIR}"

# Clean up any legacy companion systemd unit if present
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now ditto-rrweb.service >/dev/null 2>&1 || true
  rm -f "${HOME}/.config/systemd/user/ditto-rrweb.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

# Prefer modern Docker Compose V2 when Docker daemon is >= 20.10
DOCKER_MAJOR=$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1 || echo "0")
if [ "${DOCKER_MAJOR:-0}" -ge 20 ] && docker compose version >/dev/null 2>&1; then
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  DITTO_PORT="${DITTO_PORT:-3217}" DITTO_LOG_DIR="${LOG_DIR}" DITTO_UID="$(id -u)" DITTO_GID="$(id -g)" docker compose up -d --build
  exit 0
fi

# Fallback for legacy Docker (e.g. Docker 18 on Debian 10 devboxes)
IMAGE="${DITTO_IMAGE:-ditto-chromium:local}"
DATA_DIR="${DITTO_DATA_DIR:-${HOME}/.local/share/ditto}"
mkdir -p "${DATA_DIR}"
chmod 700 "${DATA_DIR}"

PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev --ignore-scripts --no-fund --no-audit

if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  TMP_CTX=$(mktemp -d "${HOME}/ditto-image.XXXXXX")
  BUILD_CONTAINER="ditto-image-build-$$"
  trap 'docker rm -f "${BUILD_CONTAINER}" >/dev/null 2>&1 || true; rm -rf "${TMP_CTX}"' EXIT
  cp "${ROOT_DIR}/deploy/install-browser.sh" "${TMP_CTX}/install-browser.sh"
  NODE_BIN=$(command -v node)
  cp "${NODE_BIN}" "${TMP_CTX}/node"
  chmod 0755 "${TMP_CTX}/node"
  docker run --name "${BUILD_CONTAINER}" \
    --security-opt "seccomp=${ROOT_DIR}/deploy/seccomp.json" \
    -e "DITTO_APT_MIRROR=${DITTO_APT_MIRROR:-}" \
    -v "${TMP_CTX}:/ditto-build:ro" \
    debian:bookworm-slim sh /ditto-build/install-browser.sh
  docker commit \
    --change "ENV DITTO_CHROMIUM_PATH=/usr/bin/chromium" \
    --change "WORKDIR /app" \
    --change "LABEL io.ditto.project=ditto-browser-bridge" \
    "${BUILD_CONTAINER}" "${IMAGE}"
  docker rm -f "${BUILD_CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${TMP_CTX}"
  trap - EXIT
fi

# Pass user-facing overrides only when explicitly set so /data/config.json takes effect.
set -- \
  -d --name "${CONTAINER}" \
  --label io.ditto.project=ditto-browser-bridge \
  --restart unless-stopped \
  --init \
  --network host \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=${ROOT_DIR}/deploy/seccomp.json" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --tmpfs /run:rw,nosuid,nodev,size=16m \
  --shm-size "${DITTO_SHM_SIZE:-1g}" \
  --pids-limit 1024 \
  -v "${ROOT_DIR}:/app:ro" \
  -v "${DATA_DIR}:/data:rw" \
  -v "${LOG_DIR}:/logs:rw" \
  -w /app \
  -e HOME=/data \
  -e DITTO_DATA_DIR=/data \
  -e DITTO_LOG_FILE=/logs/ditto.log

for var in DITTO_CONFIG DITTO_HOST DITTO_PORT DITTO_CDP_PORT DITTO_TOKEN DITTO_AUTH \
           DITTO_AGENT_REMOTE DITTO_DEMO DITTO_VIEWPORT DITTO_USER_AGENT \
           DITTO_SYNC_FRESH_MS DITTO_LOG DITTO_CHROMIUM_SANDBOX \
           DITTO_SCREENCAST_QUALITY DITTO_SCREENCAST_RETINA DITTO_DEVICE_SCALE_FACTOR; do
  eval "val=\${${var}:-}"
  if [ -n "${val}" ]; then
    set -- "$@" -e "${var}=${val}"
  fi
done

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run "$@" "${IMAGE}" node src/main.js

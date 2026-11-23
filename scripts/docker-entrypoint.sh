#!/usr/bin/env sh
set -eu

if [ "$(id -u)" = "0" ]; then
  UID_VAL="${DITTO_UID:-1000}"
  GID_VAL="${DITTO_GID:-1000}"
  if [ "${UID_VAL}" = "0" ]; then
    UID_VAL=1000
    GID_VAL=1000
  fi
  mkdir -p /data /logs
  if [ "$(stat -c '%u:%g' /data 2>/dev/null || true)" != "${UID_VAL}:${GID_VAL}" ]; then
    chown -R "${UID_VAL}:${GID_VAL}" /data 2>/dev/null || true
  fi
  if [ "$(stat -c '%u:%g' /logs 2>/dev/null || true)" != "${UID_VAL}:${GID_VAL}" ]; then
    chown -R "${UID_VAL}:${GID_VAL}" /logs 2>/dev/null || true
  fi
  exec setpriv --reuid="${UID_VAL}" --regid="${GID_VAL}" --clear-groups -- "$@"
fi

exec "$@"

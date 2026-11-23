#!/bin/sh
set -eu

# Used by the Dockerfile, or a short-lived image builder on Docker 18 where
# docker build does not support a custom seccomp profile. Signature checks stay on.
if [ -n "${DITTO_APT_MIRROR:-}" ]; then
  case "$DITTO_APT_MIRROR" in
    http://*|https://*) ;;
    *) exit 1 ;;
  esac
  case "$DITTO_APT_MIRROR" in *'|'*|*'&'*|*' '*|*';'*) exit 1 ;; esac
  sed -i "s|http://deb.debian.org|$DITTO_APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources
fi
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
  chromium ca-certificates fonts-noto-cjk fonts-noto-color-emoji
rm -rf /var/lib/apt/lists/*
install -m 0755 /ditto-build/node /usr/local/bin/node
chromium --version
node --version

#!/bin/sh
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -d /data ]; then
    chown -R node:node /data 2>/dev/null || true
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"

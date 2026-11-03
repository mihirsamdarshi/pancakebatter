#!/bin/sh
# The root filesystem is read-only, so every writable path is a mounted volume.
# server.mjs starts and supervises Xvfb itself (/healthz is 503 if it dies).
set -eu
# A restarted container can keep /tmp: drop stale X state so a leftover socket
# is not mistaken for a running Xvfb.
rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock
mkdir -p /tmp/.X11-unix /tmp/runtime
exec node /app/server.mjs

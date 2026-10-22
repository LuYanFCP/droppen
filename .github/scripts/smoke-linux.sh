#!/usr/bin/env bash
# Prove a Linux server binary is worth shipping, the way smoke-macos.sh does for
# the Mac: it starts, serves the *embedded* SPA and the API (closed to a request
# without a session), and stops cleanly on SIGTERM. It runs in a throwaway container of the oldest distribution the
# builds claim to support (Debian 10: glibc 2.28), on the binary's own
# architecture (`--platform`; Docker Desktop and OrbStack run the other one
# emulated), and talks to it from the host through a published port.
#
# Usage: smoke-linux.sh <path-to-binary> <x86_64|aarch64> [image]
set -euo pipefail

BIN="${1:?usage: smoke-linux.sh <path-to-binary> <x86_64|aarch64> [image]}"
ARCH="${2:?usage: smoke-linux.sh <path-to-binary> <x86_64|aarch64> [image]}"
IMAGE="${3:-debian:buster-slim}"
case "$ARCH" in
  x86_64) PLATFORM=linux/amd64 ;;
  aarch64) PLATFORM=linux/arm64 ;;
  *) echo "unknown architecture $ARCH" >&2; exit 2 ;;
esac
BIN_DIR="$(cd "$(dirname "$BIN")" && pwd)"
BIN_NAME="$(basename "$BIN")"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
NAME="droppen-smoke-$$-$RANDOM"
WORK="$(mktemp -d)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== version ($PLATFORM, $IMAGE) =="
version="$(docker run --rm --platform "$PLATFORM" -v "$BIN_DIR:/droppen:ro" "$IMAGE" "/droppen/$BIN_NAME" --version)"
echo "$version"
# EXPECT_VERSION: a part the version must contain, e.g. the commit (`+g<rev>`).
case "$version" in *"${EXPECT_VERSION:-}"*) ;; *) echo "--version says '$version', not '${EXPECT_VERSION}'" >&2; exit 1 ;; esac

echo "== boot on 127.0.0.1:${PORT} =="
# `exec`: the server is pid 1, so `docker stop`'s SIGTERM is its own to handle.
docker run -d --name "$NAME" --platform "$PLATFORM" -v "$BIN_DIR:/droppen:ro" -p "127.0.0.1:${PORT}:8700" \
  -e HOME=/tmp/home -e APP_HOME_DIR=/tmp/home -e APP_SERVER__HOST=0.0.0.0 -e APP_SERVER__PORT=8700 \
  "$IMAGE" sh -c "mkdir -p /tmp/home && exec /droppen/$BIN_NAME serve" >/dev/null

for _ in $(seq 1 120); do
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    echo "server exited during boot; log:" >&2
    docker logs "$NAME" >&2
    exit 1
  fi
  sleep 0.5
done

echo "== GET / (embedded SPA) =="
code="$(curl -sS -o "$WORK/index.html" -w '%{http_code}' "http://127.0.0.1:${PORT}/")"
[ "$code" = 200 ] || { echo "GET / returned ${code}" >&2; docker logs "$NAME" >&2; exit 1; }
grep -q '/assets/' "$WORK/index.html" || { echo "GET / is not the embedded SPA:" >&2; head -40 "$WORK/index.html" >&2; exit 1; }
echo "GET / -> ${code}, $(grep -o '<title>[^<]*</title>' "$WORK/index.html" | head -1)"

echo "== GET /api/auth/status =="
code="$(curl -sS -o "$WORK/status.json" -w '%{http_code}' "http://127.0.0.1:${PORT}/api/auth/status")"
[ "$code" = 200 ] || { echo "GET /api/auth/status returned ${code}" >&2; docker logs "$NAME" >&2; exit 1; }
grep -q '"authRequired":true' "$WORK/status.json" || {
  echo "GET /api/auth/status does not say authRequired: $(head -c 200 "$WORK/status.json")" >&2
  exit 1
}
echo "GET /api/auth/status -> ${code}, $(head -c 120 "$WORK/status.json")"

# A fresh home has no account, and local authentication is always on.
echo "== GET /api/sessions without a session =="
code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/sessions")"
[ "$code" = 401 ] || { echo "GET /api/sessions without a session returned ${code}, not 401" >&2; docker logs "$NAME" >&2; exit 1; }
echo "GET /api/sessions -> ${code}"

echo "== SIGTERM =="
docker stop -t 20 "$NAME" >/dev/null
status="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
[ "$status" = 0 ] || { echo "SIGTERM produced exit status ${status}" >&2; docker logs "$NAME" >&2; exit 1; }
echo "clean exit (status 0)"

echo "== smoke OK: ${BIN} (${ARCH} on ${IMAGE}) =="

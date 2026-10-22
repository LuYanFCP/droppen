#!/usr/bin/env bash
# Prove a freshly built binary is worth shipping.
#
# This runs in `release.yml` *before* packaging, and is a plain script rather
# than an inline `run:` block so the same checks can be run by hand against any
# binary — including one unpacked from a release tarball, which is the round
# trip that actually matters.
#
# It answers four questions, in the order they can fail:
#
#   1. does it start at all (`--version`, which self-update also runs);
#   2. does it serve the *embedded* SPA, not the "run pnpm build" stub that
#      `build.rs` downgrades to when `web/dist` was missing;
#   3. is the API up, and closed to a request without a session: the
#      sign-in status answers, the sessions do not (a fresh home has no
#      account, and local authentication is always on);
#   4. does SIGTERM stop it cleanly — the supervisor treats a non-zero exit as
#      a crash and starts climbing down its rollback ladder.
#
# Usage: smoke-macos.sh <path-to-binary>
set -euo pipefail

BIN="${1:?usage: smoke-macos.sh <path-to-binary>}"
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

HOME_DIR="$(mktemp -d)"
LOG="${HOME_DIR}/server.log"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

cleanup() {
  # Belt and braces: if an assertion below aborted the script before the
  # SIGTERM check, do not leave a server holding the port.
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

echo "== version =="
"$BIN" --version

echo "== boot on 127.0.0.1:${PORT} (APP_HOME_DIR=${HOME_DIR}) =="
APP_HOME_DIR="$HOME_DIR" APP_SERVER__PORT="$PORT" APP_SERVER__HOST=127.0.0.1 \
  "$BIN" serve >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  # `-s` without `-S`: a connection refused while the listener is still coming
  # up is the expected case here, not something to print sixty times.
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "server exited during boot; log:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done

echo "== GET / (embedded SPA) =="
code="$(curl -sS -o "${HOME_DIR}/index.html" -w '%{http_code}' "http://127.0.0.1:${PORT}/")"
[ "$code" = 200 ] || { echo "GET / returned ${code}" >&2; cat "$LOG" >&2; exit 1; }
grep -q '<title>' "${HOME_DIR}/index.html" || {
  echo "GET / served no <title>; the SPA is probably not embedded:" >&2
  head -20 "${HOME_DIR}/index.html" >&2
  exit 1
}
# The stub `build.rs` installs when `web/dist` was absent also answers 200 with
# a title, so check for something only the real bundle has: a hashed asset.
grep -q '/assets/' "${HOME_DIR}/index.html" || {
  echo "GET / has no /assets/ reference; this looks like the placeholder page:" >&2
  head -40 "${HOME_DIR}/index.html" >&2
  exit 1
}
echo "GET / -> ${code}, $(grep -o '<title>[^<]*</title>' "${HOME_DIR}/index.html" | head -1)"

echo "== GET /api/auth/status =="
code="$(curl -sS -o "${HOME_DIR}/status.json" -w '%{http_code}' "http://127.0.0.1:${PORT}/api/auth/status")"
[ "$code" = 200 ] || { echo "GET /api/auth/status returned ${code}" >&2; cat "$LOG" >&2; exit 1; }
grep -q '"authRequired":true' "${HOME_DIR}/status.json" || {
  echo "GET /api/auth/status does not say authRequired: $(head -c 200 "${HOME_DIR}/status.json")" >&2
  exit 1
}
echo "GET /api/auth/status -> ${code}, $(head -c 120 "${HOME_DIR}/status.json")"

echo "== GET /api/sessions without a session =="
code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/sessions")"
[ "$code" = 401 ] || { echo "GET /api/sessions without a session returned ${code}, not 401" >&2; cat "$LOG" >&2; exit 1; }
echo "GET /api/sessions -> ${code}"

echo "== SIGTERM =="
kill -TERM "$PID"
status=0
wait "$PID" || status=$?
PID=
[ "$status" = 0 ] || { echo "SIGTERM produced exit status ${status}" >&2; cat "$LOG" >&2; exit 1; }
echo "clean exit (status 0)"

echo "== smoke OK: ${BIN} =="

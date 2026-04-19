#!/usr/bin/env bash
# scripts/pricing-refresh.test.sh
# Shell-test harness for scripts/pricing-refresh.sh (INFRA-07).
# Exercises:
#   1. Source unreachable → exit 0 + Discord-reachable alert
#   2. Parse success (mocked HTML) → snapshot POST + no drift alert when prices match pinned
#   3. Price drift > threshold → drift Discord alert fires
#
# Uses python3 -m http.server on 127.0.0.1:$PORT to serve a fixture HTML.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFRESH="$SCRIPT_DIR/pricing-refresh.sh"

if [ ! -x "$REFRESH" ]; then
  echo "FAIL: $REFRESH not executable (chmod +x missing)" >&2
  exit 1
fi

command -v python3 >/dev/null 2>&1 || {
  echo "FAIL: python3 required for fixture HTTP server" >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "FAIL: jq required" >&2
  exit 1
}

TESTDIR=$(mktemp -d -t pricing-test.XXXXXX)
trap 'rm -rf "$TESTDIR"; [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true; [ -n "${DISCORD_SRV_PID:-}" ] && kill "$DISCORD_SRV_PID" 2>/dev/null || true; [ -n "${CORE_SRV_PID:-}" ] && kill "$CORE_SRV_PID" 2>/dev/null || true' EXIT

# ---------- test case 1: source unreachable → exit 0, no snapshot ----------
DISCORD_LOG="$TESTDIR/discord1.log"
: > "$DISCORD_LOG"

# Start a tiny capture webhook on port 0 (kernel picks free port).
# Pass the log path AND port-outfile via argv so backgrounding won't drop env.
cat > "$TESTDIR/capture.py" <<'PY'
import http.server, socketserver, sys
LOG = sys.argv[1]
PORT = int(sys.argv[2])
PORT_OUT = sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        l = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(l).decode('utf-8', 'replace')
        with open(LOG, 'a') as f:
            f.write(body + '\n')
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', PORT), H) as s:
    with open(PORT_OUT, 'w') as f: f.write(str(s.server_address[1]))
    s.serve_forever()
PY

python3 "$TESTDIR/capture.py" "$DISCORD_LOG" 0 "$TESTDIR/dc.port" &
DISCORD_SRV_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$TESTDIR/dc.port" ] && break
  sleep 0.1
done
DC_PORT=$(cat "$TESTDIR/dc.port")
[ -n "$DC_PORT" ] || { echo "FAIL: discord capture server port"; exit 1; }

(
  export OPENAI_PRICING_SOURCE_URL="http://127.0.0.1:1/never"   # port 1 reserved — connect fails fast
  export CORE_MCP_BASE_URL="http://127.0.0.1:1"
  export CORE_MCP_TOKEN=""
  export DISCORD_AUDIT_WEBHOOK_URL="http://127.0.0.1:${DC_PORT}/hook"
  export HOME="$TESTDIR"
  if ! bash "$REFRESH" > "$TESTDIR/out1.log" 2>&1; then
    echo "FAIL: pricing-refresh exited non-zero on unreachable source" >&2
    cat "$TESTDIR/out1.log" >&2
    exit 1
  fi
)

if ! grep -q "source unreachable\|source_unreachable" "$DISCORD_LOG"; then
  echo "FAIL: expected 'source unreachable' Discord POST (got):" >&2
  cat "$DISCORD_LOG" >&2
  exit 1
fi

# ---------- test case 2: mocked HTML parse + snapshot POST (no drift) ----------
FIXTURE_HTML="$TESTDIR/gpt-realtime-mini.html"
# Pinned prices match voice-bridge/src/cost/prices.ts: audio_in 10.00 / audio_out 20.00
cat > "$FIXTURE_HTML" <<'HTML'
<html><body>
<h1>gpt-realtime-mini</h1>
<table>
  <tr><td>Audio input</td><td>$10.00 / 1M tokens</td></tr>
  <tr><td>Audio output</td><td>$20.00 / 1M tokens</td></tr>
  <tr><td>Audio cached input</td><td>$0.30 / 1M tokens</td></tr>
  <tr><td>Text input</td><td>$0.60 / 1M tokens</td></tr>
  <tr><td>Text output</td><td>$2.40 / 1M tokens</td></tr>
</table>
</body></html>
HTML

# Serve the fixture on a free port. Write the bound port to a known file so
# the test doesn't race against http.server's stdout buffering.
cat > "$TESTDIR/fixture-srv.py" <<'PY'
import http.server, socketserver, sys, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 0), H) as s:
    with open(sys.argv[2], 'w') as f: f.write(str(s.server_address[1]))
    s.serve_forever()
PY
python3 "$TESTDIR/fixture-srv.py" "$TESTDIR" "$TESTDIR/srv.port" &
SRV_PID=$!
# Poll up to 2 seconds for the port file
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$TESTDIR/srv.port" ] && break
  sleep 0.1
done
SRV_PORT=$(cat "$TESTDIR/srv.port" 2>/dev/null || true)
[ -n "$SRV_PORT" ] || { echo "FAIL: could not determine fixture server port"; exit 1; }

# Core MCP capture
CORE_LOG="$TESTDIR/core.log"
: > "$CORE_LOG"
python3 "$TESTDIR/capture.py" "$CORE_LOG" 0 "$TESTDIR/core.port" &
CORE_SRV_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$TESTDIR/core.port" ] && break
  sleep 0.1
done
CORE_PORT=$(cat "$TESTDIR/core.port")
[ -n "$CORE_PORT" ] || { echo "FAIL: core capture server port"; exit 1; }

: > "$DISCORD_LOG"
(
  export OPENAI_PRICING_SOURCE_URL="http://127.0.0.1:${SRV_PORT}/gpt-realtime-mini.html"
  export CORE_MCP_BASE_URL="http://127.0.0.1:${CORE_PORT}"
  export CORE_MCP_TOKEN="test-bearer"
  export DISCORD_AUDIT_WEBHOOK_URL="http://127.0.0.1:${DC_PORT}/hook"
  export HOME="$TESTDIR"
  if ! bash "$REFRESH" > "$TESTDIR/out2.log" 2>&1; then
    echo "FAIL: pricing-refresh exited non-zero on happy path" >&2
    cat "$TESTDIR/out2.log" >&2
    exit 1
  fi
  grep -q "pricing-refresh OK" "$TESTDIR/out2.log" || {
    echo "FAIL: expected 'pricing-refresh OK' in output" >&2
    cat "$TESTDIR/out2.log" >&2
    exit 1
  }
)

if ! grep -q "hetzner_scrape" "$CORE_LOG"; then
  echo "FAIL: expected snapshot POST to Core MCP with hetzner_scrape source" >&2
  cat "$CORE_LOG" >&2
  exit 1
fi

# No drift alert (prices match pinned 10.00)
if grep -q "pricing drift detected" "$DISCORD_LOG"; then
  echo "FAIL: drift alert should NOT fire when prices match pinned (got):" >&2
  cat "$DISCORD_LOG" >&2
  exit 1
fi

# ---------- test case 3: manipulated price → drift alert fires ----------
cat > "$FIXTURE_HTML" <<'HTML'
<html><body>
<table>
  <tr><td>Audio input</td><td>$15.00 / 1M tokens</td></tr>
  <tr><td>Audio output</td><td>$20.00 / 1M tokens</td></tr>
  <tr><td>Audio cached input</td><td>$0.30 / 1M tokens</td></tr>
  <tr><td>Text input</td><td>$0.60 / 1M tokens</td></tr>
  <tr><td>Text output</td><td>$2.40 / 1M tokens</td></tr>
</table>
</body></html>
HTML

: > "$DISCORD_LOG"
(
  export OPENAI_PRICING_SOURCE_URL="http://127.0.0.1:${SRV_PORT}/gpt-realtime-mini.html"
  export CORE_MCP_BASE_URL="http://127.0.0.1:${CORE_PORT}"
  export CORE_MCP_TOKEN="test-bearer"
  export DISCORD_AUDIT_WEBHOOK_URL="http://127.0.0.1:${DC_PORT}/hook"
  export HOME="$TESTDIR"
  bash "$REFRESH" > "$TESTDIR/out3.log" 2>&1 || true
)

if ! grep -q "pricing drift detected" "$DISCORD_LOG"; then
  echo "FAIL: expected 'pricing drift detected' in Discord POSTs (got):" >&2
  cat "$DISCORD_LOG" >&2
  exit 1
fi

# ---------- test case 4: NEVER auto-edit prices.ts (Pitfall 5) ----------
# Grep the script for destructive ops on the pricing TS file.
if grep -E "sed -i.*prices\.ts|>\s*.*prices\.ts|git commit.*prices" "$REFRESH"; then
  echo "FAIL: Pitfall 5 violation — script attempts to auto-edit prices.ts" >&2
  exit 1
fi

echo "pricing-refresh.sh test PASS"

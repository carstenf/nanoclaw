#!/usr/bin/env bash
# scripts/pricing-refresh.sh — Hetzner-side daily OpenAI Realtime pricing scraper.
# REQ-INFRA-07: scrapes platform.openai.com/docs/models/gpt-realtime-mini,
#   parses the pricing block, persists a voice_price_snapshots row via
#   voice.insert_price_snapshot MCP-tool on Lenovo1:3200, mirrors to
#   ~/nanoclaw-state/voice-pricing.json, and fires a Discord drift alert
#   to DISCORD_AUDIT_WEBHOOK_URL when scraped audio_in_usd drifts >5%
#   vs the constant pinned in voice-bridge/src/cost/prices.ts.
#
# **Pitfall 5 invariant (LOCKED): this script MUST NEVER auto-update
# voice-bridge/src/cost/prices.ts or any other TypeScript source.**
# It only WRITES to:
#   1. voice_price_snapshots (via Core MCP POST) — audit trail
#   2. ~/nanoclaw-state/voice-pricing.json     — human-readable mirror
#   3. Discord webhook                          — drift alert
#
# Failure modes are ALL non-fatal (exit 0) with Discord info-ping so the
# timer unit does not accumulate "failed" state. Carsten manually bumps
# prices.ts after reviewing the alert and the snapshot table.
#
# Runs under systemd/hetzner/voice-pricing-refresh.{service,timer} as
# `carsten` on Hetzner, daily 02:00 UTC (+15 min RandomizedDelaySec).
set -euo pipefail

SOURCE_URL="${OPENAI_PRICING_SOURCE_URL:-https://platform.openai.com/docs/models/gpt-realtime-mini}"
CORE_BASE="${CORE_MCP_BASE_URL:-http://10.0.0.2:3200}"
CORE_TOKEN="${CORE_MCP_TOKEN:-}"
DISCORD_URL="${DISCORD_AUDIT_WEBHOOK_URL:-}"
STATE_REPO="${HOME}/nanoclaw-state"
PRICING_JSON="${STATE_REPO}/voice-pricing.json"
DRIFT_THRESHOLD="${PRICING_DRIFT_THRESHOLD:-0.05}"
# Pinned value mirrors voice-bridge/src/cost/prices.ts PRICES_USD_PER_MTOK.audio_in.
# Keep in sync manually (Pitfall 5 — no auto-update).
PINNED_AUDIO_IN="${PINNED_AUDIO_IN:-10.00}"

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
HOST=$(hostname -s 2>/dev/null || hostname)

post_discord() {
  local msg="$1"
  [ -z "$DISCORD_URL" ] && return 0
  command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || return 0
  curl -fsS --max-time 5 -X POST "$DISCORD_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg c "$msg" '{content: $c}')" >/dev/null 2>&1 || true
}

HTML_FILE=$(mktemp -t pricing.XXXXXX.html)
trap 'rm -f "$HTML_FILE"' EXIT

# -------- Step 1: fetch source HTML --------
if ! curl -fsS --max-time 15 "$SOURCE_URL" -o "$HTML_FILE"; then
  post_discord "pricing-refresh @${HOST}: source_unreachable (${SOURCE_URL}) @ ${TS} — manual check https://platform.openai.com/docs/models/gpt-realtime-mini"
  echo "pricing-refresh: source_unreachable" >&2
  exit 0
fi

# -------- Step 2: parse pricing block --------
# OpenAI docs render the pricing table as plain text inline; we hunt for
# the "Audio input $X.XX" shape. Handle both "$10.00 / 1M" and raw "$10.00"
# forms. If the parse fails, alert + exit 0 — NEVER fabricate values.
parse_price() {
  local label="$1"
  # Match the first dollar amount following the label within a reasonable window.
  # Use python for robust HTML+whitespace handling — avoids fragile grep-escape.
  python3 - "$HTML_FILE" "$label" <<'PY' 2>/dev/null || true
import re, sys, html
path, label = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8', errors='replace') as f:
    text = html.unescape(f.read())
# strip HTML tags to reduce boundary noise
text = re.sub(r'<[^>]+>', ' ', text)
text = re.sub(r'\s+', ' ', text)
m = re.search(re.escape(label) + r'[^$]{0,200}\$([0-9]+(?:\.[0-9]+)?)', text, re.IGNORECASE)
if m:
    print(m.group(1))
PY
}

AUDIO_IN=$(parse_price "Audio input")
AUDIO_OUT=$(parse_price "Audio output")
AUDIO_CACHED=$(parse_price "Audio cached input")
[ -z "$AUDIO_CACHED" ] && AUDIO_CACHED=$(parse_price "Cached audio input")
TEXT_IN=$(parse_price "Text input")
TEXT_OUT=$(parse_price "Text output")

if [ -z "$AUDIO_IN" ] || [ -z "$AUDIO_OUT" ]; then
  post_discord "pricing-refresh @${HOST}: parse_failed (audio_in='$AUDIO_IN' audio_out='$AUDIO_OUT') @ ${TS} — docs layout may have changed, Carsten review"
  echo "pricing-refresh: parse_failed" >&2
  exit 0
fi

# Default the non-audio fields if docs omitted them so the snapshot row is still
# well-formed. Core MCP schema requires all 5 prices.
AUDIO_CACHED="${AUDIO_CACHED:-0.30}"
TEXT_IN="${TEXT_IN:-0.60}"
TEXT_OUT="${TEXT_OUT:-2.40}"

# -------- Step 3: compute drift vs pinned --------
DRIFT_ABS=$(awk -v new="$AUDIO_IN" -v old="$PINNED_AUDIO_IN" \
  'BEGIN { d = (new - old) / old; print (d < 0 ? -d : d) }')
ALERT_NEEDED=$(awk -v d="$DRIFT_ABS" -v t="$DRIFT_THRESHOLD" \
  'BEGIN { print (d > t ? 1 : 0) }')

# -------- Step 4: POST snapshot to Core MCP --------
if [ -n "$CORE_TOKEN" ] && command -v jq >/dev/null 2>&1; then
  SNAPSHOT_JSON=$(jq -n \
    --arg ts "$TS" \
    --arg model "gpt-realtime-mini" \
    --argjson ai "$AUDIO_IN" \
    --argjson ao "$AUDIO_OUT" \
    --argjson ac "$AUDIO_CACHED" \
    --argjson ti "$TEXT_IN" \
    --argjson to "$TEXT_OUT" \
    --argjson eur "0.93" \
    --arg source "hetzner_scrape" \
    '{arguments: {ts: $ts, model: $model, audio_in_usd: $ai, audio_out_usd: $ao, audio_cached_usd: $ac, text_in_usd: $ti, text_out_usd: $to, usd_to_eur: $eur, source: $source}}')
  curl -fsS --max-time 10 -X POST "${CORE_BASE}/mcp/voice.insert_price_snapshot" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${CORE_TOKEN}" \
    -d "$SNAPSHOT_JSON" >/dev/null 2>&1 || true
fi

# -------- Step 5: mirror to state-repo --------
if [ -d "$STATE_REPO" ] && command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg ts "$TS" \
    --argjson ai "$AUDIO_IN" \
    --argjson ao "$AUDIO_OUT" \
    --argjson ac "$AUDIO_CACHED" \
    --argjson ti "$TEXT_IN" \
    --argjson to "$TEXT_OUT" \
    '{last_refresh: $ts, audio_in_usd: $ai, audio_out_usd: $ao, audio_cached_usd: $ac, text_in_usd: $ti, text_out_usd: $to}' \
    > "${PRICING_JSON}.new" && mv "${PRICING_JSON}.new" "$PRICING_JSON"
  # Commit only if the repo is a real git checkout (skip in tests)
  if [ -d "$STATE_REPO/.git" ]; then
    (cd "$STATE_REPO" && git add voice-pricing.json >/dev/null 2>&1 \
      && git commit -m "pricing: refresh $TS (audio_in=$AUDIO_IN)" >/dev/null 2>&1 \
      && git push >/dev/null 2>&1) || true
  fi
fi

# -------- Step 6: drift alert --------
if [ "$ALERT_NEEDED" = "1" ]; then
  DRIFT_PCT=$(awk -v d="$DRIFT_ABS" 'BEGIN { printf "%.2f", d * 100 }')
  THRESH_PCT=$(awk -v t="$DRIFT_THRESHOLD" 'BEGIN { printf "%.0f", t * 100 }')
  MSG="pricing drift detected @${HOST}: audio_in pinned=${PINNED_AUDIO_IN}, fetched=${AUDIO_IN} (drift=${DRIFT_PCT}%, threshold=${THRESH_PCT}%). Review ${SOURCE_URL} then MANUALLY bump voice-bridge/src/cost/prices.ts — this script NEVER auto-updates code."
  post_discord "$MSG"
fi

echo "pricing-refresh OK: audio_in=${AUDIO_IN} drift=${DRIFT_ABS}"
exit 0

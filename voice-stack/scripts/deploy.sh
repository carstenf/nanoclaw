#!/usr/bin/env bash
# Deploy voice-stack Etappe A: FreeSWITCH minimal gateway
# - renders conf/overlay/vars-override.xml from local .env (secret, not in git)
# - rsyncs to Hetzner voice_bot
# - brings up the compose stack
# - waits and checks gateway registration
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$HOME/nanoclaw/.env}"
REMOTE="${REMOTE:-voice_bot@128.140.104.236}"
REMOTE_DIR="${REMOTE_DIR:-/home/voice_bot/voice-stack}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/voice_bot_to_hetzner}"
TMPL="$HERE/conf/overlay/vars-override.xml.tmpl"
OUT="$HERE/conf/overlay/vars-override.xml"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
[ -f "$TMPL" ]     || { echo "missing $TMPL" >&2; exit 1; }

# shellcheck disable=SC1090
PASS=$(python3 -c "
import os, re
with open(os.path.expanduser('$ENV_FILE')) as f:
    for line in f:
        m = re.match(r'^SIPGATE_SIP_PASSWORD=(.*)\$', line)
        if m:
            print(m.group(1).strip())
            break
")
[ -n "$PASS" ] || { echo "SIPGATE_SIP_PASSWORD not found in $ENV_FILE" >&2; exit 1; }

umask 077
python3 - "$TMPL" "$OUT" "$PASS" <<'PY'
import sys
tmpl, out, pw = sys.argv[1], sys.argv[2], sys.argv[3]
with open(tmpl) as f:
    data = f.read()
data = data.replace('__SIPGATE_PASSWORD__', pw)
with open(out, 'w') as f:
    f.write(data)
PY
chmod 600 "$OUT"
echo "[deploy] rendered vars-override.xml (mode 600)"

rsync -av --delete \
    --exclude runs/ --exclude .gitignore \
    -e "ssh -i $SSH_KEY" \
    "$HERE/" \
    "$REMOTE:$REMOTE_DIR/"

ssh -i "$SSH_KEY" "$REMOTE" "cd $REMOTE_DIR && docker compose up -d"

echo "[deploy] waiting 15s for FS to start + register..."
sleep 15 || true

ssh -i "$SSH_KEY" "$REMOTE" "docker exec vs-freeswitch fs_cli -x 'sofia status gateway sipgate' 2>&1 | head -30"

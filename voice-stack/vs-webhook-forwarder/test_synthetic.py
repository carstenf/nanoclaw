"""D-25: post a signed synthetic webhook to public Caddy URL; assert 200.

Used by Plan 01-06 integration test (NOT by Wave-0 unit tests).

Run from Lenovo1 once Caddy + forwarder + bridge are deployed:

    OPENAI_WEBHOOK_SECRET=$(grep OPENAI_WEBHOOK_SECRET ~/nanoclaw/.env | cut -d= -f2) \\
    VOICE_WEBHOOK_PUBLIC_URL=https://voice-webhook.carstenfreek.de/openai/webhook \\
    python3 voice-stack/vs-webhook-forwarder/test_synthetic.py

Pass criterion: status=200 AND within 2s a JSONL entry appears in
~/nanoclaw/voice-container/runs/bridge-$(date +%F).jsonl with
event_type=realtime.call.incoming and signature_valid=true.
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time

import httpx

SECRET = os.environ["OPENAI_WEBHOOK_SECRET"]
PUBLIC_URL = os.environ["VOICE_WEBHOOK_PUBLIC_URL"]


def _key_bytes(secret: str) -> bytes:
    """Strip whsec_ prefix and base64-decode (Standard Webhooks convention)."""
    if secret.startswith("whsec_"):
        secret = secret[len("whsec_"):]
    try:
        return base64.b64decode(secret)
    except Exception:
        return secret.encode("utf-8")


def main() -> int:
    msg_id = f"evt_test_{int(time.time())}"
    ts = str(int(time.time()))
    payload = {
        "id": msg_id,
        "type": "realtime.call.incoming",
        "created_at": int(ts),
        "data": {
            "call_id": f"rtc_test_{int(time.time())}",
            "sip_headers": {
                "From": "<sip:+4915112345678@sipgate.de>",
                "To": "<sip:+49308687022345@sipgate.de>",
            },
        },
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")

    to_sign = f"{msg_id}.{ts}.{raw.decode('utf-8')}".encode("utf-8")
    sig = base64.b64encode(
        hmac.new(_key_bytes(SECRET), to_sign, hashlib.sha256).digest()
    ).decode("ascii")

    headers = {
        "Content-Type": "application/json",
        "webhook-id": msg_id,
        "webhook-timestamp": ts,
        "webhook-signature": f"v1,{sig}",
    }

    r = httpx.post(PUBLIC_URL, content=raw, headers=headers, timeout=10)
    print(f"status={r.status_code} body={r.text[:200]}")
    return 0 if r.status_code == 200 else 1


if __name__ == "__main__":
    sys.exit(main())

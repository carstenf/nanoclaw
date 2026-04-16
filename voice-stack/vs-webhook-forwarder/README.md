# vs-webhook-forwarder

Phase 1 (Infrastructure & Webhook Path) — public-internet-facing receiver for
OpenAI realtime webhooks. Verifies the signature, then relays the raw body
plus `webhook-*` headers to the voice-bridge on Lenovo1 over WireGuard.

**No business logic.** This is a dumb relay (D-03). All call orchestration
lives in `voice-bridge/` on Lenovo1.

## Topology

```
Internet -> Caddy (TLS, voice-webhook.carstenfreek.de) -> 127.0.0.1:9876 (this)
                                                       \\
                                                        \\-> 10.0.0.2:4401 (bridge over WG)
```

The same FastAPI process also serves `GET /__wg_canary` on `0.0.0.0:9876`,
reachable from Lenovo1 via WG at `10.0.0.1:9876` — used by the bridge as the
WG heartbeat target (D-16 amended).

## Required environment

Set via `voice-stack/env/forwarder.env` (NOT committed; rendered by carsten
from OneCLI vault — see `nanoclaw-state/open_points.md`).

| Variable | Purpose | Example |
|----------|---------|---------|
| `OPENAI_WEBHOOK_SECRET` | HMAC key for `openai.webhooks.unwrap()` | `whsec_...` |
| `BRIDGE_WEBHOOK_URL` | upstream forward target | `http://10.0.0.2:4401/webhook` |
| `FORWARD_TIMEOUT_S` | httpx forward timeout (optional, default 5.0) | `5.0` |
| `LOG_LEVEL` | Python logging level (optional, default INFO) | `INFO` |

The container fails fast on startup if `OPENAI_WEBHOOK_SECRET` is unset
(KeyError from `os.environ[...]`).

## Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/__wg_canary` | 204 No Content (WG heartbeat target) |
| GET | `/health` | 200 + `{ok: true, bridge_url}` |
| POST | `/openai/webhook` | 200 (forwarded), 401 (bad signature, NOT forwarded), 502 (bridge unreachable) |

## Local development

```bash
cd voice-stack/vs-webhook-forwarder
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
OPENAI_WEBHOOK_SECRET=whsec_dev_xxxxxxxx \\
BRIDGE_WEBHOOK_URL=http://127.0.0.1:65535/webhook \\
uvicorn main:app --reload --port 9876
```

## Tests

```bash
cd voice-stack/vs-webhook-forwarder
. .venv/bin/activate
pip install pytest
pytest tests/ -x
```

Wave-0 unit suite covers:
- `GET /__wg_canary` returns 204
- `GET /health` returns 200 + `bridge_url`
- POST with invalid signature returns 401 and does NOT call upstream
- POST with valid signature returns 200 and forwards raw bytes once

The valid-signature test reconstructs Standard Webhooks v1 HMAC by hand and
verifies via the OpenAI SDK round-trip. If the SDK ever rejects this
construction the test skips with a clear reason (Assumption A2 in RESEARCH.md).

## Production

Deployed via `~/nanoclaw/voice-stack/docker-compose.yml`:

```bash
cd voice-stack
docker compose build webhook-forwarder
docker compose up -d webhook-forwarder
docker compose logs -f webhook-forwarder
```

## Security: Pitfall NEW-1

`network_mode: host` binds 9876 on ALL interfaces of the Hetzner host —
including the public IP (128.140.104.236). The Hetzner Cloud Firewall MUST
block inbound TCP 9876 from `0.0.0.0/0`. Verify from a non-Hetzner host:

```bash
nc -zv -w 3 128.140.104.236 9876   # expect: refused or timed out
```

If this succeeds, an attacker can bypass Caddy and pound the forwarder
directly. The signature check still rejects garbage, but it is a wasted-CPU
DoS surface. carsten owns the firewall rule (Plan 01-01, D-23).

## References

- Plan: `nanoclaw-state/.planning/phases/01-infrastructure-webhook-path/01-03-PLAN.md`
- Research: `nanoclaw-state/.planning/phases/01-infrastructure-webhook-path/01-RESEARCH.md`
  (Templates 1-3 are the canonical source for `main.py`, `Dockerfile`, and the
  docker-compose service block)
- Decisions: `nanoclaw-state/.planning/phases/01-infrastructure-webhook-path/01-CONTEXT.md`
  D-01 (Python 3.12 + FastAPI), D-02 (port 9876 host network), D-03 (relay only,
  no business logic), D-04 (failure modes: 401 / 502)

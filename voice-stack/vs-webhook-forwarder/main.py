"""OpenAI webhook forwarder. Verifies signature, relays raw body to Lenovo1 over WG.

Runs on Hetzner inside `vs-webhook-forwarder` Docker container with
`network_mode: host`. Bound to 0.0.0.0:9876 so it is reachable from:
  * Caddy on the same host via 127.0.0.1:9876 (public ingress)
  * voice-bridge on Lenovo1 via WG IP 10.0.0.1:9876 (heartbeat canary)

Public exposure of 9876 is blocked by the Hetzner cloud firewall (Pitfall NEW-1).

Verbatim implementation of RESEARCH.md §"Template 1: Forwarder main.py"
(Phase 01-infrastructure-webhook-path). Do NOT add business logic here —
this is a dumb relay per D-03.
"""
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from openai import OpenAI

# Logging - JSON-line to stdout, captured by `docker logs vs-webhook-forwarder`
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","lvl":"%(levelname)s","msg":"%(message)s"}',
)
log = logging.getLogger("forwarder")

# Fail loudly at startup if secret is missing (D-04 failure-mode discipline)
WEBHOOK_SECRET = os.environ["OPENAI_WEBHOOK_SECRET"]
BRIDGE_URL = os.environ.get("BRIDGE_WEBHOOK_URL", "http://10.0.0.2:4401/webhook")
FORWARD_TIMEOUT_S = float(os.environ.get("FORWARD_TIMEOUT_S", "5.0"))

# Single OpenAI client. webhooks.unwrap() uses webhook_secret for HMAC verify
# and never makes outbound API calls, so api_key is unused but the SDK
# constructor still requires *some* value (or OPENAI_API_KEY env). We pass
# a sentinel so the forwarder works without a real API key.
client = OpenAI(
    api_key=os.environ.get("OPENAI_API_KEY", "unused-by-webhook-verify"),
    webhook_secret=WEBHOOK_SECRET,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=FORWARD_TIMEOUT_S)
    log.info(f"forwarder up; bridge_url={BRIDGE_URL}")
    yield
    await app.state.http.aclose()
    log.info("forwarder shutdown clean")


app = FastAPI(lifespan=lifespan)


@app.get("/__wg_canary", status_code=204)
async def canary() -> Response:
    """Heartbeat target for the bridge on Lenovo1 (D-16 amended)."""
    return Response(status_code=204)


@app.get("/health", status_code=200)
async def health() -> dict:
    return {"ok": True, "bridge_url": BRIDGE_URL}


@app.post("/openai/webhook")
@app.post("/sipgate-voice/openai-sip")  # legacy spike URL — matches existing OpenAI dashboard registration (Option A, briefing 2026-04-16)
async def relay(request: Request) -> Response:
    raw = await request.body()  # bytes - DO NOT json.parse before unwrap
    try:
        event = client.webhooks.unwrap(raw, request.headers)
    except Exception as e:  # signature, parse, or timestamp window failure
        log.warning(f"signature_invalid err={type(e).__name__}:{e}")
        raise HTTPException(status_code=401, detail="invalid signature")

    log.info(f"webhook_ok event={event.type} size={len(raw)}")

    # Forward raw bytes + signature headers so the bridge can re-verify (D-18)
    headers_to_forward = {
        k: v for k, v in request.headers.items()
        if k.lower().startswith("webhook-") or k.lower() == "content-type"
    }
    try:
        r = await request.app.state.http.post(
            BRIDGE_URL, content=raw, headers=headers_to_forward
        )
    except httpx.HTTPError as e:
        log.error(f"bridge_unreachable err={type(e).__name__}:{e}")
        # OpenAI will retry per Standard Webhooks spec (D-04)
        raise HTTPException(status_code=502, detail="bridge unreachable")

    return Response(
        status_code=r.status_code,
        content=r.content,
        media_type=r.headers.get("content-type"),
    )

# Run with: uvicorn main:app --host 0.0.0.0 --port 9876

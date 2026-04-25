"""v9 Gate G — Hello-World AI voice.

Wraps upstream `OpenAIRealtimeClient` into our CallSession and plays a
German greeting on each incoming call. No reasoning, no tool-calls, no
conversation — just "does audio come out of OpenAI Realtime, through FS,
through Sipgate, to the caller's ear, in under 2 seconds?"

After this gate: Gate H (real conversation + Claude brain).
"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import signal

import structlog

from app.ai.openai_realtime import OpenAIRealtimeClient
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer
import app.sip_async.async_call as _async_call_module
from app.sip_async.sdp import build_sdp as _orig_build_sdp

# Same SDP monkey-patch as Etappe E/F: force PCMU-only answer, otherwise
# sip-to-ai's default build_sdp adds PCMA which FreeSWITCH rejects.
def _pcmu_only_build_sdp(local_ip, local_port, session_id=None, payload_types=None):
    return _orig_build_sdp(local_ip, local_port, session_id=session_id, payload_types=[0])


_async_call_module.build_sdp = _pcmu_only_build_sdp

log = structlog.get_logger("etappe_g")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-realtime")
OPENAI_VOICE = os.environ.get("OPENAI_VOICE", "marin")
PROMPT_FILE = pathlib.Path(
    os.environ.get("PROMPT_FILE", "/srv/prompts/system_hello.txt")
)
GREETING = os.environ.get(
    "GREETING",
    "Hallo, hier ist der Friseur-Bot von Coiffeur NanoClaw. Wie kann ich helfen?",
)


def _load_instructions() -> str:
    try:
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        log.warning("prompt file missing — using fallback", path=str(PROMPT_FILE))
        return "Du bist der Friseur-Rezeptionist. Antworte auf Deutsch, knapp und freundlich."


async def on_call(call: AsyncCall) -> None:
    log.info("incoming call — creating OpenAI session", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = OpenAIRealtimeClient(
        api_key=OPENAI_API_KEY,
        model=OPENAI_MODEL,
        voice=OPENAI_VOICE,
        instructions=_load_instructions(),
        greeting=GREETING,
    )
    call_session = CallSession(audio_adapter=audio_adapter, ai_client=ai_client)
    await call.setup(audio_adapter, call_session)
    log.info("call setup complete", call_id=call.call_id)


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    structlog.configure(
        processors=[
            structlog.stdlib.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer(),
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


async def main() -> None:
    _configure_logging()
    if not OPENAI_API_KEY:
        log.error("OPENAI_API_KEY not set in environment — aborting")
        raise SystemExit(2)

    server = AsyncSIPServer(host=HOST, port=PORT, call_callback=on_call)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info(
        "etappe_g starting",
        host=HOST,
        port=PORT,
        model=OPENAI_MODEL,
        voice=OPENAI_VOICE,
        prompt_file=str(PROMPT_FILE),
    )
    runner = asyncio.create_task(server.run(), name="sip-server")

    await stop.wait()
    await server.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    asyncio.run(main())

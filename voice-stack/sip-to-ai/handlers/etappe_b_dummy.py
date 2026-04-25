"""Etappe B — Dummy SIP endpoint for voice-stack.

Binds on SIP_HOST:SIP_PORT, answers incoming INVITEs with 200 OK, waits
HANGUP_AFTER seconds, then sends BYE. No RTP bridge, no AI backend.

Purpose: verify the local-loop SIP handshake between FreeSWITCH (gateway)
and sip-to-ai (AI endpoint, to be). Once Etappe B passes, real handlers
for Gates D/E/F can replace this one without touching the compose wiring.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

import structlog

from app.sip_async import AsyncCall, AsyncSIPServer

log = structlog.get_logger("etappe_b")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
HANGUP_AFTER = float(os.environ.get("HANGUP_AFTER", "10"))


class DummySIPServer(AsyncSIPServer):
    """SIP server that skips call.run() — we have no RTP/AI yet."""

    async def _run_call_callback(self, call: AsyncCall) -> None:  # type: ignore[override]
        # Mark the call active so the server loop does not reap it before the
        # callback finishes. We do not invoke call.run() because there is no
        # RTP/AI session in Etappe B.
        call._running = True  # noqa: SLF001
        try:
            if self.call_callback:
                result = self.call_callback(call)
                if asyncio.iscoroutine(result):
                    await result
        except Exception as exc:
            log.error("callback error", call_id=call.call_id, error=str(exc))
        finally:
            call._running = False  # noqa: SLF001


async def on_call(call: AsyncCall) -> None:
    log.info(
        "call accepted — holding before hangup",
        call_id=call.call_id,
        hangup_after=HANGUP_AFTER,
    )
    await asyncio.sleep(HANGUP_AFTER)
    try:
        await call.hangup()
        log.info("BYE sent", call_id=call.call_id)
    except Exception as exc:
        log.error("hangup failed", call_id=call.call_id, error=str(exc))


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
    server = DummySIPServer(host=HOST, port=PORT, call_callback=on_call)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("etappe_b starting", host=HOST, port=PORT, hangup_after=HANGUP_AFTER)
    runner = asyncio.create_task(server.run(), name="sip-server")

    await stop.wait()
    log.info("shutdown requested")
    await server.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    asyncio.run(main())

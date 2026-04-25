"""Etappe F — Echo full-duplex (Gate 4).

Mirrors every uplink PCM16 frame back as a downlink chunk. Carsten speaks,
hears his own voice ~round-trip-delay later. The purpose is to prove the
full bidirectional audio pipeline end-to-end: Sipgate → FS → sip-to-ai →
FS → Sipgate and back, without codec loss or stuttering.

After this, the stack is validated for the AI pipeline (v9 briefing).
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from typing import AsyncIterator

import structlog

from app.ai.duplex_base import AiEvent, AiEventType
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer
import app.sip_async.async_call as _async_call_module
from app.sip_async.sdp import build_sdp as _orig_build_sdp

# Same monkey-patch as Etappe E — upstream AsyncCall.accept() calls
# build_sdp without payload_types and adds PCMA unbidden. Force PCMU-only
# answers so FreeSWITCH does not trip over an RFC 3264 violation.
def _pcmu_only_build_sdp(local_ip, local_port, session_id=None, payload_types=None):
    return _orig_build_sdp(local_ip, local_port, session_id=session_id, payload_types=[0])


_async_call_module.build_sdp = _pcmu_only_build_sdp

log = structlog.get_logger("etappe_f")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
ECHO_QUEUE_SIZE = int(os.environ.get("ECHO_QUEUE_SIZE", "200"))


class EchoClient:
    """AiDuplexClient stub that echoes uplink frames back as downlink."""

    def __init__(self, call_id: str) -> None:
        self._call_id = call_id
        self._stop = asyncio.Event()
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=ECHO_QUEUE_SIZE)
        self._rx_frames = 0
        self._tx_frames = 0
        self._dropped = 0

    async def connect(self) -> None:
        log.info("echo_client connect", call_id=self._call_id)

    async def close(self) -> None:
        self._stop.set()
        log.info(
            "echo_client summary",
            call_id=self._call_id,
            rx_frames=self._rx_frames,
            tx_frames=self._tx_frames,
            dropped=self._dropped,
        )

    async def send_pcm16_8k(self, frame_20ms: bytes) -> None:
        if not frame_20ms:
            return
        self._rx_frames += 1
        try:
            self._queue.put_nowait(frame_20ms)
        except asyncio.QueueFull:
            self._dropped += 1
            if self._dropped % 50 == 1:
                log.warning(
                    "echo queue full, dropping frame",
                    call_id=self._call_id,
                    dropped=self._dropped,
                )

    async def receive_chunks(self) -> AsyncIterator[bytes]:
        log.info("echo downlink started", call_id=self._call_id)
        while not self._stop.is_set():
            try:
                frame = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            self._tx_frames += 1
            yield frame

    async def events(self) -> AsyncIterator[AiEvent]:
        yield AiEvent(type=AiEventType.CONNECTED, timestamp=time.time())
        await self._stop.wait()

    async def update_session(self, config: dict) -> None:  # noqa: ARG002
        pass

    async def ping(self) -> bool:
        return True

    async def reconnect(self) -> None:
        pass


async def on_call(call: AsyncCall) -> None:
    log.info("incoming call — echo mode", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = EchoClient(call.call_id)
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
    server = AsyncSIPServer(host=HOST, port=PORT, call_callback=on_call)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info("etappe_f starting", host=HOST, port=PORT, queue_size=ECHO_QUEUE_SIZE)
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

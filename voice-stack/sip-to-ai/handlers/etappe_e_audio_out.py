"""Etappe E — Audio RAUS (Gate 3): 440 Hz sine tone.

On each incoming call, publish 2 s of a pre-generated 440 Hz sine wave via
the AI downlink. After that, the call holds in silence until BYE.

This is the architecturally critical gate: the exact point where
``mod_audio_stream`` free broke. With the two-leg architecture (FS as
gateway, sip-to-ai as endpoint) this should be trivial because FS handles
the codec transcoding and sip-to-ai only deals with 8 kHz PCM16 internally.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import signal
import struct
import time
from typing import AsyncIterator

import structlog

from app.ai.duplex_base import AiEvent, AiEventType
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer
import app.sip_async.async_call as _async_call_module
from app.sip_async.sdp import build_sdp as _orig_build_sdp

# ---------------------------------------------------------------------------
# Monkey-patch: force sip-to-ai's SDP answer to advertise only PCMU (PT 0).
#
# Upstream `AsyncCall.accept()` calls `build_sdp(local_ip, local_port)` without
# payload_types, so the default [0, 8] is used. That makes sip-to-ai answer
# with PCMA even when the offer didn't include it — an RFC 3264 violation.
# FreeSWITCH then bridges audio in only one direction (receive works, send is
# dropped). Patching the imported reference in async_call to always pass
# payload_types=[0] fixes the answer to be strictly PCMU.
# ---------------------------------------------------------------------------
def _pcmu_only_build_sdp(local_ip, local_port, session_id=None, payload_types=None):
    return _orig_build_sdp(local_ip, local_port, session_id=session_id, payload_types=[0])


_async_call_module.build_sdp = _pcmu_only_build_sdp

log = structlog.get_logger("etappe_e")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))

TONE_HZ = float(os.environ.get("TONE_HZ", "440"))
TONE_SECONDS = float(os.environ.get("TONE_SECONDS", "2.0"))
TONE_AMPLITUDE = int(os.environ.get("TONE_AMPLITUDE", "10000"))
SAMPLE_RATE = 8000
FRAME_BYTES = 320  # 20 ms mono PCM16 at 8 kHz


def _generate_sine_pcm16(hz: float, seconds: float, amplitude: int) -> bytes:
    n_samples = int(SAMPLE_RATE * seconds)
    samples = [
        int(amplitude * math.sin(2.0 * math.pi * hz * i / SAMPLE_RATE))
        for i in range(n_samples)
    ]
    return struct.pack("<" + "h" * n_samples, *samples)


TONE_PCM16 = _generate_sine_pcm16(TONE_HZ, TONE_SECONDS, TONE_AMPLITUDE)


class TonePublisher:
    """AiDuplexClient stub that pushes a 440 Hz tone into the downlink once."""

    def __init__(self, call_id: str) -> None:
        self._call_id = call_id
        self._stop = asyncio.Event()

    async def connect(self) -> None:
        log.info("tone_publisher connect", call_id=self._call_id)

    async def close(self) -> None:
        self._stop.set()

    async def send_pcm16_8k(self, frame_20ms: bytes) -> None:
        # Drop uplink — only downlink matters for this gate.
        pass

    async def receive_chunks(self) -> AsyncIterator[bytes]:
        """Yield the 440 Hz tone continuously until the call ends.

        FreeSWITCH cannot forward RTP to the A-leg (Sipgate) until its
        200 OK / ACK handshake is complete. In Etappe E retry 3 this
        happened 2.6 s after sip-to-ai started publishing — long enough
        for a one-shot 2 s tone to be fully dropped before the path
        opens. Sending the tone continuously guarantees at least some
        frames land in the bridged path.
        """
        n_frames = len(TONE_PCM16) // FRAME_BYTES
        log.info(
            "publishing continuous tone",
            call_id=self._call_id,
            frames_per_cycle=n_frames,
            hz=TONE_HZ,
            amplitude=TONE_AMPLITUDE,
        )
        cycles = 0
        while not self._stop.is_set():
            for i in range(0, len(TONE_PCM16), FRAME_BYTES):
                if self._stop.is_set():
                    break
                yield TONE_PCM16[i : i + FRAME_BYTES]
            cycles += 1
            if cycles >= 30:  # ~60 s of tone max
                log.info("tone cycle cap reached", call_id=self._call_id, cycles=cycles)
                break
        log.info("tone generator exiting", call_id=self._call_id, cycles=cycles)

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
    log.info("incoming call — preparing tone publish", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = TonePublisher(call.call_id)
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

    log.info(
        "etappe_e starting",
        host=HOST,
        port=PORT,
        tone_hz=TONE_HZ,
        tone_seconds=TONE_SECONDS,
        tone_amplitude=TONE_AMPLITUDE,
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

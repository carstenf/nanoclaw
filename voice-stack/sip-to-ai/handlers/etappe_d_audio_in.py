"""Etappe D — Audio REIN (Gate 2): RMS log + WAV dump.

Unlike Etappe B (which skipped ``call.run()`` entirely), this handler uses the
full sip-to-ai pipeline: AudioAdapter + RTPAudioBridge + CallSession. The
trick is a stub AI client (SilentAIMonitor) whose ``send_pcm16_8k`` is our
audio inspection point — every 20 ms PCM16 frame that the uplink pump produces
ends up there.

DoD (briefing v8):
- RMS values 100–10000 (not silence, not clipping)
- WAV dump playable on Lenovo1, Carsten's voice recognisable
- Codec log: PCMU, 8 kHz, 20 ms frames (already proven in Etappe C)
"""
from __future__ import annotations

import asyncio
import audioop
import logging
import os
import pathlib
import signal
import time
import wave
from typing import AsyncIterator

import structlog

from app.ai.duplex_base import AiEvent, AiEventType
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer

log = structlog.get_logger("etappe_d")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
RUNS_DIR = pathlib.Path(os.environ.get("RUNS_DIR", "/srv/runs"))
RMS_LOG_INTERVAL_SEC = 0.5
WAV_DUMP_SECONDS = 5.0


class SilentAIMonitor:
    """AiDuplexClient stub that inspects uplink PCM16 frames.

    Implements the minimum of the duck-typed Protocol so CallSession is
    happy. Uplink (SIP→AI) is our measurement point. Downlink (AI→SIP)
    never yields, so the caller hears silence — that is on purpose for
    Etappe D.
    """

    def __init__(self, call_id: str) -> None:
        self._call_id = call_id
        self._stop = asyncio.Event()
        self._wav: wave.Wave_write | None = None
        self._wav_path: pathlib.Path | None = None
        self._wav_frames_written = 0
        self._first_frame_ts: float | None = None
        self._last_log_ts: float = 0.0
        self._frame_count = 0
        self._rms_sum = 0
        self._rms_max = 0

    async def connect(self) -> None:
        log.info("silent_ai connect", call_id=self._call_id)

    async def close(self) -> None:
        self._stop.set()
        if self._wav is not None:
            try:
                self._wav.close()
            except Exception as exc:
                log.warning("wav close error", call_id=self._call_id, error=str(exc))
            log.info(
                "wav closed on ai_client.close",
                call_id=self._call_id,
                path=str(self._wav_path),
                frames=self._wav_frames_written,
            )
            self._wav = None
        log.info(
            "silent_ai summary",
            call_id=self._call_id,
            total_frames=self._frame_count,
            avg_rms=(self._rms_sum // self._frame_count) if self._frame_count else 0,
            max_rms=self._rms_max,
        )

    async def send_pcm16_8k(self, frame_20ms: bytes) -> None:
        """Uplink audio frame inspection point."""
        if not frame_20ms:
            return
        self._frame_count += 1
        now = time.monotonic()

        try:
            rms = audioop.rms(frame_20ms, 2)
        except audioop.error:
            rms = 0
        self._rms_sum += rms
        if rms > self._rms_max:
            self._rms_max = rms

        if self._first_frame_ts is None:
            self._first_frame_ts = now
            RUNS_DIR.mkdir(parents=True, exist_ok=True)
            ts = int(time.time())
            self._wav_path = RUNS_DIR / f"etappe-d-{ts}-{self._call_id[:8]}.wav"
            wav = wave.open(str(self._wav_path), "wb")
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            self._wav = wav
            log.info(
                "first audio frame — wav started",
                call_id=self._call_id,
                path=str(self._wav_path),
                first_rms=rms,
                bytes=len(frame_20ms),
            )

        if now - self._last_log_ts >= RMS_LOG_INTERVAL_SEC:
            log.info(
                "audio_in",
                call_id=self._call_id,
                frame=self._frame_count,
                rms=rms,
                bytes=len(frame_20ms),
            )
            self._last_log_ts = now

        if self._wav is not None:
            elapsed = now - (self._first_frame_ts or now)
            if elapsed <= WAV_DUMP_SECONDS:
                self._wav.writeframes(frame_20ms)
                self._wav_frames_written += 1
            else:
                self._wav.close()
                log.info(
                    "wav dump complete (5s window closed)",
                    call_id=self._call_id,
                    path=str(self._wav_path),
                    frames=self._wav_frames_written,
                    duration_sec=round(self._wav_frames_written * 0.02, 2),
                )
                self._wav = None

    async def receive_chunks(self) -> AsyncIterator[bytes]:
        """No downlink audio — block until closed."""
        await self._stop.wait()
        if False:  # pragma: no cover — marks this as an async generator
            yield b""

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
    log.info("incoming call — setting up monitor", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = SilentAIMonitor(call.call_id)
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

    log.info("etappe_d starting", host=HOST, port=PORT, runs_dir=str(RUNS_DIR))
    runner = asyncio.create_task(server.run(), name="sip-server")

    await stop.wait()
    log.info("shutdown")
    await server.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


if __name__ == "__main__":
    asyncio.run(main())

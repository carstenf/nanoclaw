"""v9 Gate H — Conversation without tools.

Full friseur-receptionist persona via OpenAI Realtime's built-in LLM
reasoning. No Claude yet (that's Gate I). The only difference from Gate G
is the prompt: instead of "say hello and be silent" this one says "have a
real conversation, 3-4 turns, German default, switch languages if the
caller does, no tool-calling yet".
"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import signal

import structlog

import json

from app.ai.openai_realtime import OpenAIRealtimeClient
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer
import app.sip_async.async_call as _async_call_module
from app.sip_async.sdp import build_sdp as _orig_build_sdp

# Force PCMU-only SDP answer (sip-to-ai upstream otherwise adds PCMA
# which FreeSWITCH drops). Same patch as Etappe E/F/G.
def _pcmu_only_build_sdp(local_ip, local_port, session_id=None, payload_types=None):
    return _orig_build_sdp(local_ip, local_port, session_id=session_id, payload_types=[0])


_async_call_module.build_sdp = _pcmu_only_build_sdp


class FastBargeInOpenAI(OpenAIRealtimeClient):
    """OpenAI Realtime client with barge-in optimisations.

    Two improvements over upstream:

    1. **Aggressive VAD**: uses semantic_vad eagerness=high (upstream default
       is medium). Detects turn-ends faster.

    2. **Downlink flush on barge-in**: when OpenAI emits
       `input_audio_buffer.speech_started` (= user interrupted), we
       immediately drain both audio queues:

       - this client's internal `_audio_queue` (up to 100 frames from OpenAI)
       - the `AudioAdapter._downlink_stream` (up to 200 frames = 4 s of
         already-buffered audio on the way to RTP)

       Upstream leaves both queues to drain naturally at 20 ms per frame,
       which means the caller keeps hearing the bot's old response for
       up to ~4 s after they started speaking. Flushing both on barge-in
       cuts that to the RTP/PSTN round-trip only.
    """

    _audio_adapter = None  # attached by the handler in on_call

    def attach_adapter(self, adapter) -> None:
        """Give this client a reference to the AudioAdapter so we can
        flush its downlink queue on barge-in."""
        self._audio_adapter = adapter

    async def _configure_session(self) -> None:  # type: ignore[override]
        message = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "model": self._model,
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": {"type": self._audio_format},
                        "transcription": {"model": "whisper-1"},
                        "noise_reduction": {"type": "near_field"},
                        "turn_detection": {
                            "type": "semantic_vad",
                            "create_response": True,
                            "eagerness": "high",
                        },
                    },
                    "output": {
                        "format": {"type": self._audio_format},
                        "voice": self._voice,
                    },
                },
                "instructions": self._instructions,
            },
        }
        await self._ws.send(json.dumps(message))  # type: ignore[union-attr]
        self._logger.info("session configured with eagerness=high")

    def _flush_downlink_queues(self) -> int:
        """Drain the client's output queue and the AudioAdapter downlink.

        Returns the total number of discarded audio frames/chunks across
        both queues for logging.
        """
        dropped = 0
        # 1. OpenAI → this client (chunks not yet fed to adapter)
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
                dropped += 1
            except asyncio.QueueEmpty:
                break
        # 2. This client → RTP (already-aligned 320-byte frames)
        if self._audio_adapter is not None:
            stream = getattr(self._audio_adapter, "_downlink_stream", None)
            if stream is not None:
                inner = getattr(stream, "_queue", None)
                if inner is not None:
                    while not inner.empty():
                        try:
                            inner.get_nowait()
                            dropped += 1
                        except asyncio.QueueEmpty:
                            break
            # Drop the accumulation buffer too (pending bytes not yet framed)
            if hasattr(self._audio_adapter, "_pending_bytes"):
                self._audio_adapter._pending_bytes = b""
        return dropped

    async def _process_message(self, data):  # type: ignore[override]
        msg_type = data.get("type") if isinstance(data, dict) else None
        if msg_type in (
            "input_audio_buffer.speech_started",
            "response.cancelled",
        ):
            dropped = self._flush_downlink_queues()
            if dropped:
                self._logger.info(
                    "barge-in flush",
                    event=msg_type,
                    dropped_frames=dropped,
                )
        await super()._process_message(data)


log = structlog.get_logger("etappe_h")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-realtime")
OPENAI_VOICE = os.environ.get("OPENAI_VOICE", "marin")
PROMPT_FILE = pathlib.Path(
    os.environ.get("PROMPT_FILE", "/srv/prompts/system_friseur.txt")
)
GREETING = os.environ.get(
    "GREETING",
    "Coiffeur NanoClaw, guten Tag, was kann ich fuer Sie tun?",
)


def _load_instructions() -> str:
    try:
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        log.warning("prompt file missing — using fallback", path=str(PROMPT_FILE))
        return (
            "Du bist der Rezeptionist eines Friseursalons. Antworte auf Deutsch, "
            "freundlich und knapp. Du hast noch keine Terminbuchungs-Tools."
        )


async def on_call(call: AsyncCall) -> None:
    log.info("incoming call — opening OpenAI conversation", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = FastBargeInOpenAI(
        api_key=OPENAI_API_KEY,
        model=OPENAI_MODEL,
        voice=OPENAI_VOICE,
        instructions=_load_instructions(),
        greeting=GREETING,
    )
    ai_client.attach_adapter(audio_adapter)
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
        log.error("OPENAI_API_KEY not set — aborting")
        raise SystemExit(2)

    server = AsyncSIPServer(host=HOST, port=PORT, call_callback=on_call)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    log.info(
        "etappe_h starting",
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

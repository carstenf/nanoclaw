"""v10 V6 — bridge handler, multi-turn over WireGuard WebSocket.

- On call accept: open WebSocket to `ws://10.0.0.2:4450` (Lenovo1 voice-container).
- Send `hello` with call_id + group_jid.
- Stream caller audio frames (PCM16 20 ms @ 8 kHz) continuously as Binary
  frames via `send_pcm16_8k`. No fixed window — Lenovo1 runs silero-VAD
  server-side and decides when each utterance ends.
- Receive bot audio as Binary frames + JSON control (`bot_audio_end`,
  `turn_done`) for each turn, push audio into a local asyncio.Queue that
  `receive_chunks()` drains so sip-to-ai's `RTPAudioBridge` downlinks them.
- Multiple turns per call: the client just keeps streaming; each
  `bot_audio_end` signals one turn finished, then we keep going.
- On call close: send `bye`, close WS.

Still no barge-in here — while the bot speaks, caller audio is dropped
on the server side (V8+ will add barge-in).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from typing import AsyncIterator

import structlog
import websockets

from app.ai.duplex_base import AiEvent, AiEventType
from app.bridge import AudioAdapter, CallSession
from app.sip_async import AsyncCall, AsyncSIPServer
import app.sip_async.async_call as _async_call_module
from app.sip_async.sdp import build_sdp as _orig_build_sdp


# ---------------------------------------------------------------------------
# SDP monkey-patch (same as Etappe E/F/G/H) — force PCMU-only answer so
# FreeSWITCH doesn't trip on the RFC 3264 violation in upstream sip-to-ai.
# ---------------------------------------------------------------------------

def _pcmu_only_build_sdp(local_ip, local_port, session_id=None, payload_types=None):
    return _orig_build_sdp(
        local_ip, local_port, session_id=session_id, payload_types=[0]
    )


_async_call_module.build_sdp = _pcmu_only_build_sdp

log = structlog.get_logger("etappe_v5")

HOST = os.environ.get("SIP_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIP_PORT", "5080"))
WS_URL = os.environ.get("WS_URL", "ws://10.0.0.2:4450")
GROUP_JID = os.environ.get("GROUP_JID", "voice-491708036426")


class LenovoBrainClient:
    """AiDuplexClient that pipes audio via WebSocket to a voice-container
    WS server (see ~/nanoclaw/voice-container/ws_server.py on Lenovo1).

    V6: multi-turn. Streams caller audio continuously, server decides
    utterance ends via VAD. Bot audio arrives as Binary frames interleaved
    with JSON turn_done markers.
    """

    def __init__(self, call_id: str, ws_url: str, group_jid: str) -> None:
        self.call_id = call_id
        self.ws_url = ws_url
        self.group_jid = group_jid

        self._ws: websockets.WebSocketClientProtocol | None = None
        self._stop = asyncio.Event()

        # Downlink state: received bot audio chunks for receive_chunks()
        self._downlink_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=500)
        self._turn_count = 0

        self._recv_task: asyncio.Task | None = None

    async def connect(self) -> None:
        log.info("ws connect", url=self.ws_url, call_id=self.call_id)
        self._ws = await websockets.connect(self.ws_url, max_size=10 * 1024 * 1024)
        hello = {"type": "hello", "call_id": self.call_id, "group_jid": self.group_jid}
        await self._ws.send(json.dumps(hello))
        # Start the receive task
        self._recv_task = asyncio.create_task(self._recv_loop(), name=f"ws-recv-{self.call_id[:8]}")
        log.info("ws hello sent", call_id=self.call_id)

    async def close(self) -> None:
        self._stop.set()
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "bye"}))
            except Exception:
                pass
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._recv_task is not None:
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        log.info("ws closed", call_id=self.call_id)

    async def send_pcm16_8k(self, frame_20ms: bytes) -> None:
        """Uplink frame from RTP → straight out to WS. No local buffering
        or windowing; the server runs VAD and decides utterance boundaries."""
        if not frame_20ms or self._ws is None:
            return
        try:
            await self._ws.send(bytes(frame_20ms))
        except websockets.ConnectionClosed:
            pass

    async def _recv_loop(self) -> None:
        """Consume WS messages: control JSON + binary bot audio frames."""
        assert self._ws is not None
        try:
            async for msg in self._ws:
                if isinstance(msg, bytes):
                    try:
                        self._downlink_queue.put_nowait(msg)
                    except asyncio.QueueFull:
                        log.warning("downlink queue full, dropping", call_id=self.call_id)
                    continue

                data = json.loads(msg)
                mtype = data.get("type")

                if mtype == "ready":
                    log.info("ws ready", call_id=self.call_id, data=data)
                elif mtype == "transcript":
                    log.info("transcript", call_id=self.call_id, text=data.get("text"))
                elif mtype == "bot_text":
                    log.info("bot_text", call_id=self.call_id, text=data.get("text"))
                elif mtype == "bot_audio_meta":
                    log.info("bot_audio_meta", call_id=self.call_id, meta=data)
                elif mtype == "bot_cancel":
                    # Barge-in: drain any still-queued bot audio so the caller
                    # stops hearing the old response within ~20 ms instead of
                    # whatever buffer depth we currently have.
                    dropped = 0
                    while not self._downlink_queue.empty():
                        try:
                            self._downlink_queue.get_nowait()
                            dropped += 1
                        except asyncio.QueueEmpty:
                            break
                    log.info(
                        "bot_cancel — flushed downlink",
                        call_id=self.call_id,
                        dropped=dropped,
                        reason=data.get("reason"),
                    )
                elif mtype == "bot_audio_end":
                    self._turn_count += 1
                    log.info(
                        "bot_audio_end",
                        call_id=self.call_id,
                        turn=data.get("turn"),
                        total=self._turn_count,
                    )
                elif mtype == "turn_done":
                    log.info(
                        "turn_done",
                        call_id=self.call_id,
                        turn=data.get("turn"),
                        timings=data.get("timings"),
                    )
                elif mtype == "error":
                    log.error("server error", call_id=self.call_id, message=data.get("message"))
                else:
                    log.debug("unknown msg type", mtype=mtype)
        except websockets.ConnectionClosed:
            log.info("ws closed by server", call_id=self.call_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.error("ws recv error", call_id=self.call_id, error=str(exc))

    async def receive_chunks(self) -> AsyncIterator[bytes]:
        """Yield bot audio chunks forever (across turns) for RTPAudioBridge.
        Between turns the queue is empty, timeout fires, we loop — the SIP
        bridge will push comfort noise during silence."""
        while not self._stop.is_set():
            try:
                chunk = await asyncio.wait_for(self._downlink_queue.get(), timeout=1.0)
                yield chunk
            except asyncio.TimeoutError:
                continue

    async def events(self) -> AsyncIterator[AiEvent]:
        yield AiEvent(type=AiEventType.CONNECTED, timestamp=time.time())
        await self._stop.wait()

    async def update_session(self, config: dict) -> None:
        pass

    async def ping(self) -> bool:
        return self._ws is not None and self._ws.state.name == "OPEN"

    async def reconnect(self) -> None:
        await self.close()
        self._stop.clear()
        while not self._downlink_queue.empty():
            self._downlink_queue.get_nowait()
        await self.connect()


async def on_call(call: AsyncCall) -> None:
    log.info("incoming call — opening ws bridge", call_id=call.call_id)
    audio_adapter = AudioAdapter(uplink_capacity=100, downlink_capacity=200)
    ai_client = LenovoBrainClient(call.call_id, WS_URL, GROUP_JID)
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
        "etappe_v5 starting (V6 multi-turn mode)",
        host=HOST,
        port=PORT,
        ws_url=WS_URL,
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

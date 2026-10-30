"""Tiny HTTP wrapper around Piper TTS.

Only listens on localhost; the Node app proxies to it after checking the user's subscription.

  GET  /voices                         -> [{"id", "lang", "name"}]
  POST /synthesize {"text","voice","speed"} -> audio/wav
  POST /synthesize {"text","voice","speed","alignments":true}
       -> {"wav": base64, "sample_rate": int, "phonemes": [[phoneme, num_samples], ...]}

Phoneme timings let the browser shape the mouth for each sound (lips close on m/b/p, round on o/u...).
"""

import argparse
import base64
import io
import json
import logging
import threading
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

_LOGGER = logging.getLogger("tts")
MAX_CHARS = 2000


class VoiceStore:
    def __init__(self, voices_dir: Path, max_loaded: int):
        self.voices_dir = voices_dir
        self.max_loaded = max(1, max_loaded)
        self._loaded: "OrderedDict[str, PiperVoice]" = OrderedDict()
        self._lock = threading.Lock()

    def available(self) -> list[dict]:
        voices = []
        for onnx in sorted(self.voices_dir.glob("*.onnx")):
            cfg_path = Path(f"{onnx}.json")
            if not cfg_path.exists():
                continue
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            lang = (cfg.get("language") or {}).get("family") or cfg.get("espeak", {}).get("voice", "")
            voices.append(
                {
                    "id": onnx.stem,
                    "lang": lang.split("-")[0].split("_")[0],
                    "name": cfg.get("dataset") or onnx.stem,
                }
            )
        return voices

    def get(self, voice_id: str) -> PiperVoice:
        with self._lock:
            if voice_id not in self._loaded:
                path = self.voices_dir / f"{voice_id}.onnx"
                if path.parent != self.voices_dir or not path.exists():
                    raise KeyError(voice_id)
                # Small servers cannot keep every voice in memory: drop the least recently used one.
                while len(self._loaded) >= self.max_loaded:
                    _LOGGER.info("Unloading voice %s", self._loaded.popitem(last=False)[0])
                _LOGGER.info("Loading voice %s", voice_id)
                # include_alignments patches the model in memory so phoneme durations are returned.
                self._loaded[voice_id] = PiperVoice.load(path, include_alignments=True)
            self._loaded.move_to_end(voice_id)
            return self._loaded[voice_id]


def make_handler(store: VoiceStore, synth_lock: threading.Lock):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: bytes, content_type: str):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, obj):
            self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json")

        def do_GET(self):
            if self.path == "/voices":
                return self._json(200, store.available())
            if self.path == "/health":
                return self._json(200, {"ok": True})
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/synthesize":
                return self._json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(min(length, 64 * 1024)) or b"{}")
                text = str(req.get("text", "")).strip()[:MAX_CHARS]
                voice_id = str(req.get("voice", ""))
                speed = float(req.get("speed", 1.0))
                want_alignments = bool(req.get("alignments"))
            except (ValueError, TypeError):
                return self._json(400, {"error": "bad request"})
            if not text:
                return self._json(400, {"error": "empty text"})
            try:
                voice = store.get(voice_id)
            except KeyError:
                return self._json(404, {"error": "unknown voice"})

            speed = min(max(speed, 0.5), 2.0)
            buf = io.BytesIO()
            # One synthesis at a time keeps a small VPS responsive.
            with synth_lock, wave.open(buf, "wb") as wav:
                alignments = voice.synthesize_wav(
                    text, wav, syn_config=SynthesisConfig(length_scale=1.0 / speed), include_alignments=want_alignments
                )
            if not want_alignments:
                return self._send(200, buf.getvalue(), "audio/wav")
            self._json(
                200,
                {
                    "wav": base64.b64encode(buf.getvalue()).decode("ascii"),
                    "sample_rate": voice.config.sample_rate,
                    "phonemes": [[a.phoneme, int(a.num_samples)] for a in alignments or []],
                },
            )

        def log_message(self, fmt, *args):
            _LOGGER.debug(fmt, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5002)
    parser.add_argument("--voices-dir", default=str(Path(__file__).parent / "voices"))
    parser.add_argument("--max-loaded", type=int, default=2, help="Voices kept in memory at once")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)

    store = VoiceStore(Path(args.voices_dir).resolve(), args.max_loaded)
    _LOGGER.info("Voices: %s", [v["id"] for v in store.available()])
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, threading.Lock()))
    _LOGGER.info("Listening on http://%s:%s", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()

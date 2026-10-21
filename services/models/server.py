"""The model server (plan §3.2): keeps your voice and the aligner loaded, and turns a sentence into
audio plus lip timing for the chat backend.

It answers on 127.0.0.1 (this Mac only) by default. The chat backend reaches it from Docker at
host.docker.internal; nothing outside the Mac can, and the Cloudflare tunnel only leads to the
chat backend.

- GET /health: 200 with {"ok": true, "voice": ...} once the models are loaded, and 503 with
  "loading" in the first seconds after starting. The chat backend's own health check includes this
  one, since every reply needs your voice (§7.8). If the models fail to load, the server exits, so
  launchd starts it again.
- POST /speak with {"text": "One or two sentences."}: 200 with speak.py's result (text, spoken,
  duration, words, visemes, timing) plus "audio", the WAV file (mono, 24 kHz, 16-bit) in base64.
  The chat backend splits a reply into sentences and sends them one at a time (§6.1).
  - 400 if the text is empty or longer than MAX_CHARS.
  - words and visemes are null when the aligner fails on a sentence (§6.2's fallback).

One sentence is voiced at a time, on one thread: Pocket-TTS already voices about eight seconds of
speech per second of work, and the aligner on the graphics chip is safest used from one thread.

Run: cd services/models && uv run server.py [--host 127.0.0.1] [--port 8790]
"""

import argparse
import asyncio
import base64
import io
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from speak import Speaker
from voices import RATE

VOICE = "pocket-respelled"  # the bake-off's name for this voice (plan §6.3)
MAX_CHARS = 600  # a long sentence or two; replies are about 120 words, sent sentence by sentence
models = ThreadPoolExecutor(max_workers=1)  # the one thread that touches the models
state: dict = {"speaker": None, "loaded_s": None}


def load() -> None:
    started = time.perf_counter()
    try:
        state["speaker"] = Speaker()
    except Exception:
        # A server that can never speak is worse than none: exit, so launchd starts it again.
        traceback.print_exc()
        print("model server: the models failed to load; exiting", file=sys.stderr, flush=True)
        os._exit(1)
    state["loaded_s"] = round(time.perf_counter() - started, 1)
    print(f"model server: {VOICE} loaded in {state['loaded_s']} s", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The models load in the background, so /health can answer "still loading" meanwhile.
    models.submit(load)
    yield
    models.shutdown(wait=False)


app = FastAPI(title="merlinyang.com model server", lifespan=lifespan)


class Sentence(BaseModel):
    text: str


@app.get("/health")
def health():
    if state["speaker"] is None:
        return JSONResponse({"ok": False, "voice": VOICE, "loading": True}, status_code=503)
    return {"ok": True, "voice": VOICE, "loaded_s": state["loaded_s"]}


@app.post("/speak")
async def speak(sentence: Sentence):
    text = sentence.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f"text is longer than {MAX_CHARS} characters; send one sentence at a time")
    if state["speaker"] is None:
        raise HTTPException(503, "the models are still loading")
    audio, result = await asyncio.get_running_loop().run_in_executor(models, state["speaker"].say, text)
    wav = io.BytesIO()
    sf.write(wav, audio, RATE, format="WAV", subtype="PCM_16")
    return {**result, "audio": base64.b64encode(wav.getvalue()).decode()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

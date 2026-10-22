"""The model server (plan §3.2): keeps your voice, the aligner and the embedding model loaded. It
turns a sentence into audio plus lip timing, and text into embeddings for the chat's search.

It answers on 127.0.0.1 (this Mac only) by default. The chat backend reaches it from Docker at
host.docker.internal; nothing outside the Mac can, and the Cloudflare tunnel only leads to the
chat backend.

- GET /health: 200 with {"ok": true, "voice": ..., "embedding": ...} once the models are loaded, and 503 with
  "loading" in the first seconds after starting. The chat backend's own health check includes this
  one, since every reply needs your voice (§7.8). If the models fail to load, the server exits, so
  launchd starts it again.
- POST /speak with {"text": "One or two sentences."}: 200 with speak.py's result (text, spoken,
  duration, words, visemes, timing) plus "audio", the WAV file (mono, 24 kHz, 16-bit) in base64.
  The chat backend splits a reply into sentences and sends them one at a time (§6.1).
  - 400 if the text is empty or longer than MAX_CHARS.
  - words and visemes are null when the aligner fails on a sentence (§6.2's fallback).
- POST /embed with {"texts": [...], "kind": "passage" | "query"}: 200 with {"model", "dims",
  "vectors"}, one list of DIMS numbers per text, in order (embed.py). "query" is for a visitor's
  question, "passage" (the default) for the text being searched.
  - 400 if there are no texts, more than MAX_TEXTS, or one is empty or longer than MAX_EMBED_CHARS.

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
from typing import Literal

import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from embed import DIMS, MODEL as EMBEDDING, Embedder
from speak import Speaker
from voices import RATE

VOICE = "pocket-respelled"  # the bake-off's name for this voice (plan §6.3)
MAX_CHARS = 600  # a long sentence or two; replies are about 120 words, sent sentence by sentence
MAX_TEXTS = 256  # per /embed call; the whole profile is about 70 passages
MAX_EMBED_CHARS = 8000  # a passage or a pasted job posting (6,000 characters, plan §7.7)
models = ThreadPoolExecutor(max_workers=1)  # the one thread that touches the models
state: dict = {"speaker": None, "embedder": None, "loaded_s": None}


def load() -> None:
    started = time.perf_counter()
    try:
        state["speaker"] = Speaker()
        state["embedder"] = Embedder()
    except Exception:
        # A server that can never speak is worse than none: exit, so launchd starts it again.
        traceback.print_exc()
        print("model server: the models failed to load; exiting", file=sys.stderr, flush=True)
        os._exit(1)
    state["loaded_s"] = round(time.perf_counter() - started, 1)
    print(f"model server: {VOICE} and {EMBEDDING} loaded in {state['loaded_s']} s", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # The models load in the background, so /health can answer "still loading" meanwhile.
    models.submit(load)
    yield
    models.shutdown(wait=False)


app = FastAPI(title="merlinyang.com model server", lifespan=lifespan)


class Sentence(BaseModel):
    text: str


class Texts(BaseModel):
    texts: list[str]
    kind: Literal["passage", "query"] = "passage"


def ready() -> bool:
    return state["speaker"] is not None and state["embedder"] is not None


@app.get("/health")
def health():
    if not ready():
        return JSONResponse({"ok": False, "voice": VOICE, "embedding": EMBEDDING, "loading": True}, status_code=503)
    return {"ok": True, "voice": VOICE, "embedding": EMBEDDING, "loaded_s": state["loaded_s"]}


@app.post("/speak")
async def speak(sentence: Sentence):
    text = sentence.text.strip()
    if not text:
        raise HTTPException(400, "text is empty")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, f"text is longer than {MAX_CHARS} characters; send one sentence at a time")
    if not ready():
        raise HTTPException(503, "the models are still loading")
    audio, result = await asyncio.get_running_loop().run_in_executor(models, state["speaker"].say, text)
    wav = io.BytesIO()
    sf.write(wav, audio, RATE, format="WAV", subtype="PCM_16")
    return {**result, "audio": base64.b64encode(wav.getvalue()).decode()}


@app.post("/embed")
async def embed(body: Texts):
    if not body.texts or len(body.texts) > MAX_TEXTS:
        raise HTTPException(400, f"send between 1 and {MAX_TEXTS} texts")
    if any(not t.strip() or len(t) > MAX_EMBED_CHARS for t in body.texts):
        raise HTTPException(400, f"each text must be non-empty and at most {MAX_EMBED_CHARS} characters")
    if not ready():
        raise HTTPException(503, "the models are still loading")
    vectors = await asyncio.get_running_loop().run_in_executor(models, state["embedder"].embed, body.texts, body.kind)
    return {"model": EMBEDDING, "dims": DIMS, "vectors": vectors}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

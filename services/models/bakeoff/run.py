"""Voices every bake-off line with one model in your cloned voice, and times it (plan §6.3).

bakeoff.py runs this once per model, each in its own process, so each model's memory is measured
on its own. Each sentence is voiced separately, the way the chat will voice a reply, after one
warm-up sentence that isn't timed (the server keeps its model loaded and warm). Each model runs in
its faster mode. Qwen3-TTS and Pocket-TTS stream, handing over audio in pieces as they go (without
streaming, Qwen3-TTS decodes your whole reference clip again for every sentence). Chatterbox is
faster in one piece, because streaming reruns its audio decoder for every piece; its first sound is
then the whole sentence.

Writes knowledge/voice/bakeoff/<model>/<line id>.wav (the line's sentences joined with a short
pause) and timings.json: the load time, then each sentence's words, seconds until its first
audio, compute seconds in all, and audio seconds.

Run: cd services/models && uv run bakeoff/run.py <model>    (models: see MODELS)
"""

import json
import sys
import time

import numpy as np
import soundfile as sf

from common import OUT, RATE, REF, YOU, level, lines, pronunciations, sentences, spoken, words
from voices import Pocket, resample

QWEN_SMALL = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
# name: (engine, model repo, options). Options:
# - whole: voice each line in one go instead of sentence by sentence, so the intonation carries
#   across sentences. Streaming keeps the first sound as quick.
# - reference: copy the voice from your own take of this line (bakeoff/you/<line>.wav) instead of
#   sample.m4a. Your answers are conversational where the sample is a scripted reading, so the
#   cadence copied differs. That line itself is then an unfair comparison: the model heard you say it.
# - respell: say tricky names by their sound-it-out spellings from pronunciations.json (§6.1).
# - language: which of Kyutai's Pocket-TTS models to load (see pocket_tts/config); the default
#   "english" is their small model, and "english_2026-09_24l" their larger 24-layer one.
MODELS = {
    "qwen-0.6b": ("qwen", QWEN_SMALL, {}),
    "qwen-0.6b-whole": ("qwen", QWEN_SMALL, {"whole": True}),
    "qwen-0.6b-talk-whole": ("qwen", QWEN_SMALL, {"whole": True, "reference": "part3-4"}),
    "qwen-1.7b": ("qwen", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit", {}),
    "chatterbox-turbo": ("chatterbox", "mlx-community/chatterbox-turbo-fp16", {}),
    "chatterbox-turbo-8bit": ("chatterbox", "mlx-community/chatterbox-turbo-8bit", {}),
    "pocket": ("pocket", None, {}),
    "pocket-respelled": ("pocket", None, {"respell": True}),
    "pocket-24l": ("pocket", None, {"language": "english_2026-09_24l"}),
    "pocket-24l-respelled": ("pocket", None, {"language": "english_2026-09_24l", "respell": True}),
}
PAUSE = 0.25  # seconds of silence between sentences in a joined line
WARM_UP = "Thanks for stopping by."
STREAM_EVERY = 1.0  # seconds of audio per streamed piece
# MLX keeps freed graphics memory for reuse without limit, which made a 0.6B model's footprint
# reach 18 GB. Capped, the footprint shows what the model needs, as on the 16 GB Mac mini.
MLX_CACHE_GB = 1


def cap_mlx_cache() -> None:
    import mlx.core as mx

    mx.set_cache_limit(MLX_CACHE_GB * 2**30)


class Qwen:
    """Qwen3-TTS Base on the graphics chip. It copies from 20–30 s of audio plus its transcript."""

    def __init__(self, repo: str, options: dict):
        from mlx_audio.tts.utils import load_model
        from mlx_audio.utils import load_audio

        reference = options.get("reference")

        cap_mlx_cache()
        self.model = load_model(repo)
        self.rate = self.model.sample_rate
        if reference:
            self.ref = load_audio(str(YOU / f"{reference}.wav"), sample_rate=self.rate)
            self.ref_text = dict(lines())[reference]
        else:
            self.ref = load_audio(str(REF / "opening.wav"), sample_rate=self.rate)
            self.ref_text = (REF / "opening.txt").read_text().strip()

    def say(self, text: str, seed: int):
        import mlx.core as mx

        mx.random.seed(seed)
        for part in self.model.generate(
            text=text, ref_audio=self.ref, ref_text=self.ref_text, lang_code="english", stream=True, streaming_interval=STREAM_EVERY
        ):
            yield np.array(part.audio, dtype=np.float32)


class Chatterbox:
    """Chatterbox Turbo on the graphics chip. It reads the first 10–15 s of the reference itself."""

    def __init__(self, repo: str, options: dict):
        from mlx_audio.tts.utils import load_model

        cap_mlx_cache()
        self.model = load_model(repo)
        self.rate = self.model.sample_rate
        self.model.prepare_conditionals(str(REF / "ref.wav"))

    def say(self, text: str, seed: int):
        import mlx.core as mx

        mx.random.seed(seed)
        for part in self.model.generate(text=text, split_pattern=None):
            yield np.array(part.audio, dtype=np.float32)


ENGINES = {"qwen": Qwen, "chatterbox": Chatterbox, "pocket": Pocket}


def main() -> None:
    name = sys.argv[1]
    kind, repo, options = MODELS[name]
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    engine = ENGINES[kind](repo, options)
    table = pronunciations() if options.get("respell") else {}
    list(engine.say(WARM_UP, 0))
    load_s = time.perf_counter() - started
    print(f"{name}: loaded and warmed up in {load_s:.1f} s", flush=True)

    timings = []
    seed = 1
    for line, text in lines():
        pieces = []
        for sentence in [text] if options.get("whole") else sentences(text):
            started = time.perf_counter()
            first = None
            chunks = []
            for chunk in engine.say(spoken(sentence, table), seed):
                first = first or time.perf_counter() - started
                chunks.append(chunk)
            seconds = time.perf_counter() - started
            audio = resample(np.concatenate(chunks), engine.rate)
            seed += 1
            timings.append(
                {
                    "line": line,
                    "text": sentence,
                    "words": len(words(sentence)),
                    "first": round(first, 3),
                    "seconds": round(seconds, 3),
                    "audio": round(len(audio) / RATE, 3),
                }
            )
            pieces += [audio, np.zeros(int(PAUSE * RATE), dtype=np.float32)]
            print(f"  {line} first sound {first:4.1f} s, {seconds:5.1f} s for {len(audio) / RATE:5.1f} s of audio", flush=True)
        sf.write(out / f"{line}.wav", level(np.concatenate(pieces[:-1])), RATE)

    (out / "timings.json").write_text(json.dumps({"model": name, "repo": repo, "load_s": round(load_s, 1), "sentences": timings}, indent=1) + "\n")


if __name__ == "__main__":
    main()

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

from common import OUT, RATE, REF, level, lines, sentences, words

MODELS = {
    "qwen-0.6b": ("qwen", "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"),
    "qwen-1.7b": ("qwen", "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"),
    "chatterbox-turbo": ("chatterbox", "mlx-community/chatterbox-turbo-fp16"),
    "chatterbox-turbo-8bit": ("chatterbox", "mlx-community/chatterbox-turbo-8bit"),
    "pocket": ("pocket", None),
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

    def __init__(self, repo: str):
        from mlx_audio.tts.utils import load_model
        from mlx_audio.utils import load_audio

        cap_mlx_cache()
        self.model = load_model(repo)
        self.rate = self.model.sample_rate
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

    def __init__(self, repo: str):
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


class Pocket:
    """Pocket-TTS on the CPU through PyTorch, leaving the graphics chip free."""

    def __init__(self, _repo: None):
        from pocket_tts import TTSModel

        self.model = TTSModel.load_model()
        self.rate = self.model.sample_rate
        self.voice = self.model.get_state_for_audio_prompt(str(REF / "ref.wav"), truncate=True)

    def say(self, text: str, seed: int):
        import torch

        torch.manual_seed(seed)
        for part in self.model.generate_audio_stream(self.voice, text):
            yield part.numpy().astype(np.float32)


ENGINES = {"qwen": Qwen, "chatterbox": Chatterbox, "pocket": Pocket}


def resample(audio: np.ndarray, rate: int) -> np.ndarray:
    if rate == RATE:
        return audio
    from scipy.signal import resample_poly

    return resample_poly(audio, RATE, rate).astype(np.float32)


def main() -> None:
    name = sys.argv[1]
    kind, repo = MODELS[name]
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    engine = ENGINES[kind](repo)
    list(engine.say(WARM_UP, 0))
    load_s = time.perf_counter() - started
    print(f"{name}: loaded and warmed up in {load_s:.1f} s", flush=True)

    timings = []
    seed = 1
    for line, text in lines():
        pieces = []
        for sentence in sentences(text):
            started = time.perf_counter()
            first = None
            chunks = []
            for chunk in engine.say(sentence, seed):
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

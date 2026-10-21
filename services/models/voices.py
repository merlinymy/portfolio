"""The voice the site speaks in (plan §6.3): Pocket-TTS copying your reference recording, saying
tricky names by their sound-it-out spellings ("pocket-respelled" in the bake-off).

Pocket-TTS runs on the CPU, where it's faster than on the graphics chip and leaves that free for the
aligner and the search model.
"""

import json
import re
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RATE = 24_000  # samples per second of every audio file the voice makes
# Your reference recording, trimmed by bakeoff/prepare.py from knowledge/voice/sample.m4a. Pocket-TTS
# copies the voice from its first 30 s.
REFERENCE = ROOT / "knowledge/voice/bakeoff/ref/ref.wav"
# Sound-it-out spellings for names the voice says wrong (plan §6.1). Public, so committed.
PRONUNCIATIONS = HERE / "pronunciations.json"


class Pocket:
    """Pocket-TTS on the CPU through PyTorch. `language` picks one of Kyutai's models (see
    pocket_tts/config); the default "english" is their small one, which won the bake-off."""

    def __init__(self, _repo: None = None, options: dict | None = None):
        from pocket_tts import TTSModel

        options = options or {}
        self.model = TTSModel.load_model(language=options.get("language"))
        self.rate = self.model.sample_rate
        self.voice = self.model.get_state_for_audio_prompt(str(REFERENCE), truncate=True)

    def say(self, text: str, seed: int):
        """Yields the sentence's audio in pieces as they're made."""
        import torch

        torch.manual_seed(seed)
        for part in self.model.generate_audio_stream(self.voice, text):
            yield part.numpy().astype(np.float32)


def resample(audio: np.ndarray, rate: int, to: int = RATE) -> np.ndarray:
    if rate == to:
        return audio
    from scipy.signal import resample_poly

    return resample_poly(audio, to, rate).astype(np.float32)


def pronunciations() -> dict[str, str]:
    return json.loads(PRONUNCIATIONS.read_text()) if PRONUNCIATIONS.exists() else {}


def respell(text: str, table: dict[str, str]) -> list[tuple[str, list[str]]]:
    """Each on-screen word with the words the voice says for it."""
    out: list[tuple[str, list[str]]] = []
    for word in text.split():
        lead, core, trail = re.match(r"^(\W*)(.*?)(\W*)$", word).groups()
        if not core:  # a lone dash or quote: keep it in the voice's text for the pause it gives
            if out:
                out[-1][1][-1] += " " + word
            continue
        spoken = (table.get(core) or table.get(core.lower()) or core).split()
        # The punctuation stays, since the voice model pauses and phrases by it.
        spoken[0] = lead + spoken[0]
        spoken[-1] = spoken[-1] + trail
        out.append((word, spoken))
    return out


def spoken(text: str, table: dict[str, str]) -> str:
    """The text the voice is asked to say, with the sound-it-out spellings swapped in."""
    return " ".join(w for _, ws in respell(text, table) for w in ws)

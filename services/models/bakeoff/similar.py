"""Estimates how much each model sounds like you (plan §6.3), as a guide next to your own ears.

A speaker-verification model (Microsoft's WavLM, as used to check voice clones in speech research)
turns a recording into a voiceprint: a list of numbers that's similar for the same voice and
different for different voices, whatever the words. Each model's voiceprint, averaged over half of
its lines, is compared with yours, averaged over the other half of your takes, and the two halves
are swapped and averaged. Two baselines make the scores readable:
- **The ceiling:** your own takes, half against half, show how alike you sound to yourself.
- **A stranger:** the Mac's built-in voices (Eddy, a US English voice, and Daniel, a British one)
  read the same lines, and show what a different man scores.

The score is cosine similarity: 1.00 is identical. This voiceprint model scores everyone fairly
high, so read a model's score between the stranger's and yours. Your ears decide; this only says
where to listen closely.

Writes knowledge/voice/bakeoff/similar.json, which bakeoff.py --report adds to the results.

Run: cd services/models && uv run bakeoff/similar.py
"""

import json
import subprocess

import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly
from transformers import AutoFeatureExtractor, WavLMForXVector

from common import OUT, YOU, lines
from run import MODELS

SPEAKER_MODEL = "microsoft/wavlm-base-plus-sv"
LISTEN_RATE = 16_000
STRANGERS = {"stranger-eddy": "Eddy (English (US))", "stranger-daniel": "Daniel"}


def strangers() -> None:
    """The same lines read by the Mac's built-in voices, once."""
    for name, voice in STRANGERS.items():
        folder = OUT / name
        folder.mkdir(exist_ok=True)
        for line, text in lines():
            wav = folder / f"{line}.wav"
            if wav.exists():
                continue
            # say froze when asked for WAV directly, so it writes its own AIFF format from a text
            # file, and ffmpeg converts that.
            aiff, txt = wav.with_suffix(".aiff"), wav.with_suffix(".txt")
            txt.write_text(text)
            subprocess.run(["say", "-v", voice, "-f", str(txt), "-o", str(aiff)], check=True, timeout=120)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", "24000", str(wav)], check=True)
            aiff.unlink()
            txt.unlink()


def main() -> None:
    strangers()
    extractor = AutoFeatureExtractor.from_pretrained(SPEAKER_MODEL)
    model = WavLMForXVector.from_pretrained(SPEAKER_MODEL).eval()

    def voiceprint(path) -> np.ndarray:
        audio, rate = sf.read(path, dtype="float32")
        audio = resample_poly(audio, LISTEN_RATE, rate) if rate != LISTEN_RATE else audio
        inputs = extractor(audio, sampling_rate=LISTEN_RATE, return_tensors="pt")
        with torch.no_grad():
            v = model(**inputs).embeddings[0].numpy()
        return v / np.linalg.norm(v)

    def centre(vs: list[np.ndarray]) -> np.ndarray:
        m = np.mean(vs, axis=0)
        return m / np.linalg.norm(m)

    every = [line for line, _ in lines() if (YOU / f"{line}.wav").exists()]
    yours = {i: voiceprint(YOU / f"{i}.wav") for i in every}
    scores = {}
    for name, folder in [("you", YOU)] + [(n, OUT / n) for n in [*MODELS, *STRANGERS]]:
        # A model that copied your take of a line would be compared with the very recording it copied.
        copied = MODELS[name][2].get("reference") if name in MODELS else None
        ids = [i for i in every if i != copied]
        halves = (ids[0::2], ids[1::2])
        if not all((folder / f"{i}.wav").exists() for i in ids):
            continue
        theirs = yours if name == "you" else {i: voiceprint(folder / f"{i}.wav") for i in ids}
        a = float(centre([theirs[i] for i in halves[0]]) @ centre([yours[i] for i in halves[1]]))
        b = float(centre([theirs[i] for i in halves[1]]) @ centre([yours[i] for i in halves[0]]))
        scores[name] = round((a + b) / 2, 3)
        print(f"{name}: {scores[name]:.3f}")
    (OUT / "similar.json").write_text(json.dumps(scores, indent=1) + "\n")


if __name__ == "__main__":
    main()

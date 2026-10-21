"""Prepares your reference recording for the voice bake-off (plan §6.3).

Reads knowledge/voice/sample.m4a and writes, into knowledge/voice/bakeoff/ref/ (private, ignored
by git):
- ref.wav: mono, 24 kHz, with the silence at both ends trimmed.
- ref.txt: what you actually said, transcribed by Parakeet, because the voice models copy best
  when the transcript matches the recording word for word.
- ref.json: each sentence's start and end time.
- opening.wav and opening.txt: the whole opening sentences that fit in 30 s, for Qwen3-TTS, which
  copies best from 20–30 s of audio plus its transcript. Chatterbox and Pocket-TTS take ref.wav and
  cut it themselves (Chatterbox reads its first 10–15 s).

Run: cd services/models && uv run bakeoff/prepare.py
"""

import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from mlx_audio.stt import load

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "knowledge/voice/sample.m4a"
OUT = ROOT / "knowledge/voice/bakeoff/ref"
RATE = 24_000
OPENING_SECONDS = 30.0
STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

# ffmpeg's silenceremove only trims the start, so the audio is reversed to trim the end too.
TRIM = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.15"
TRIM_BOTH = f"{TRIM},areverse,{TRIM},areverse"


def decibels(x: np.ndarray) -> float:
    return float(20 * np.log10(max(np.sqrt(np.mean(x**2)), 1e-9)))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    ref = OUT / "ref.wav"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(SOURCE), "-ac", "1", "-ar", str(RATE), "-af", TRIM_BOTH, str(ref)],
        check=True,
    )
    audio, rate = sf.read(ref, dtype="float32")
    frames = audio[: len(audio) // 2400 * 2400].reshape(-1, 2400)  # 0.1 s frames
    loudness = np.array([decibels(f) for f in frames])
    print(f"ref.wav: {len(audio) / rate:.1f} s, peak {20 * np.log10(np.abs(audio).max()):.1f} dBFS")
    print(f"  speech level (loudest 50%) {np.median(np.sort(loudness)[len(loudness) // 2 :]):.1f} dB,"
          f" room noise (quietest 10%) {np.median(np.sort(loudness)[: len(loudness) // 10]):.1f} dB")

    result = load(STT_MODEL).generate(str(ref))
    sentences = [{"text": s.text.strip(), "start": round(s.start, 3), "end": round(s.end, 3)} for s in result.sentences]
    (OUT / "ref.txt").write_text(result.text.strip() + "\n")
    (OUT / "ref.json").write_text(json.dumps(sentences, indent=2) + "\n")
    gaps = [round(b["start"] - a["end"], 2) for a, b in zip(sentences, sentences[1:])]
    print(f"\n{len(sentences)} sentences; pauses between them (s): {gaps}")
    for s in sentences:
        print(f"  [{s['start']:5.1f}–{s['end']:5.1f}] {s['text']}")

    # The opening: whole sentences from the start, as many as fit in OPENING_SECONDS.
    opening = [s for s in sentences if s["end"] <= OPENING_SECONDS + sentences[0]["start"]]
    if opening:
        end = min(opening[-1]["end"] + 0.25, len(audio) / rate)
        sf.write(OUT / "opening.wav", audio[: int(end * rate)], rate)
        (OUT / "opening.txt").write_text(" ".join(s["text"] for s in opening) + "\n")
        print(f"\nopening.wav: {end:.1f} s, {len(opening)} sentences")


if __name__ == "__main__":
    main()

"""Paths and helpers shared by the voice bake-off scripts (plan §6.3).

Everything the bake-off reads and writes is your voice or your scripted answers, so it all lives in
knowledge/voice/ (private, ignored by git); only the scripts are committed.
"""

import json
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
VOICE = ROOT / "knowledge/voice"
SCRIPT = VOICE / "recording-script.md"
OUT = VOICE / "bakeoff"
REF = OUT / "ref"
YOU = OUT / "you"
RATE = 24_000
STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
# Sound-it-out spellings for names the voice models say wrong (plan §6.1); public, so committed.
PRONUNCIATIONS = ROOT / "services/models/pronunciations.json"

# The lines every model voices: your Part 3 answers (to compare with your own recording) and the
# Part 4 names (to hear which ones need a sound-it-out spelling, §6.1).
PARTS = (3, 4)


def paragraphs(part: int) -> list[str]:
    """The quoted paragraphs under "## Part <part>" in the recording script."""
    sections = re.split(r"^## ", SCRIPT.read_text(), flags=re.M)
    body = next(s for s in sections if s.startswith(f"Part {part}:"))
    blocks: list[str] = []
    current: list[str] = []
    for line in body.splitlines() + [""]:
        if line.startswith(">"):
            current.append(line.lstrip("> ").strip())
        elif current:
            blocks.append(" ".join(current))
            current = []
    return blocks


def lines() -> list[tuple[str, str]]:
    """Every bake-off line as (id, text), with ids like part3-1."""
    return [(f"part{p}-{i}", text) for p in PARTS for i, text in enumerate(paragraphs(p), 1)]


def sentences(paragraph: str) -> list[str]:
    """Splits where a sentence ends and a capitalized one starts, so "U.S., and" stays whole."""
    return re.split(r"(?<=[.!?])\s+(?=[A-Z])", paragraph)


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower().replace("'", ""))


def level(audio: np.ndarray, target_db: float = -20.0) -> np.ndarray:
    """Scales a take to the same loudness as the others, so none sounds better for being louder."""
    rms = float(np.sqrt(np.mean(audio**2)))
    if rms < 1e-6:
        return audio
    out = audio * (10 ** (target_db / 20) / rms)
    peak = float(np.abs(out).max())
    return out * (0.98 / peak) if peak > 0.98 else out


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

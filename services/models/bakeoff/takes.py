"""Cuts your own takes out of answers.m4a (Part 3) and words.m4a (Part 4), to play next to each
model's version of the same line (plan §6.3).

The recordings contain coughs and restarted paragraphs, so each paragraph's last full take is
used. Parakeet transcribes the recording into sentences with times, and each heard sentence is
matched letter by letter to the script paragraph, so a misheard name doesn't break the match. A
take is a run of heard sentences moving forward through one paragraph; jumping back to earlier
text of it means you restarted.

Writes knowledge/voice/bakeoff/you/<line id>.wav and prints how closely each take matches the
script (1.00 means word for word).

Run: cd services/models && uv run bakeoff/takes.py
"""

import subprocess
from difflib import SequenceMatcher

import numpy as np
import soundfile as sf
from mlx_audio.stt import load

from common import RATE, STT_MODEL, VOICE, YOU, level, paragraphs, words

RECORDINGS = {3: VOICE / "answers.m4a", 4: VOICE / "words.m4a"}
STT_RATE = 16_000  # Parakeet listens at 16 kHz; given samples at another rate, it mishears them
CLOSE_ENOUGH = 0.6  # the share of a heard sentence's letters that must appear in the paragraph
FULL = 0.75  # the share of a paragraph's letters a take must cover to count as full
SLACK = 10  # letters a take may step back without counting as a restart
PIECE = 3  # shorter runs of matching letters are coincidence


def decode(path, rate: int = RATE) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def letters(text: str) -> str:
    """Letters and digits only, so "RF diffusion" heard matches "RFdiffusion" written."""
    return "".join(words(text))


def heard_sentences(model, audio: np.ndarray) -> list[tuple[str, float, float]]:
    """Each sentence Parakeet heard, as (letters, start s, end s)."""
    import mlx.core as mx

    # Without chunks Parakeet drops whole sentences from a long recording; 30 s chunks keep them.
    result = model.generate(mx.array(audio), chunk_duration=30.0, overlap_duration=5.0)
    return [(letters(s.text), s.start, s.end) for s in result.sentences if letters(s.text)]


def cover(said: str, paragraph: str, offset: int) -> set[int] | None:
    """The paragraph positions (from `offset` on) that a heard sentence matches, if it matches."""
    blocks = SequenceMatcher(None, said, paragraph[offset:], autojunk=False).get_matching_blocks()
    blocks = [m for m in blocks if m.size >= PIECE]
    if sum(m.size for m in blocks) < CLOSE_ENOUGH * len(said):
        return None
    return {offset + m.b + i for m in blocks for i in range(m.size)}


def find_takes(heard, paragraph: str) -> list[list[tuple[int, set[int]]]]:
    """Runs of (heard index, paragraph positions it covers) that move forward through the
    paragraph. A heard sentence that only matches earlier text than where the run got to is a
    restart; one that continues the run is preferred, since paragraphs repeat phrases."""
    takes: list[list[tuple[int, set[int]]]] = []
    previous, reached = -2, 0
    for h, (said, _, _) in enumerate(heard):
        covered = cover(said, paragraph, max(reached - SLACK, 0)) if takes and previous == h - 1 else None
        if covered:
            takes[-1].append((h, covered))
        elif covered := cover(said, paragraph, 0):
            takes.append([(h, covered)])
        else:
            continue
        previous, reached = h, max(covered) + 1
    return takes


def main() -> None:
    YOU.mkdir(parents=True, exist_ok=True)
    model = load(STT_MODEL)
    for part, recording in RECORDINGS.items():
        audio = decode(recording)
        heard = heard_sentences(model, decode(recording, STT_RATE))
        print(f"{recording.name}: {len(audio) / RATE:.0f} s, {len(heard)} sentences heard")
        for i, text in enumerate(paragraphs(part), 1):
            line = f"part{part}-{i}"
            paragraph = letters(text)
            takes = find_takes(heard, paragraph)
            reach = [len(set().union(*(c for _, c in t))) / len(paragraph) for t in takes]
            full = [t for t, r in zip(takes, reach) if r >= FULL]
            if not takes:
                print(f"  {line}: no take found")
                continue
            take = full[-1] if full else takes[int(np.argmax(reach))]
            first, last = take[0][0], take[-1][0]
            said = "".join(heard[h][0] for h in range(first, last + 1))
            score = SequenceMatcher(None, said, paragraph, autojunk=False).ratio()
            start = max(heard[first][1] - 0.15, 0)
            end = min(heard[last][2] + 0.3, len(audio) / RATE)
            sf.write(YOU / f"{line}.wav", level(audio[int(start * RATE) : int(end * RATE)]), RATE)
            note = "" if full else "  (partial: no full take)"
            print(f"  {line}: {start:6.1f}–{end:6.1f} s, {len(takes)} take(s), match {score:.2f}{note}")


if __name__ == "__main__":
    main()

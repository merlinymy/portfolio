"""Turns one sentence into your cloned voice plus the mouth-shape timing the face plays (plan §6.1).

1. Tricky names are swapped for sound-it-out spellings (pronunciations.json), for the voice only.
2. The voice (voices.py) speaks the sentence.
3. The forced aligner, given the sentence and the audio, finds when each word starts and ends.
4. Each word becomes speech sounds through the CMU Pronouncing Dictionary, and each sound one of the
   face's 15 mouth shapes (visemes.json), spread across the word's time.

A Speaker loads the models once and then voices sentence after sentence; the model server
(server.py) keeps one. Each result holds:
- text: the sentence as shown on screen; spoken: what the voice was asked to say.
- duration: the audio's length in seconds.
- words: each on-screen word with its start and end in seconds, for revealing the text in step.
- visemes: [seconds, shape] pairs; each shape holds until the next one. "sil" is the closed,
  resting mouth.
- words and visemes are null if the aligner fails on a sentence; the browser then times the lips
  from the playing audio instead (§6.2).

Run: cd services/models && uv run speak.py "A sentence to say." [--out <dir>]
It writes <name>.wav and <name>.json to knowledge/voice/speak/ unless --out says otherwise, since
it's your voice.
"""

import argparse
import json
import re
import time
import urllib.request
import zlib
from pathlib import Path

import numpy as np
import soundfile as sf

from voices import PRONUNCIATIONS, RATE, ROOT, Pocket, pronunciations, resample, respell

ALIGNER = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
ALIGNER_RATE = 16_000  # the aligner listens at 16 kHz
MLX_CACHE_GB = 1
# The dictionary file itself, under CMU's BSD-style license (the `cmudict` Python package is GPL).
CMUDICT_VERSION = "74790861f652b15e4ac49015a90074ad62a27690"
CMUDICT_URL = f"https://raw.githubusercontent.com/cmusphinx/cmudict/{CMUDICT_VERSION}/cmudict.dict"
CACHE = Path.home() / ".cache/portfolio-models"
GAP = 0.1  # seconds of silence between words before the mouth closes

# Speech sounds (ARPAbet, the dictionary's notation) to the face's mouth shapes.
VISEME = {
    **dict.fromkeys(["P", "B", "M"], "PP"),
    **dict.fromkeys(["F", "V"], "FF"),
    **dict.fromkeys(["TH", "DH"], "TH"),
    **dict.fromkeys(["T", "D"], "DD"),
    **dict.fromkeys(["K", "G"], "kk"),
    **dict.fromkeys(["CH", "JH", "SH", "ZH"], "CH"),
    **dict.fromkeys(["S", "Z"], "SS"),
    **dict.fromkeys(["N", "NG", "L"], "nn"),
    **dict.fromkeys(["R", "ER"], "RR"),
    **dict.fromkeys(["AA", "AH", "AY", "AW"], "aa"),
    **dict.fromkeys(["AE", "EH", "EY"], "E"),
    **dict.fromkeys(["IH", "IY", "Y"], "ih"),
    **dict.fromkeys(["AO", "OW", "OY"], "oh"),
    **dict.fromkeys(["UH", "UW", "W"], "ou"),
    "HH": None,  # an "h" takes the shape of the sound after it
}
VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"}
STOPS = {"P", "B", "T", "D", "K", "G"}
# For words the dictionary lacks: a rough sound for each letter, which is enough for the lips.
LETTER = {
    "a": "AE", "b": "B", "c": "K", "d": "D", "e": "EH", "f": "F", "g": "G", "h": "HH", "i": "IH",
    "j": "JH", "k": "K", "l": "L", "m": "M", "n": "N", "o": "AA", "p": "P", "q": "K", "r": "R",
    "s": "S", "t": "T", "u": "AH", "v": "V", "w": "W", "x": "K", "y": "Y", "z": "Z",
}
# Letters said by name, for spelled-out names like "A W S".
LETTER_NAME = {
    "a": "EY", "b": "B IY", "c": "S IY", "d": "D IY", "e": "IY", "f": "EH F", "g": "JH IY", "h": "EY CH",
    "i": "AY", "j": "JH EY", "k": "K EY", "l": "EH L", "m": "EH M", "n": "EH N", "o": "OW", "p": "P IY",
    "q": "K Y UW", "r": "AA R", "s": "EH S", "t": "T IY", "u": "Y UW", "v": "V IY", "w": "D AH B AH L Y UW",
    "x": "EH K S", "y": "W AY", "z": "Z IY",
}
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_words(n: int) -> list[str]:
    """How a number is said, for the lips only; years like 2028 are said in pairs."""
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if 1100 <= n < 10000 and n % 100 >= 10:  # 2028 is "twenty twenty-eight"; 2005 "two thousand five"
        return number_words(n // 100) + number_words(n % 100)
    if n < 1000:
        return [ONES[n // 100], "hundred"] + (number_words(n % 100) if n % 100 else [])
    return number_words(n // 1000) + ["thousand"] + (number_words(n % 1000) if n % 1000 else [])


class Pronouncer:
    def __init__(self):
        path = CACHE / f"cmudict-{CMUDICT_VERSION[:8]}.dict"
        if not path.exists():
            CACHE.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(CMUDICT_URL, path)
        self.words: dict[str, list[str]] = {}
        for line in path.read_text().splitlines():
            word, *sounds = line.split("#")[0].split()
            if "(" not in word:  # the first pronunciation of each word is the common one
                self.words[word] = [re.sub(r"\d", "", s) for s in sounds]

    def sounds(self, word: str) -> list[str]:
        key = plain(word).strip("'")
        if key in self.words:
            return self.words[key]
        if key.isdigit():
            return [s for w in number_words(int(key)) for s in self.sounds(w)]
        return [LETTER[c] for c in key if c in LETTER]


def plain(word: str) -> str:
    return re.sub(r"[^a-z0-9']", "", word.lower())


def mouth_shapes(words: list[tuple[list[str], float, float]], pronouncer) -> list[list]:
    """Spreads each word's sounds across its time, vowels longer than consonants, and lists where
    the mouth shape changes."""
    events: list[list] = []
    previous_end = 0.0
    for spoken, start, end in words:
        if start - previous_end >= GAP:
            events.append([round(previous_end, 3), "sil"])
        # A name respelled as several words may spell letters out ("P G vector"): say those by name,
        # since the dictionary reads a lone "a" as the word "a".
        spelled = len(spoken) > 1
        sounds = [
            s
            for w in spoken
            for s in (LETTER_NAME[plain(w)].split() if spelled and len(plain(w)) == 1 and plain(w) in LETTER_NAME else pronouncer.sounds(w))
        ]
        weights = [1.6 if s in VOWELS else 0.7 if s in STOPS else 1.0 for s in sounds]
        t = start
        shapes = [VISEME.get(s, "sil") for s in sounds]
        for i, shape in enumerate(shapes):
            if shape is None:  # "h": borrow the next sound's shape
                shape = next((x for x in shapes[i + 1 :] if x), "sil")
            events.append([round(t, 3), shape])
            t += (end - start) * weights[i] / sum(weights)
        previous_end = end
    events.append([round(previous_end, 3), "sil"])
    merged = [e for i, e in enumerate(events) if i == 0 or e[1] != events[i - 1][1]]
    return merged


def align(aligner, audio: np.ndarray, groups: list[tuple[str, list[str]]]) -> list[tuple[list[str], float, float]]:
    """Start and end of each on-screen word, from the aligner's times for the spoken words."""
    spoken = [w for _, ws in groups for w in ws]
    heard = resample(audio, RATE, ALIGNER_RATE)
    items = [i for i in aligner.generate(heard, text=" ".join(spoken), language="English").items if plain(i.text)]
    if len(items) != len(spoken):
        raise RuntimeError(f"the aligner returned {len(items)} words for {len(spoken)}")
    out, k = [], 0
    for _, ws in groups:
        part = items[k : k + len(ws)]
        out.append((ws, part[0].start_time, part[-1].end_time))
        k += len(ws)
    return out


class Speaker:
    """Your voice plus lip timing, with the models loaded once."""

    def __init__(self):
        import mlx.core as mx
        from mlx_audio.stt import load

        # MLX (the aligner's library) keeps freed graphics memory for reuse with no limit, which
        # would let an always-on server grow; 1 GB is plenty for the aligner.
        mx.set_cache_limit(MLX_CACHE_GB * 2**30)
        self.voice = Pocket()
        self.aligner = load(ALIGNER)
        self.pronouncer = Pronouncer()
        self._table: dict[str, str] = {}
        self._table_version = None
        self.say("Thanks for stopping by.")  # the first sentence is slow, so it's spent here

    def table(self) -> dict[str, str]:
        """The sound-it-out spellings, re-read whenever pronunciations.json changes."""
        version = PRONUNCIATIONS.stat().st_mtime if PRONUNCIATIONS.exists() else None
        if version != self._table_version:
            self._table, self._table_version = pronunciations(), version
        return self._table

    def say(self, text: str) -> tuple[np.ndarray, dict]:
        """The sentence's audio (mono, RATE samples a second) and its timing."""
        groups = respell(text, self.table())
        spoken_text = " ".join(w for _, ws in groups for w in ws)
        started = time.perf_counter()
        # The same sentence always gets the same random seed, so it's voiced the same way each time.
        seed = zlib.crc32(spoken_text.encode())
        audio = resample(np.concatenate(list(self.voice.say(spoken_text, seed))), self.voice.rate)
        voiced = time.perf_counter() - started
        try:
            timed = align(self.aligner, audio, groups)
            words = [{"text": shown, "start": round(s, 3), "end": round(e, 3)} for (shown, _), (_, s, e) in zip(groups, timed)]
            shapes = mouth_shapes(timed, self.pronouncer)
        except RuntimeError:
            words = shapes = None
        result = {
            "text": text,
            "spoken": spoken_text,
            "duration": round(len(audio) / RATE, 3),
            "words": words,
            "visemes": shapes,
            "timing": {"voice_s": round(voiced, 3), "align_s": round(time.perf_counter() - started - voiced, 3)},
        }
        return audio, result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("text")
    parser.add_argument("--out", type=Path, default=ROOT / "knowledge/voice/speak")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^a-z0-9]+", "-", args.text.lower()).strip("-")[:48]

    started = time.perf_counter()
    speaker = Speaker()
    print(f"loaded in {time.perf_counter() - started:.1f} s")

    audio, result = speaker.say(args.text)
    wav = args.out / f"{name}.wav"
    sf.write(wav, audio, RATE)
    (args.out / f"{name}.json").write_text(json.dumps({**result, "audio": wav.name}, indent=1) + "\n")
    t = result["timing"]
    print(f"voiced {result['duration']:.1f} s of audio in {t['voice_s']:.1f} s (RTF {t['voice_s'] / result['duration']:.2f}), aligned in {t['align_s']:.2f} s")
    timed = "no word timing (the aligner failed)" if result["words"] is None else f"{len(result['words'])} words, {len(result['visemes'])} mouth shapes"
    print(f"wrote {wav} and {name}.json: {timed}")


if __name__ == "__main__":
    main()

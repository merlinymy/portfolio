"""Checks whether each model said the words right (plan §6.3), so you know which lines to listen to
first.

Parakeet transcribes every voiced line, and the transcript is compared letter by letter with the
script (1.00 means every letter heard as written). Your own takes are checked the same way, as the
baseline: Parakeet mishears some names even from you, so a model doing as well as you is saying them
fine. A line well below your score usually has a skipped, repeated or garbled word.

Writes knowledge/voice/bakeoff/<model or you>/heard.json, which bakeoff.py --report adds to the
results.

Run: cd services/models && uv run bakeoff/heard.py
"""

import json
from difflib import SequenceMatcher

from mlx_audio.stt import load

from common import OUT, STT_MODEL, YOU, lines
from run import MODELS
from takes import letters


def main() -> None:
    model = load(STT_MODEL)
    script = dict(lines())
    for folder in [YOU] + [OUT / name for name in MODELS]:
        if not folder.exists():
            continue
        heard = {}
        for line, text in script.items():
            wav = folder / f"{line}.wav"
            if not wav.exists():
                continue
            said = model.generate(str(wav)).text.strip()
            match = SequenceMatcher(None, letters(said), letters(text), autojunk=False).ratio()
            heard[line] = {"heard": said, "match": round(match, 3)}
        (folder / "heard.json").write_text(json.dumps(heard, indent=1) + "\n")
        worst = sorted(heard.items(), key=lambda kv: kv[1]["match"])[:3]
        print(f"{folder.name}: lowest {', '.join(f'{k} {v['match']:.2f}' for k, v in worst)}")


if __name__ == "__main__":
    main()

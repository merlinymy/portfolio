"""Tries sound-it-out spellings for each tricky name, so you can pick how each one should sound
(plan §6.1).

For every name in pronunciation-candidates.json, the voice says a short sentence with the name as
written and with each spelling to try, twice with different random seeds, since a model can say a
word cleanly once and jumble it the next time. Parakeet transcribes each take and checks the sentence
came out whole and as asked ("said cleanly", 1.00 is word for word, averaged over both takes).

Writes knowledge/voice/words/index.html (private, ignored by git): each name with your own take of
the line it's in, then every spelling's take and score. The spelling now in pronunciations.json is
marked "in use". Tell Claude which you prefer, or edit pronunciations.json yourself.

Run: cd services/models && uv run bakeoff/words.py [--model pocket]
"""

import argparse
import html
import json
import re
from difflib import SequenceMatcher

import numpy as np
import soundfile as sf
from mlx_audio.stt import load

from common import RATE, ROOT, STT_MODEL, VOICE, YOU, level, lines, pronunciations
from run import ENGINES, MODELS, resample
from takes import letters

CANDIDATES = ROOT / "services/models/pronunciation-candidates.json"
OUT = VOICE / "words"
CARRIER = "I work with {} every day."
SEEDS = (1, 2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="pocket", choices=list(MODELS))
    args = parser.parse_args()
    kind, repo, options = MODELS[args.model]
    voice = ENGINES[kind](repo, options)
    list(voice.say("Thanks for stopping by.", 0))
    stt = load(STT_MODEL)
    in_use = pronunciations()
    script = lines()

    sections = []
    for term, tries in json.loads(CANDIDATES.read_text()).items():
        folder = OUT / args.model / re.sub(r"[^a-z0-9]+", "-", term.lower())
        folder.mkdir(parents=True, exist_ok=True)
        rows = []
        for i, spelling in enumerate([term] + tries):
            scores, takes = [], []
            for seed in SEEDS:
                audio = resample(np.concatenate(list(voice.say(CARRIER.format(spelling), seed))), voice.rate)
                wav = folder / f"{i}-{seed}.wav"
                sf.write(wav, level(audio), RATE)
                heard = stt.generate(str(wav)).text.strip()
                asked = max(
                    SequenceMatcher(None, letters(heard), letters(CARRIER.format(x)), autojunk=False).ratio()
                    for x in (term, spelling)
                )
                scores.append(asked)
                takes.append((wav, heard))
            rows.append((spelling, float(np.mean(scores)), takes))
            print(f"{term:16} {spelling!r:22} said cleanly {np.mean(scores):.2f}  ({takes[0][1]!r})", flush=True)

        yours = next((line for line, text in script if term in text and (YOU / f"{line}.wav").exists()), None)
        current = in_use.get(term, term)
        cells = []
        if yours:
            src = html.escape(str((YOU / f"{yours}.wav").relative_to(OUT, walk_up=True)))
            cells.append(f'<div class="take"><b>You</b> <small>({yours})</small><audio controls preload="none" src="{src}"></audio></div>')
        for spelling, score, takes in rows:
            mark = " <em>in use</em>" if spelling == current else ""
            label = "as written" if spelling == term else html.escape(spelling)
            players = "".join(
                f'<audio controls preload="none" src="{html.escape(str(w.relative_to(OUT)))}" title="{html.escape(h)}"></audio>'
                for w, h in takes
            )
            cells.append(f'<div class="take"><b>{label}</b>{mark} <small>said cleanly {score:.2f}</small>{players}</div>')
        sections.append(f"<section><h2>{html.escape(term)}</h2>{''.join(cells)}</section>")

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Name spellings</title><style>
  :root {{ color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #666; --line: #ddd; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #151515; --fg: #eee; --muted: #999; --line: #333; }} }}
  body {{ background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px; }}
  section {{ border-top: 1px solid var(--line); padding: 10px 0; }}
  h2 {{ font-size: 17px; margin: 0 0 6px; }}
  .take {{ display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 4px 0; }}
  .take b {{ min-width: 150px; font-weight: 600; }}
  small, em {{ color: var(--muted); font-size: 12px; }}
  audio {{ height: 30px; width: 220px; max-width: 100%; }}
</style></head><body>
<h1>Name spellings</h1>
<p>Each name in the sentence "{html.escape(CARRIER.format('…'))}", voiced by {html.escape(args.model)}. "As written" is the name
untouched; the rest are sound-it-out spellings the voice reads instead. Each spelling has two takes,
since a model can say a word cleanly once and jumble it the next. "Said cleanly" checks the sentence came out whole
(1.00 is word for word), not that it sounds like you. "You" is your own take of the line the name is in.</p>
{"".join(sections)}
</body></html>
"""
    (OUT / "index.html").write_text(page)
    print(f"\nListen: open {OUT / 'index.html'}")


if __name__ == "__main__":
    main()

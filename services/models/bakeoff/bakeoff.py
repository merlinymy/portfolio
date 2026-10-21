"""Runs the voice bake-off and builds a page to listen to it (plan §6.3).

Each model runs in its own process (run.py) under /usr/bin/time, whose "peak memory footprint" is
the most memory the model's process held at once, the same figure Activity Monitor shows. Between
models the Mac rests for a while, because the MacBook Air has no fan and slows down when hot.

Writes, in knowledge/voice/bakeoff/ (private, ignored by git):
- results.md: speed and memory for each model.
- index.html: open it in a browser to hear each line from you and from every model, side by side.

Run: cd services/models && uv run bakeoff/bakeoff.py [model ...]
Without model names it runs every model in run.py's MODELS; `--report` only rebuilds the two files
from earlier runs.
"""

import html
import json
import re
import statistics
import subprocess
import sys
import time
from pathlib import Path

from common import OUT, YOU, lines
from run import MODELS

REST_SECONDS = 60
SHORT = 8  # words; the chat's first sentence is kept this short so it voices quickly (§7.10)
COLUMNS = ["Model", "Sounds like you", "Heard right", "Speed (RTF)", "Slowest sentence", "First sound", "Short sentence, whole", "Memory", "Load"]


def run(name: str) -> None:
    print(f"\n== {name}", flush=True)
    here = Path(__file__).parent
    result = subprocess.run(
        ["/usr/bin/time", "-l", sys.executable, str(here / "run.py"), name],
        stderr=subprocess.PIPE,
        text=True,
    )
    footprint = re.search(r"(\d+)\s+peak memory footprint", result.stderr)
    if result.returncode != 0 or not footprint:
        print(result.stderr[-3000:])
        raise SystemExit(f"{name} failed")
    path = OUT / name / "timings.json"
    data = json.loads(path.read_text())
    data["footprint_gb"] = round(int(footprint.group(1)) / 2**30, 2)
    path.write_text(json.dumps(data, indent=1) + "\n")


def heard(folder: Path) -> dict[str, float]:
    """Each line's letter-by-letter match with the script, from heard.py, if it has run."""
    path = folder / "heard.json"
    return {k: v["match"] for k, v in json.loads(path.read_text()).items()} if path.exists() else {}


def similar() -> dict[str, float]:
    """Each voice's similarity to yours, from similar.py, if it has run."""
    path = OUT / "similar.json"
    return json.loads(path.read_text()) if path.exists() else {}


def summary(name: str) -> list[str] | None:
    """One results row for a model, as the cells of COLUMNS."""
    path = OUT / name / "timings.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    s = data["sentences"]
    short = [x["seconds"] for x in s if x["words"] <= SHORT]
    memory = data.get("footprint_gb")
    scores = heard(OUT / name)
    like = similar().get(name)
    return [
        name,
        f"{like:.2f}" if like is not None else "–",
        f"{statistics.median(scores.values()):.2f}" if scores else "–",
        f"{sum(x['seconds'] for x in s) / sum(x['audio'] for x in s):.2f}",
        f"{max(x['seconds'] / x['audio'] for x in s):.2f}",
        f"{statistics.median(x['first'] for x in s):.1f} s",
        f"{statistics.median(short):.1f} s" if short else "–",
        f"{memory:.1f} GB" if memory else "–",
        f"{data['load_s']:.0f} s",
    ]


NOTES = """
- **Sounds like you:** an estimate from a voiceprint model (similar.py); 1.00 is identical. It
  scores everyone fairly high, so compare with the baselines: you against yourself score {self},
  and a stranger (the Mac's built-in voices) {stranger}. Your ears decide.
- **Heard right:** how closely Parakeet's transcript of the model matches the script, letter by
  letter, for a typical line (1.00 means every letter as written). Your own takes score {you}, the
  ceiling, since Parakeet mishears some names even from you. Run heard.py to fill it in.
- **Speed (RTF):** seconds of computing per second of speech, over every sentence. Under 1 means
  the voice keeps ahead of playback.
- **Slowest sentence:** the worst RTF of any one sentence. Above 1, playback of that sentence
  would stall unless it starts late.
- **First sound:** typical seconds from asking for a sentence to its first piece of audio.
- **Short sentence, whole:** typical seconds to voice all of a sentence of {short} words or fewer,
  which is what the chat needs before it can align the lips to it (§6.1).
- **Memory:** the most memory the model's process held at once.
- **Load:** seconds to load the model and voice one warm-up sentence; the server does this once.

Measured on the MacBook Air (M4, 24 GB, no fan). Re-measure speeds on the Mac mini before deciding
on speed (§6.3).
"""

STYLE = """
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #666; --line: #ddd; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151515; --fg: #eee; --muted: #999; --line: #333; } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  table { border-collapse: collapse; margin: 12px 0 8px; display: block; overflow-x: auto; }
  td, th { border-bottom: 1px solid var(--line); padding: 6px 12px 6px 0; text-align: left; white-space: nowrap; }
  section { border-top: 1px solid var(--line); padding: 12px 0; }
  h2 { font-size: 13px; color: var(--muted); margin: 0; }
  p { margin: 4px 0 8px; }
  .takes { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 6px 16px; }
  .take { display: flex; align-items: center; gap: 8px; }
  .take span { width: 120px; flex: none; font-size: 13px; }
  audio { height: 32px; flex: 1; min-width: 0; }
  .muted, small { color: var(--muted); font-size: 12px; }
"""


def report() -> None:
    rows = [r for r in (summary(n) for n in MODELS) if r]
    table = ["| " + " | ".join(COLUMNS) + " |", "|" + "---|" * len(COLUMNS)] + ["| " + " | ".join(r) + " |" for r in rows]
    you = heard(YOU)
    you_typical = f"{statistics.median(you.values()):.2f}" if you else "(not checked yet)"
    listen_first = []
    for name in MODELS:
        low = [k for k, v in heard(OUT / name).items() if v < you.get(k, 1.0) - 0.08]
        if low:
            listen_first.append(f"- **{name}:** {', '.join(low)}")
    extra = "\n## Lines to listen to first\n\nWell below your own take's score, so a word may be skipped, repeated or garbled:\n\n" + "\n".join(listen_first) + "\n" if listen_first else ""
    like = similar()
    strangers = [v for k, v in like.items() if k.startswith("stranger")]
    notes = NOTES.format(
        you=you_typical,
        short=SHORT,
        self=f"{like['you']:.2f}" if "you" in like else "(not checked yet)",
        stranger="–".join(f"{v:.2f}" for v in sorted(strangers)) if strangers else "(not checked yet)",
    )
    (OUT / "results.md").write_text("# Voice bake-off\n\n" + "\n".join(table) + "\n" + notes + extra)
    print("\n".join(table))

    head = "".join(f"<th>{html.escape(c)}</th>" for c in COLUMNS)
    body = "".join("<tr>" + "".join(f"<td>{html.escape(c)}</td>" for c in r) + "</tr>" for r in rows)
    sections = []
    for line, text in lines():
        takes = []
        for who, folder in [("You", YOU)] + [(n, OUT / n) for n in MODELS]:
            path = folder / f"{line}.wav"
            if path.exists():
                src = html.escape(str(path.relative_to(OUT)))
                score = heard(folder).get(line)
                label = html.escape(who) + (f' <small title="heard right">{score:.2f}</small>' if score is not None else "")
                takes.append(f'<div class="take"><span>{label}</span><audio controls preload="none" src="{src}"></audio></div>')
        sections.append(f'<section><h2>{line}</h2><p>{html.escape(text)}</p><div class="takes">{"".join(takes)}</div></section>')
    self_score = f"{like['you']:.2f}" if "you" in like else "–"
    stranger_score = "–".join(f"{v:.2f}" for v in sorted(strangers)) if strangers else "–"
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice bake-off</title><style>{STYLE}</style></head><body>
<h1>Voice bake-off</h1>
<p>For each line: does it sound like you? "You" is your own recording of the same words. "Sounds like you" in the table is an estimate from a voiceprint model, where you against yourself score {self_score} and a stranger {stranger_score}; your ears decide.</p>
<table><tr>{head}</tr>{body}</table>
<p class="muted">RTF is seconds of computing per second of speech; under 1 keeps ahead of playback. The small number by each take is how closely a transcript of it matches the script (1.00 is word for word; yours is the ceiling). Measured on the MacBook Air; the column notes are in results.md.</p>
{"".join(sections)}
</body></html>
"""
    (OUT / "index.html").write_text(page)
    print(f"\nListen: open {OUT / 'index.html'}")


def main() -> None:
    args = sys.argv[1:]
    if args != ["--report"]:
        names = args or list(MODELS)
        for i, name in enumerate(names):
            if i:
                print(f"(resting {REST_SECONDS} s so the Air cools down)", flush=True)
                time.sleep(REST_SECONDS)
            run(name)
    report()


if __name__ == "__main__":
    main()

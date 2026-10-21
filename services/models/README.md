# Voice models (phase 3)

These run natively on the Mac, outside Docker, because Docker on a Mac can't use the graphics chip
(plan §3.2). They are:
- **Text-to-speech in your cloned voice.** The model copies your voice from a short recording of
  you.
- **The forced aligner.** Given a sentence and its audio, it finds when each word is spoken.
- **Speech-to-text (Parakeet).** It turns speech into text with word times.

Everything they read or make is your voice, so it stays in `knowledge/voice/`, which git ignores.
Only the scripts are committed.

## Setup

```sh
cd services/models
uv sync --extra pocket   # Python 3.12 environment in .venv; --extra pocket adds Pocket-TTS (PyTorch)
```

The models download from Hugging Face the first time each one is used, into
`~/.cache/huggingface` (about 10 GB for the whole bake-off).

**Pocket-TTS needs a Hugging Face login.** Its voice-cloning weights are gated: you accept Kyutai's
terms on the model page while logged in, then sign in on the Mac. Without that, Pocket-TTS fails to
load and the other models still run.
1. Accept the terms at https://huggingface.co/kyutai/pocket-tts.
2. Run `.venv/bin/hf auth login` with a read token.

## The voice bake-off (plan §6.3)

The bake-off compares voice models on your own recordings:

```sh
uv run bakeoff/prepare.py   # your reference clip, trimmed, with an exact transcript
uv run bakeoff/takes.py     # your own takes of the scripted lines, to compare against
uv run bakeoff/bakeoff.py   # every model voices the same lines; about 25 minutes
uv run bakeoff/heard.py     # checks each take says the words right
uv run bakeoff/similar.py   # estimates how much each model sounds like you, then:
uv run bakeoff/bakeoff.py --report
open ../../knowledge/voice/bakeoff/index.html
```

The voices are listed in `MODELS` in `bakeoff/run.py`. Two options make variants of a voice:
- `whole` voices each line in one go, instead of sentence by sentence.
- `reference` copies the voice from your own take of a line, instead of `sample.m4a`.

- **`prepare.py`** turns `sample.m4a` into the reference clip the models copy from. Parakeet
  transcribes it, because the models copy best when the transcript matches the recording word for
  word.
- **`takes.py`** cuts your last full take of each Part 3 and Part 4 paragraph out of
  `answers.m4a` and `words.m4a`. It matches what Parakeet heard to the script letter by letter, so
  a misheard name doesn't break the match. It prints how closely each take matches the script.
- **`bakeoff.py`** runs each model in its own process, so each model's memory is measured on its
  own, and rests 60 s between models because the MacBook Air has no fan and slows down when hot.
  `bakeoff.py qwen-0.6b` runs one model; `bakeoff.py --report` rebuilds the results from earlier
  runs.
- **`heard.py`** checks whether each model said the words right. Parakeet transcribes every take,
  including yours, and compares it with the script letter by letter. Your takes are the ceiling,
  since Parakeet mishears some names even from you. A model's line well below yours usually has a
  skipped, repeated or garbled word, and `results.md` lists those lines to listen to first.
- **`similar.py`** estimates how much each model sounds like you. A voiceprint model (Microsoft's
  WavLM speaker-verification model) compares each model's voice with yours. For scale, it also
  scores the Mac's built-in voices reading the same lines as a stranger, and your own takes against
  each other as the ceiling.
- **`index.html`** plays each line from you and from every model side by side. `results.md` has
  the speed and memory table.

What the numbers mean:
- **RTF (real-time factor):** seconds of computing per second of speech. Under 1, the voice keeps
  ahead of playback.
- **First sound:** seconds until a sentence's first piece of audio arrives.
- **Memory:** the most memory the model's process held at once, as Activity Monitor shows it.

The MLX library keeps freed graphics memory for reuse, with no limit by default. That made a 0.6B
model hold 18 GB, so the scripts cap that cache at 1 GB.

Each model runs in its faster mode:
- **Qwen3-TTS streams,** handing over audio in pieces as it goes. Without streaming, it decodes the
  whole 20 s reference clip again for every sentence, which adds about 3 s.
- **Chatterbox voices each sentence in one piece.** Streaming reruns its audio decoder for every
  piece, which makes it about 1.5 times slower.

## Speaking a sentence with lip timing (plan §6.1)

```sh
uv run speak.py "I'm authorized to work in the U.S."
```

This writes a `.wav` and a `.json` to `knowledge/voice/speak/`. The `.json` holds:
- the on-screen words, each with its start and end time, for revealing the text in step;
- the mouth shapes, as `[seconds, shape]` pairs, using the face's 15 shapes from `visemes.json`.

How it gets the shapes:
1. Names in `pronunciations.json` are swapped for sound-it-out spellings ("pgvector" → "P G
   vector"), for the voice only. The words on screen keep the real spelling.
2. The voice model speaks the sentence.
3. The forced aligner times each word.
4. The CMU Pronouncing Dictionary splits each word into its speech sounds. It's downloaded once to
   `~/.cache/portfolio-models`. Words it lacks are sounded out letter by letter, which is close
   enough for the lips.

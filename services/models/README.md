# Voice models (phase 3)

These run natively on the Mac, outside Docker, because Docker on a Mac can't use the graphics chip
(plan §3.2):
- **Your cloned voice: Pocket-TTS with sound-it-out spellings** ("pocket-respelled", chosen in the
  bake-off below). It copies your voice from a short recording of you, and runs on the CPU.
- **The forced aligner.** Given a sentence and its audio, it finds when each word is spoken, for
  the lips.

The model server (`server.py`) keeps both loaded and turns a sentence into audio plus lip timing
for the chat backend. Visitors only type, so nothing here listens to visitors (plan §7.9).

Everything they read or make is your voice, so it stays in `knowledge/voice/`, which git ignores.
Only the scripts are committed.

| File | What it is |
|---|---|
| `voices.py` | The voice: Pocket-TTS, your reference recording, and the sound-it-out spellings |
| `speak.py` | One sentence to audio plus word timing and mouth shapes; run it by hand to try a sentence |
| `server.py` | The model server the chat backend calls |
| `launchd/` | Keeps the server running on the Mac that serves the site |
| `pronunciations.json` | The sound-it-out spellings for names |
| `bakeoff/` | The voice bake-off and its checks |
| `tests/` | Tests for the parts that don't need the models (`uv run pytest`) |

## Setup

```sh
cd services/models
uv sync   # Python 3.12 environment in .venv
```

The models download from Hugging Face the first time each one is used, into
`~/.cache/huggingface`: about 1.5 GB for the voice and the aligner. To remove one, use
`.venv/bin/hf cache rm <model>`. Deleting its folder isn't enough, because the files sit in a
shared store.

**Pocket-TTS needs a Hugging Face login.** Its voice-cloning weights are gated: you accept Kyutai's
terms on the model page while logged in, then sign in on the Mac.
1. Accept the terms at https://huggingface.co/kyutai/pocket-tts.
2. Run `.venv/bin/hf auth login` with a read token.

## The model server (plan §3.2)

```sh
uv run server.py          # answers on http://127.0.0.1:8790, on this Mac only
```

- **`GET /health`** answers `{"ok": true, ...}` once the models are loaded, about 5 s after
  starting. Until then it answers 503 with `"loading": true`. If the models fail to load, the
  server exits, so `launchd` starts it again.
- **`POST /speak`** with `{"text": "One sentence."}` answers with the result described under
  "Speaking a sentence" below, plus `"audio"`: the WAV file (mono, 24 kHz) in base64.
  - It refuses empty text and text over 600 characters. The chat backend sends a reply one
    sentence at a time.
  - `words` and `visemes` are `null` if the aligner fails on a sentence. The browser then times the
    lips from the playing audio instead (plan §6.2).
- **`POST /embed`** with `{"texts": [...], "kind": "passage"}` (or `"query"` for a visitor's
  question) answers `{"model", "dims", "vectors"}`: 1,024 numbers per text, in order, for the chat's
  search ([docs/phase-4-knowledge-plan.md](../../docs/phase-4-knowledge-plan.md)). The model is
  Qwen3-Embedding-0.6B, on the graphics chip (`embed.py`). Questions get a one-line instruction
  first, which is how that model is meant to be used. It takes up to 256 texts of up to 8,000
  characters each; the whole profile (60 passages) embeds in about 3 s.
- **One sentence at a time.** Each takes about 0.3–0.7 s on the MacBook Air, and the server holds
  about 4.7 GB of memory in all, measured 2026-10-21: the embedding model is about 1.6 GB of that,
  and the voice, the aligner and the aligner's cache (capped at 1 GB) the rest.
- **Only this Mac can reach it.** It answers on 127.0.0.1, where the chat backend reaches it from
  Docker as `host.docker.internal`. Nothing outside the Mac can, and the Cloudflare tunnel leads
  only to the chat backend.

**Keeping it running** on the Mac that serves the site:

```sh
uv run speak.py "Hello."                  # once, so the models are downloaded
sh launchd/install.sh                     # start at login, and again whenever it stops
sh launchd/install.sh --remove            # stop it and remove it
```

`launchd` is macOS's service manager. The agent starts the server offline, so the models must
already be downloaded. Its log is `~/Library/Logs/merlinyang-models.log`. Tested on the MacBook Air:
it started the server and restarted it about 9 s after the server was killed.

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

The voices are listed in `MODELS` in `bakeoff/run.py`. Options make variants of a voice:
- `whole` voices each line in one go, instead of sentence by sentence.
- `reference` copies the voice from your own take of a line, instead of `sample.m4a`.
- `respell` says names by their sound-it-out spellings from `pronunciations.json`.
- `language` picks one of Kyutai's Pocket-TTS models, such as their larger
  `english_2026-09_24l`.

The bake-off's checks use Parakeet, a speech-to-text model (2.5 GB, downloaded on first use).
The other voices it compared were deleted after the choice; `bakeoff/run.py` still lists them, so
any can be downloaded again.

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

## Sound-it-out spellings for names (plan §6.1)

Voice models guess unfamiliar words from their spelling, so tech names come out jumbled or get
dropped. For example, Pocket-TTS read the full stop in "three.js" as the end of the sentence and
skipped the rest of the line. `pronunciations.json` lists spellings the voice reads instead, such as
"three J S". It's used by `speak.py` and by bake-off voices with the `respell` option. The words
on screen keep the real spelling.

```sh
uv run bakeoff/words.py     # tries each spelling in pronunciation-candidates.json
open ../../knowledge/voice/words/index.html
```

The page plays, for each name:
- your own take of the line it's in;
- the name as written;
- each spelling to try, with two takes each, because a model can say a word cleanly once and
  jumble it the next time.

"Said cleanly" checks that the sentence came out whole. Whether a spelling sounds the way you say
the name is your call. Put the spelling you choose in `pronunciations.json`.

## Speaking a sentence with lip timing (plan §6.1)

```sh
uv run speak.py "I'm authorized to work in the U.S."
```

This writes a `.wav` and a `.json` to `knowledge/voice/speak/`, the same result the server
returns. The `.json` holds:
- `text` (as shown on screen) and `spoken` (what the voice was asked to say);
- `duration`, in seconds;
- `words`: the on-screen words, each with its start and end time, for revealing the text in step;
- `visemes`: the mouth shapes, as `[seconds, shape]` pairs, using the face's 15 shapes from
  `visemes.json`. Each shape holds until the next; `sil` is the closed, resting mouth;
- `timing`: seconds spent voicing and aligning.

How it gets the shapes:
1. Names in `pronunciations.json` are swapped for their sound-it-out spellings ("pgvector" → "P G
   vector"), for the voice only. A change to that file takes effect on the next sentence, without
   restarting the server.
2. The voice speaks the sentence. The same sentence always comes out the same way.
3. The forced aligner times each word.
4. The CMU Pronouncing Dictionary splits each word into its speech sounds. It's downloaded once to
   `~/.cache/portfolio-models`. Letters spelled out in a respelling are said by name, and words the
   dictionary lacks are sounded out letter by letter, which is close enough for the lips.

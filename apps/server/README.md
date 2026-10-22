# apps/server

The chat backend (plan §7, [docs/phase-5-chat-plan.md](../../docs/phase-5-chat-plan.md)): the api
that takes a visitor's message, checks it, answers it in your voice and saves the transcript, and
its search of your profile (phase 4, [docs/phase-4-knowledge-plan.md](../../docs/phase-4-knowledge-plan.md)).

## Running it

From the repo root, once:

```sh
cp .env.example .env      # then fill in the secrets it describes, and ANTHROPIC_API_KEY
```

Each time:

```sh
npm run db                # Postgres in Docker; needs Docker Desktop running
npm run voice             # the model server: your voice, lip timing, and the search's embedding model
npm run ingest            # load the passages (after any edit to content/ or knowledge/extra/)
npm run api               # the api, at http://127.0.0.1:8791
```

The database, the model server and the api answer on this Mac only (127.0.0.1). Every `/api`
request needs the `x-origin-secret` header from `.env`, which the Cloudflare Worker adds
([worker/README.md](../../worker/README.md)); without it the api answers 403 and nothing else.
To run the api in Docker instead: `docker compose --profile api up -d --build`.

**Without `ANTHROPIC_API_KEY`** the api still starts, and `/api/health` says `"claude": false`.
Replies that need no AI still work (disguised text gets its strike, other languages the
English-only reply, limits their fixed replies, handoffs are saved), and every other message gets
the fixed apology.

**Emails** (handoffs, and the spending-cap warning) go through Resend once `RESEND_API_KEY` and
`HANDOFF_TO` are set. Until then each is saved as a text file in `knowledge/outbox/`.

## The chat

`POST /api/chat` takes `{message, jobPost?, conversationId?}` and answers with a stream of
server-sent events (one-way messages over a plain HTTP response), typed in
`packages/shared/src/chat.ts`: `meta`, `state`, a `sentence` at a time with your voice and its lip
timing, then `done`, plus `strike` and `handoff` when they apply. A message goes through:

1. **The gate** (`src/chat/gate.ts`), plain code: the browser's cookie, its lock, message lengths,
   rate limits and the month's spending. A refusal here costs nothing.
2. **The pre-filter** (`src/chat/prefilter.ts`), plain code: disguised text (Base64, hex, reversed,
   leetspeak) is a strike, and other languages get the English-only reply, with no AI call.
3. **The strike check** (`src/chat/strikeCheck.ts`, Claude Haiku 5.5): what kind of message it is.
4. **The policy** (`src/chat/policy.ts`), plain code: what to do about it. A strike, a refusal, one of
   your approved answers word for word, approved small talk, the handoff, or a generated answer.
5. **A generated answer:** search finds the 6 best passages, Claude Sonnet 5.5 writes the answer
   (`src/chat/answer.ts`), and a second check (`src/chat/outputCheck.ts`, Haiku) reads only the
   finished answer. If it finds a commitment, a negative remark, a claim your profile doesn't
   support, or anything off-policy, the reply becomes the handoff offer instead.
6. **Your voice** (`src/chat/voice.ts`): sentence by sentence through the model server, each sent as
   soon as it's ready. At most 3 replies are voiced at once. The fixed replies' audio is kept in
   `knowledge/cache/voice/`, so they play at once after the first time.
7. **The transcript:** both messages, what was decided and why, the passages used, the cost and each
   stage's time, in Postgres. Transcripts are deleted after 12 months.

The instructions for the three Claude calls, and the handoff email's summary, are private, in
`knowledge/prompts/` (the format: `knowledge.example/prompts/README.md`). The api reads them on the
first message that needs them; restart it after editing one. The fixed reply texts (strikes,
refusals, limits) are in `src/chat/replies.ts`.

**The question buttons:** `GET /api/instant` lists them, and `POST /api/instant` `{id}` plays one as
the same stream of events as a chat reply, from audio voiced ahead of time: no AI call, no search,
and no limits but the flood limit. Repeat clicks play the next approved wording. The buttons and
their wordings are private, in `knowledge/buttons.yaml`; `npm run buttons -- review` voices them all
and writes a page to listen to them on, and only versions marked `approved: true` are ever played.

**The other routes:** `GET /api/health`, `POST`/`GET /api/visitor` (the cookie, after a Cloudflare
Turnstile check), `POST /api/handoff` (the form that emails you).

## Commands

| Command | What it does |
|---|---|
| `npm run strikes -- list [visitorId]` | Strikes, newest first, with the reason and the message |
| `npm run strikes -- revoke <strikeId>` | Undoes a strike given by mistake, and unlocks the browser if that takes it under 3 |
| `npm run strikes -- unlock <visitorId>` | Clears a browser's strikes and lock |
| `npm run transcripts -- recent [n]` | The latest conversations |
| `npm run transcripts -- show <conversationId>` | One conversation, message by message, with what was decided |
| `npm run transcripts -- purge` | Deletes conversations and handoffs over 12 months old (the api also does this daily) |
| `npm run speed` | Each stage's typical and slow (1 in 20) time over recent messages |
| `npm run buttons -- review` | Voices every wording of the question buttons and writes the listening page, `knowledge/voice/buttons/index.html` |
| `npm run buttons -- voice` | Voices only the approved wordings, so clicks play at once |
| `npm run redteam` | The red-team test (below) |

## The red team

`npm run redteam` sends the private red-team set (`knowledge/redteam/`: about 160 attacks and 115
genuine recruiter questions) through the real chat, without voicing, in a database of its own that
it deletes afterwards, so its messages never mix with real transcripts or count toward the monthly
spending cap. Targets: at most 1 false strike on the genuine questions, and at least 95% of attack
messages getting the action they should. The report goes to `knowledge/redteam/results/`. It needs
`ANTHROPIC_API_KEY` and costs a few dollars per full run; `-- --only <id>` runs a few cases.

## What's searched

Only the public `content/` folder, plus any private notes in `knowledge/extra/*.md` (none yet).
`profile/` is never loaded. Your fixed answers and small talk (`knowledge/answers.yaml`,
`knowledge/smalltalk.yaml`) aren't searched either: in phase 5 the strike check picks one and the
chat says it word for word.

**Passages** (`src/rag/passages.ts`): short pieces that each answer one thing, and each say what
they're about, so they make sense on their own:

| From | Passages |
|---|---|
| `about.md` | Facts (location, work authorization, contact), education, the summary, one per paragraph of your story |
| `experience/*.md` | A summary when the file has an `about` line, and one per bullet, each starting "Role at Company, dates:" |
| `projects/*.md` | What it is, what it's built with, and one per bullet, each starting "Name, project, dates:" |
| `skills.yaml`, `earlier-projects.yaml` | One per skill group, one per earlier project |
| `instant.yaml` | One per question with its answer |
| `knowledge/extra/*.md` | One per heading |

**Search** (`src/rag/search.ts`) ranks the passages twice and merges the two lists:

- **By meaning:** the embedding model (Qwen3-Embedding-0.6B, on the model server) turns the question
  and every passage into 1,024 numbers; the closest passages rank first.
- **By keyword:** passages containing the question's words, with rare words like "Qdrant" counting
  far more than common ones. Words that only frame a question ("tell me about a time") are ignored.
- **Merged** by reciprocal rank fusion: each passage scores by its rank in each list, so one near the
  top of both wins. The chat is given the top 6.

## Tests

- `npm test -w @portfolio/server`: everything that doesn't need Claude or the model server: the
  gate, strikes and locks, the cookie, the pre-filter, the policy, cleaning replies, the Claude
  calls against a stand-in, the pipeline end to end, the routes, and cutting passages. Tests that
  need a database make a throwaway one and delete it.
- `npm run test:search`: the real search, against `test/search-questions.yaml`. A question passes
  when one of its expected passages is in the top 6. On 2026-10-21: 39 of 39 found, 29 of them first.
- `npm run check -w @portfolio/server`: type-checks.

## Layout

```
src/main.ts               starts the api; src/wiring.ts puts the real parts together
src/app.ts                the routes, the secret-header check, the cookie, the event stream
src/identity.ts           signed cookies, hashed IP addresses, the Turnstile check
src/mail.ts               emails through Resend, or into knowledge/outbox/
src/chat/                 the pipeline (pipeline.ts) and each of its stages; types.ts holds the contracts
src/db/                   the connection, migrations, and the chat's queries (chat.ts)
src/rag/                  passages, embeddings, hybrid search
src/scripts/              ingest, search, test:search, strikes, transcripts, speed, redteam
test/                     unit tests, their helpers, and the search test's questions
```

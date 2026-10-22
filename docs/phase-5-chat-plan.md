# Phase 5: the chat backend

Status: **built 2026-10-21 on the MacBook Air; the red-team run waits for `ANTHROPIC_API_KEY`.** What was built and checked is at the end. Part of [remake-1-face-scan-plan.md](remake-1-face-scan-plan.md)
(§7, and §10 phase 5). Everything here follows §7 of that plan; this file adds the decisions made
for the build and the contracts between the parts.

**Done when:** the red-team set meets its targets (at most 1 false strike in the 100 genuine
questions; at least 95% of attacks caught), and a reply streams through the Cloudflare Worker.

## Your decisions (2026-10-21)

- **Testing by hand waits for phase 6's chat box.** This phase ends with the backend running on
  this Mac and the red-team test passing.
- **This Mac only.** The Cloudflare Worker that forwards `/api` is written and tested here with
  `wrangler dev`, streaming included. The tunnel and the public route come with the Mac mini.
- **Email later.** Until `RESEND_API_KEY` is set, each handoff or spending-cap email is saved as a
  file in `knowledge/outbox/` (private) and noted in the api's log.
- **The red team runs in full** (about 250 messages, roughly $2–4 of Claude credit per run, an
  estimate), once or twice while tuning the instructions.
- **Needed from you:** `ANTHROPIC_API_KEY` in `.env`.

## How a message is handled

`POST /api/chat` answers with server-sent events (SSE: a one-way stream of events over plain
HTTP), typed in `packages/shared/src/chat.ts`: `meta`, `state`, then `sentence`s (and `strike`
and `handoff` when they apply), then `done`. A comment line every 15 s keeps idle streams open.

1. **Gate** (code, no AI), in this order. Each failure is a fixed reply from `replies.ts`
   (`kind: "gate"`), saved to the transcript, with no AI call:
   1. The secret header (`x-origin-secret` equals `ORIGIN_SECRET`; checked for every `/api` route,
      403 without a body otherwise).
   2. A valid visitor cookie (401 `{ "error": "no visitor" }` without one; the page then calls
      `POST /api/visitor`).
   3. Not locked. A lock that has run out resets the strikes to 0 and unlocks, in one update.
   4. Lengths: message 1–1,000 characters, job posting up to 6,000.
   5. Rate limits: 10 messages per 5 minutes and 60 per day per browser; 30 per 10 minutes per IP.
   6. The month's spending under `SPEND_CAP_USD`. Crossing it pauses the chat and emails you, once
      a month (`spend_alerts`).
2. **Pre-filter** (`prefilter.ts`, code): disguised text is a strike (category `disguised`) with no
   AI call; non-English gets `ENGLISH_ONLY` with no strike; links and gibberish are hints for the
   strike check.
3. **Strike check** (`strikeCheck.ts`, Claude Haiku 5.5, structured output): returns a
   `StrikeVerdict`. It sees the last 10 turns, the running risk note, the message, the job posting
   marked as information only, the pre-filter's hints, and the list of approved answers it may pick.
4. **Policy** (`policy.ts`, code): category → action, the table below. "Strike on repeat" means a
   strike if the same category was already refused in this conversation.
5. **Strike**, if any: one transaction inserts the strike and increments the browser's count; the
   third sets `locked_until` 30 days out. The reply is `strike(strikesLeft)`, plus a `strike` event
   and a `handoff` event.
6. **Answer:**
   - `fixed`: the approved answer word for word (`fixed.ts`), for answers.yaml ids, typed instant
     questions and follow-ups.
   - `small_talk`: the approved line, while the conversation has had fewer than 2; after that, the
     `afterLimit` line and a `handoff` event. No strike either way.
   - `handoff`: `HANDOFF` and a `handoff` event.
   - `answer`: search (the 6 best passages), then Claude Sonnet 5.5 writes the answer
     (`answer.ts`), then the output check.
7. **Output check** (`outputCheck.ts`, Claude Haiku 5.5, structured output), on generated answers
   only: if it reports any problem, the reply becomes `HANDOFF` with a `handoff` event.
8. **Clean** (`clean.ts`): Markdown and HTML stripped; only links to your own sites survive.
9. **Voice** (`voice.ts`): split into sentences; each goes to the model server's `POST /speak` in
   order and streams as soon as it's voiced. At most 3 replies are voiced at once; others wait,
   with the face thinking. Fixed texts' audio is cached on disk (`knowledge/cache/voice/`, keyed by
   the text), so approved answers play at once after the first time.
10. **Save**: both messages, the category, action, reason, passages used, tokens, cost and each
    stage's time (`timings`: gate, prefilter, strike_check, search, answer, output_check,
    first_audio, total, in ms).

**Policy table** (plan §7.3):

| Category | Action |
|---|---|
| career, fabrication_bait | answer (the answer instructions correct a false premise) |
| fixed | fixed |
| small_talk | small_talk |
| handoff | handoff |
| abuse, rule_breaking, free_chatbot, personal, speak_for_me, spam, disguised, impersonation, plant_links | strike |
| private_details | refuse with `REFUSE.private_details` (the handoff offer, plus a `handoff` event); strike on repeat |
| badmouthing | refuse with `REFUSE.badmouthing`; strike on repeat |
| self_sabotage | refuse with `REFUSE.self_sabotage`; strike on repeat |
| distress | distress (`DISTRESS`), no strike |
| other_language | english_only, no strike |

## Claude calls

| Call | Model | Settings |
|---|---|---|
| Strike check | `claude-haiku-5-5` | `thinking: {type: "disabled"}`, `output_config.effort: "low"`, structured output (`messages.parse` with `zodOutputFormat`) |
| Answer | `claude-sonnet-5-5` | `thinking: {type: "between_tools"}` (Sonnet 5.5's way to turn thinking off), effort `"medium"`, `max_tokens` 600, about 120 words |
| Output check | `claude-haiku-5-5` | as the strike check |
| Handoff summary | `claude-haiku-5-5` | thinking disabled, two lines of plain text |

- **Instructions** are private, in `knowledge/prompts/` (`strike-check.md`, `answer.md`,
  `output-check.md`, `handoff-summary.md`), loaded by `prompts.ts`. Publishing them would show
  attackers exactly what to get around. `knowledge.example/prompts/` explains the format only.
- **Prompt caching:** each call's fixed part (its instructions and, for the strike check, the list
  of approved answers) comes first and is cached; the parts that change come after.
- **Costs** come from each response's `usage` and these prices per million tokens (from the bundled
  Claude API reference, 2026-10-21): Sonnet 5.5 $2 in, $10 out, $0.20 cache read, $2.50 cache write;
  Haiku 5.5 $0.10 in, $0.50 out, cache read and write at 0.1× and 1.25× the input price.
- **Failures:** an API error or refusal in any call ends the reply with `ERROR` (`kind: "error"`),
  never with a partial or unchecked answer. A strike check that fails never strikes.

## The other routes

| Route | What it does |
|---|---|
| `GET /api/health` | 200 `{ok: true, db, models}` when Postgres answers and the model server's `/health` is ok; 503 otherwise. The page sleeps the face on 503 or no answer in 4 s (§7.8). |
| `POST /api/visitor` | Body `{turnstileToken}`. Checks the token with Cloudflare, creates a browser (at most 5 new per IP per hour), and sets the cookie. Answers `VisitorStatus`. |
| `GET /api/visitor` | The cookie's `VisitorStatus`, or 401. |
| `POST /api/handoff` | Body `HandoffRequest`. Turnstile, at most 2 per browser per day, field checks; writes the row, then emails you their details, a two-line summary of the conversation (Haiku) and the full transcript. 200 `{ok: true}`. |
| `POST /api/instant` | Body `InstantClick`; logs a chip click. 204. |

**The visitor cookie:** `mv=<visitor uuid>.<HMAC-SHA256 of it with COOKIE_SECRET, base64url>`,
`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api`, one year. IP addresses come from `x-real-ip`
(set by the Worker, trusted only alongside the secret header) or the socket in development, and
are stored only as HMAC-SHA256 with `IP_SALT`.

## Commands

| Command | What it does |
|---|---|
| `npm run api` | Starts the api on `127.0.0.1:8791` (needs `npm run db` and `npm run voice`). Runs pending migrations first, and purges transcripts over 12 months old at start and daily. |
| `npm run strikes -- list [visitorId]` / `revoke <strikeId>` / `unlock <visitorId>` | Strikes, for undoing a mistaken one (§7.2). |
| `npm run transcripts -- recent [n]` / `show <conversationId>` / `purge` | Reading transcripts, and deleting those over 12 months old (§7.6). |
| `npm run speed` | Each stage's typical (median) and slow (95th percentile) time over recent messages (§7.10). |
| `npm run redteam` | The red-team set (below). |

## The Worker and Docker

- **`worker/index.ts`** (Cloudflare Worker): `/api/*` is forwarded to `ORIGIN_URL` (the tunnel
  later; `http://127.0.0.1:8791` with `wrangler dev`) with `x-origin-secret` and `x-real-ip` (from
  `CF-Connecting-IP`) added and any incoming copies of those headers removed. The response body is
  passed through unbuffered, so SSE streams. Everything else is the static site, as now.
  `wrangler.jsonc` gets `main` and runs the Worker first only for `/api/*`. Local secrets go in
  `.dev.vars` (git-ignored).
- **Docker:** `apps/server/Dockerfile` and an `api` service in `docker-compose.yml`, on
  `127.0.0.1:8791`, reading `content/` and `knowledge/` from read-only mounts and reaching the model
  server at `host.docker.internal:8790`. During development `npm run api` runs it directly instead.
- **The site's dev server** proxies `/api` to `127.0.0.1:8791` and adds the secret header from
  `.env`, as the Worker will, so phase 6 can call it.

## The red team (plan §9)

- **The set** is private, in `knowledge/redteam/`: about 150 attacks across all 20 rows of §7.3,
  including multi-turn escalation scripts, and about 100 genuine recruiter questions. Each says
  what should happen (an action, or "not a strike").
- **`npm run redteam`** runs each case through the real pipeline without voicing, each script as
  one fresh browser, and reports false strikes, attacks caught, mistakes by row, and the cost. The
  report is saved in `knowledge/redteam/results/`.
- **Targets:** at most 1 false strike in the genuine questions; at least 95% of attacks get the
  action they should.

## Who builds what

Coding agents build the parts in parallel, each owning its files; `src/chat/types.ts`,
`replies.ts`, the migration `002_chat.sql` and the shared event types are fixed first, so the
parts fit together.

| Part | Files |
|---|---|
| Pure logic | `src/chat/prefilter.ts`, `policy.ts`, `clean.ts`, `fixed.ts`, and their tests |
| Claude calls | `src/chat/claude.ts` (client, prices, usage), `prompts.ts`, `strikeCheck.ts`, `answer.ts`, `outputCheck.ts`, `summary.ts`, and their tests |
| Server | `src/app.ts`, `src/main.ts`, `src/identity.ts`, `src/mail.ts`, `src/db/chat.ts`, `src/chat/gate.ts`, `voice.ts`, `pipeline.ts`, `src/routes/`, the commands, and their tests |
| Edges | `worker/`, `wrangler.jsonc`, the Dockerfile and compose service, the site's dev proxy |
| Instructions and the red team | `knowledge/prompts/`, `knowledge/redteam/`, `src/scripts/redteam.ts` |

## What was built and checked (2026-10-21)

- **Tests:** 312 pass without Claude or the model server (`npm test -w @portfolio/server`): the
  gate and every limit, strikes under concurrency and the 30-day lock, the cookie, the pre-filter
  (including about 40 real recruiter phrasings and tool names that must raise nothing), the policy
  table, cleaning replies and links, loading your answers, the four Claude calls against a
  stand-in, the pipeline end to end, and the routes.
- **On this Mac, against the real database:** `npm run api` added the chat's tables, refused a
  request without the secret header (403), created a browser, and streamed a reply in your voice
  with lip timing. Base64-hidden instructions got a strike and the handoff offer without any AI
  call; a Spanish question got the English-only reply. The test browser was deleted afterwards.
- **The Worker:** three events sent a second apart arrived a second apart through `wrangler dev`;
  a visitor's fake secret header and IP address were replaced; with no tunnel configured, `/api`
  answers 503 offline and the site still serves.
- **Docker:** the api's image builds without `.env`, `knowledge/` or `profile/` in it, and ran
  against a throwaway Postgres.
- **Not yet checked:** anything with real Claude calls (no API key yet), so the red-team targets
  aren't measured; real emails through Resend; the real Cloudflare edge and tunnel.
- **Changes from the plan:**
  - The red-team set came out larger than planned (about 360 messages), so a full run likely costs
    more than the $2–4 estimated.
  - A browser may have one message in flight at a time; a second gets the "too fast" reply, so a
    burst can't slip past the rate limits.
  - The stream may end with `done` and no `meta` if the database fails before the reply starts.
  - All packages share one zod (4.6.5), set with an npm override, so the Claude SDK and the api
    agree on it.

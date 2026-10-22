# apps/server

The chat backend (plan §7). So far, its search (phase 4, [docs/phase-4-knowledge-plan.md](../../docs/phase-4-knowledge-plan.md)):
your profile cut into passages, stored in Postgres, and searched by meaning and by keyword. The
chat pipeline itself (strike check, answers, voice) comes in phase 5.

## Running it

From the repo root, once:

```sh
cp .env.example .env      # then set POSTGRES_PASSWORD to a long random string
```

Each time:

```sh
npm run db                # Postgres in Docker; needs Docker Desktop running
npm run voice             # the model server; the search needs its embedding model
npm run ingest            # load the passages (after any edit to content/ or knowledge/extra/)
npm run search -- "Have you used Qdrant?"
npm run test:search       # every test question should find its passage
```

`npm run ingest -- --dry` prints the passages without needing the database or the model server.

The database and the model server answer on this Mac only (127.0.0.1). The database's data stays
in a Docker volume when it's stopped (`docker compose down`).

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

- `npm test -w @portfolio/server`: cutting passages and merging rankings, without the database.
- `npm run test:search`: the real search, against `test/search-questions.yaml`. A question passes
  when one of its expected passages is in the top 6. On 2026-10-21: 39 of 39 found, 29 of them first.
- `npm run check -w @portfolio/server`: type-checks.

## Layout

```
src/env.ts                .env settings
src/db/client.ts          the Postgres connection
src/db/migrate.ts         runs src/db/migrations/*.sql in order, once each
src/rag/passages.ts       content/ -> passages
src/rag/embed.ts          the model server's /embed
src/rag/search.ts         hybrid search
src/scripts/              npm run ingest, search, test:search
test/                     unit tests and the search test's questions
```

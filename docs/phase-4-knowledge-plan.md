# Phase 4: private knowledge and search

Status: **done on the MacBook Air, 2026-10-21.** The results are at the end. Part of [remake-1-face-scan-plan.md](remake-1-face-scan-plan.md)
(§7.4 and §10, phase 4).

**Done when:** your test questions find the passage that answers them.

## Your decisions (2026-10-21)

- **What's searched, at first:** only the public `content/` folder (About, the two jobs, five
  projects, skills, earlier projects, the six instant answers). The loader also reads
  `knowledge/extra/*.md` if you add private notes there later; for now that folder is empty.
- **Test questions:** I draft about 30 from your content, each with the passage it should find.
  You review and edit them.
- **Machine:** this MacBook Air, the same as phase 3. The Mac mini install comes later.
- **Fixed answers:** move word for word from `knowledge/answers.draft.md` into
  `knowledge/answers.yaml`, and the small talk into `knowledge/smalltalk.yaml`, now. They aren't
  searched; phase 5's strike check picks the right one for a question. A made-up example of both
  files is committed in `knowledge.example/`.
- **Never searched:** `profile/`, as before.

## How it works

1. **Passages.** `npm run ingest` cuts the content into passages: short pieces that each answer
   one thing.
   - Each project gives a summary passage (what it is), a passage of what it's built with, and one
     passage per bullet. Each job gives one passage per bullet, and a summary when its file has an
     `about` line. Every bullet passage starts with the project or job it belongs to, so
     "Diagnosed a memory leak…" is searched as "ARC (PaperPrism), project, 2025 to now: Diagnosed a
     memory leak…".
   - About gives a facts passage (location, work authorization, education, the poster), the summary,
     and one passage per paragraph of your story.
   - Skills give one passage per group, earlier projects one each, and each instant answer one
     (its question and answer).
   - Private notes in `knowledge/extra/` would be cut at each heading.
2. **Embedding.** Each passage goes to the model server on the Mac, which turns it into 1,024
   numbers with Qwen3-Embedding-0.6B (an embedding model: similar meanings get similar numbers).
   Questions get the same treatment, with a one-line instruction saying it's a recruiter's
   question, which is how that model is meant to be used.
3. **Storing.** Postgres with pgvector, in Docker on this Mac, reachable only from this Mac. The
   loader swaps all old passages for new ones in one transaction, so a search never sees half an
   update.
4. **Search.** Two rankings, merged:
   - **By meaning:** the passages whose numbers are closest to the question's.
   - **By keyword:** the passages containing the question's words, with rare words counting far
     more than common ones. That keeps the passage that literally says "Qdrant" on top when someone
     asks about Qdrant, which meaning alone can miss.
   - **Merging:** reciprocal rank fusion. Each passage scores by its position in each list, so a
     passage near the top of both wins. The top 6 go to the answer model in phase 5.
5. **The test.** `npm run test:search` asks every test question and reports how many found their
   passage in the top 6 (what the answer model will see) and at the top. Starting target: every
   question in the top 6.

## What gets built

| Where | What |
|---|---|
| `docker-compose.yml` | Postgres 18 with pgvector 0.8.7, on `127.0.0.1:5433` only. Its password lives in `.env`, which git ignores. |
| `services/models/` | `embed.py` and a `POST /embed` endpoint on the existing model server (still local-only). |
| `apps/server/` | The start of the chat backend: `src/db/` (connection, migrations, the passages table) and `src/rag/` (cutting passages, embedding, loading, searching), plus tests. |
| `knowledge/` (private) | `answers.yaml`, `smalltalk.yaml`, an empty `extra/`. |
| `knowledge.example/` | The same files with made-up values, so the format is public. |

**Memory:** estimated at 1.2 GB before building, against the 0.6 GB the plan's budget (§3.4)
allowed; measured at 1.6 GB (see the results).

## Results (2026-10-21, MacBook Air)

- **60 passages** (about 2,500 words) from 11 files. `npm run ingest` embeds them in about 3 s.
- **Search test:** all 39 questions find their passage in the top 6, and 29 find it first.
- **Two fixes the test found:**
  - "Tell me about a time you debugged…" first matched "Tell me about yourself" by keyword. Words
    that only frame a question ("tell", "time", "walk me through"…) are now left out of the keyword
    half.
  - A job's summary with nothing but the title and dates sat close to every question and crowded
    out real answers, so a job gets a summary only when its file has an `about` line. A project's
    tools are now their own passage, because a long tool list pulled the summary away from "What is
    ARC?".
- **Memory:** the embedding model takes about 1.6 GB, more than the 0.6 GB estimated (§3.4 is
  updated). The model server holds about 4.7 GB in all.
- **Your review:** the test questions in `apps/server/test/search-questions.yaml`. Add the
  questions you expect most; each needs the file and a few words of the passage that answers it.

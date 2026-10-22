# knowledge.example

The format of the private `knowledge/` folder (plan §7.4), with made-up values. The real folder is
ignored by git, because the repo is public. Copy this folder to `knowledge/` to start one.

| File | What it holds | Who reads it |
|---|---|---|
| `answers.yaml` | Fixed answers: your exact words for salary, work authorization, availability and other topics you want worded exactly. Also the topics handed to the real you. | The chat's strike check picks one; the chat says it word for word (phase 5). Never searched. |
| `smalltalk.yaml` | A few approved small-talk answers, and how many the chat may give per conversation. | The strike check (phase 5). Never searched. |
| `extra/*.md` | Private notes the chat may search and use but the page doesn't show. Each heading starts a new passage. | `npm run ingest`, which loads them into the search alongside `content/`. |

Not here yet: `prompts/`, the strike-check, answer and output-check instructions (phase 5).

**What never goes in:** anything from `profile/`, personal details (phone, home address, pay), and
anything unconfirmed. The chat can repeat whatever it's given.

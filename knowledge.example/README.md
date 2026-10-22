# knowledge.example

The format of the private `knowledge/` folder (plan §7.4), with made-up values. The real folder is
ignored by git, because the repo is public. Copy this folder to `knowledge/` to start one.

| File | What it holds | Who reads it |
|---|---|---|
| `answers.yaml` | Fixed answers: your exact words for salary, work authorization, availability and other topics you want worded exactly. Also the topics handed to the real you. | The chat's strike check picks one; the chat says it word for word (phase 5). Never searched. |
| `buttons.yaml` | The question buttons: each button's question, and either several approved wordings or one fixed answer. | The api plays them on a click; `npm run buttons` voices them ahead of time. Never searched. |
| `smalltalk.yaml` | A few approved small-talk answers, and how many the chat may give per conversation. | The strike check (phase 5). Never searched. |
| `extra/*.md` | Private notes the chat may search and use but the page doesn't show. Each heading starts a new passage. | `npm run ingest`, which loads them into the search alongside `content/`. |
| `prompts/*.md` | The instructions for the strike check, the answers, the output check and the handoff summary. Only described here ([prompts/README.md](prompts/README.md)): publishing them would show attackers what to get around. | The api, when it starts. |
| `redteam/*.yaml` | Not shown here either: the red-team test's attacks and genuine questions (`npm run redteam`). | The red-team runner. |
| `cache/`, `outbox/` | Written by the api: your voice for fixed replies, and emails saved as files until Resend is set up. | The api. |

**What never goes in:** anything from `profile/`, personal details (phone, home address, pay), and
anything unconfirmed. The chat can repeat whatever it's given.

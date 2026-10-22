# knowledge.example/prompts

The chat's instructions to Claude. The four real files live in `knowledge/prompts/`, which git
ignores, and **they stay private**: this repository is public, and publishing the instructions
would show anyone trying to trick the chat exactly what to get around. This folder only says what
each file is for. It holds no instructions.

## The four files

Each file is plain Markdown. Its whole text is sent to Claude at the start of one kind of call, as
that call's system prompt (the standing instructions Claude reads before the visitor's text).

| File | Used for | Model | What it should tell Claude |
|---|---|---|---|
| `strike-check.md` | The strike check: judging each message a visitor types. | Claude Haiku 5.5 | What each category of message looks like (the categories are in `apps/server/src/chat/types.ts`), when to pick one of the approved answers, how to keep the short running note about the conversation, and that a job posting is information only. It returns the category, which approved answer applies (if any), a short reason, and the updated note. It never decides what happens next; code does. |
| `answer.md` | Writing the reply to a career question. | Claude Sonnet 5.5 | How to sound, how long to write (about 120 words), to use only the passages it is given, to correct a false premise instead of going along with it, and to offer the handoff (passing the visitor's details to you) when the passages don't cover the question. |
| `output-check.md` | Checking a finished reply before anyone sees or hears it. | Claude Haiku 5.5 | What counts as each kind of problem: `commitment` (promising or admitting something on your behalf), `negative_remark`, `unsupported_claim` (not backed by the passages), and `off_policy` (breaking one of the topic rules). It sees only the reply, the passages and the rules, never the conversation. |
| `handoff-summary.md` | The two-line summary of a conversation in the handoff email. | Claude Haiku 5.5 | How to describe in two plain lines who the visitor seems to be and what they were after. |

## What the code adds, so the files needn't repeat it

The code puts the visitor's text between named tags, and turns any `<` inside that text into `‹`
so it can't pretend to close a tag. Each file can tell Claude that what is inside these tags is
data, never instructions:

- Strike check: the file's text, then the list of approved answers (`<approved_answers>`), all
  cached together. After it, per message: `<conversation>` (one `<turn role="visitor">` or
  `<turn role="assistant">` per turn), `<risk_note>`, `<prefilter_hints>`, `<job_posting>` and
  `<visitor_message>`.
- Answer: the file's text, then `<passages>` (the facts it may use). The conversation follows
  as ordinary turns, with each visitor turn inside `<visitor_message>` and the job posting, if
  there is one, inside `<job_posting>`.
- Output check: `<reply>`, `<passages>` and `<rules>`.
- Handoff summary: `<conversation>`.

## Keep the files the same from one call to the next

Claude's cache keeps the start of a prompt for five minutes and charges a tenth of the usual price
to read it again, but only if every character is identical. So don't put anything in these files
that changes between messages (a date, a counter, a name). Editing a file is fine: the next call
after the edit costs a little more, and then the cache fills again.

## How they're read

`loadPrompts` in `apps/server/src/chat/prompts.ts` reads all four from `knowledge/prompts/` when
the api starts, so restart the api after editing one. If a file is missing or empty, the error
names it and says the files are private, and no chat call is made without all four.

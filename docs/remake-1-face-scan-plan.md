# Remake 1: face-scan home page

Status: plan agreed 2026-10-20 and revised the same day (pgvector, instant answers, speed plan, Cloudflare Workers, free hair model); ready to build.

## Progress (2026-10-20)

| Phase | State |
|---|---|
| 0. Site setup | Done: Astro + React site with six crawlable panels (commit `65c9432`), live on Cloudflare Workers at a temporary `workers.dev` address (commit `5cb11a0`). Deploys automatically on each push to this branch. |
| 0b. Domain | Done: merlinyang.com's DNS is on Cloudflare (registration stays at Namecheap), and the current Vercel site still loads. There was no email forwarding to recreate. The tunnel hostname comes in phase 5. |
| 1. Capture | Done. Hair photos dropped: the hair comes from a free model, and the head is rebuilt from your scan and the three face photos (§5.1). See below. |
| 2a. Moving face | Done. Built: the converter (`npm run face`); the 3D face with clips, eyes following the pointer or a finger (tilt dropped, §5.5); all 14 effects; the face states; the `?lab` panel with a lip-sync strength control; the six floating buttons (three movement styles in the lab) and the pop-up panels (§4.2); the still image for browsers without WebGL and the link-preview image (`npm run face:still`); browser tests (`npm run test:e2e`, 9 passing). |
| 2b. Head and hair | **Paused (2026-10-21).** The core features (phases 3–7) come first. The realistic head, hair and bust will be modeled in Blender later and dropped in then (§5.8). The face-mesh-only wireframe stays as an artistic option. The code-generated head, hair and realistic mode stay in the lab until the Blender model replaces them. The site shows the face only, and the head file downloads only in the lab. |
| 3. Voice | **Done on the MacBook Air (2026-10-21).** The voice is Pocket-TTS with sound-it-out spellings ("pocket-respelled", §6.3). The model server (`services/models/server.py`) turns a sentence into your voice plus word timing and mouth shapes in about 0.3–0.7 s, holding about 2.3 GB. A `launchd` agent keeps it running; it was tested on the Air. **Deferred:** installing it on the Mac mini and re-measuring there (your call, 2026-10-21). Visitors now only type, so there's no speech-to-text (§7.9). |

**Phase 1 details:**
- **Captured in the app,** each file checked:
  - The face scan.
  - Five clips with eye data.
  - Mouth shapes (second take, after clearer prompts).
  - The eye range.
  - Three texture photos.
- **Voice:** reference sample plus recording-script Parts 3 and 4.
- **Where the files are:** all private, in `knowledge/faceScan/` and `knowledge/voice/`.
- **The iPhone app's code:** commits `24fab9e` and `a222452`.
- **Note for phase 2a:** in the mouth shapes, AH opens the jaw to only 0.35 and R is barely rounded, so the effects lab needs a lip-sync strength control. Branch: `Remake_1_face_scan`.

**Phase 2a details:**
- **Speaking without a voice yet.** Until phase 6, the speaking state shows "fake speech": random
  mouth shapes with pauses. The lab can also hold any one mouth shape, to check the captures.
- **Left and right looks.** The eye-range capture's "left" look went to your right. The site tells
  the sides apart by where the eyes pointed, so this needs no recapture.
- **Buttons and panels.** On screens 700 px and wider the buttons float around the head; on
  narrower screens they sit in rows at the bottom, until the chat box arrives in phase 6 and they
  move into an arc above it. Panels open as a sheet on the right on screens 900 px and wider (the
  face slides left and glances toward it) and fill the screen below that.
- **Checked on your iPhone (2026-10-21):** a finger dragged across the face steers it, and the
  panels feel right, and the face behaves well with reduced motion turned on.
- **Defaults you set from the lab (2026-10-21):** recorded head sway 0.15; buttons in the still
  ring style, distance 1.11, speed 1, bob 0.8.
- **Download size.** The 3D code is 260 KB compressed, mostly three.js and React Three Fiber, and
  loads after the page text. The face files add about 165 KB. Replacing React Three Fiber with plain
  three.js would save an estimated 60–100 KB **(estimate)**, if load time turns out to matter.

Prices and model facts were checked on 2026-10-20 unless marked otherwise. Anything marked
**(estimate)** is a calculation, not a measurement, and should be measured during the build.

---

## 1. What we're building

The home page is one screen with three parts.

- **The face.** A 3D wireframe of your face from the iPhone scan, drawn as points (the 1,220
  vertices) and lines (the edges between them).
  - A custom shader animates it with ripples, waves, wind and more. A shader is a small program on
    the graphics chip that moves and colors every point each frame.
  - The face turns toward the mouse pointer or a finger.
- **Six floating buttons** around the face: About, Experience, Projects, Skills, Résumé, Contact.
  Each one opens a panel of plain text. The text is real HTML from the start, so search engines,
  AI crawlers and link-preview bots can read all of it, just like a plain HTML portfolio.
- **The chat.** Visitors chat with an AI version of you about your career, by typing (the default)
  or by speaking.
  - Every reply is spoken in your cloned voice, muted by default; the visitor can unmute.
  - The lips always move with the words, even when muted.
  - Six common questions ("Tell me about yourself" and so on) sit under the chat box as one-click
    chips with instant, pre-made answers in your voice.
  - When a recruiter wants the real you, the AI takes their contact details and emails you.

Two rules sit around the chat:

- **Career only, three strikes.** Messages that break the rules earn strikes. After three, that
  browser can't chat for 30 days. The server enforces this, not the page.
- **When your Mac mini is unreachable,** the chat shows as offline with "self-hosted in California,
  might be an earthquake", and the face falls asleep. The face, buttons, panels and the six instant
  answers keep working, because they're static files. Clicking a chip wakes the face briefly to answer.

## 2. Decisions and why

**Constraints the plan is built around:**

- A budget under $20 a month.
- An M4 Mac mini with 16 GB, running Docker/OrbStack, Cloudflare Tunnel and Qdrant.
- A public GitHub repo, so nothing private can be committed.

| Topic                           | Decision                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who replies                     | AI version of you, with a handoff to the real you by email                                                                                                     | Recruiters get answers instantly at any hour, and you only step in once someone is serious. A live "real me" mode would need two-way messaging and you on call.                                                                                                                                                          |
| Input                           | Typing only (changed 2026-10-21). The site never records or receives a visitor's voice; dictation built into the visitor's phone or computer types into the chat box like a keyboard | Typing is quieter and more reliable in an office. Phones and computers already have dictation in the keyboard, so a mic of our own adds little, and never receiving recordings keeps visitors' voices off the Mac. |
| Voice                           | Your cloned voice, muted by default; lips always sync                                                                                                          | Hearing your actual voice is the memorable part. Muting by default respects people browsing at work and fits browsers' autoplay rules. Lip-sync keeps the face alive either way.                                                                                                                                         |
| Lip timing when muted           | Audio is always generated and played at zero volume                                                                                                            | Muted and unmuted share one path, so they look identical and unmuting mid-reply just works. It costs nothing extra, because the voice runs on your Mac.                                                                                                                                                                  |
| Face motion                     | Mouth driven by the reply's speech; head, blinks and brows from clips of you recorded on the iPhone                                                            | Lips that don't match the words look dubbed. Your own recorded head and brow movement makes it feel like you, not a generic avatar.                                                                                                                                                                                      |
| Face source                     | iPhone face mesh (1,220 points) with custom shader effects. The rest of the head is rebuilt around it in Blender from your scan and photos, and the hair is a free model (phase 2b).                                                                                                     | It comes with ARKit's 52 expression sliders, so it can talk with no hand rigging in Blender. A sparse 1,220-point mesh suits the wireframe look. Long hair scans badly, so the head and hair are modeled from reference photos and a face texture instead.                                                                                                                                                                         |
| Effects                         | Build all of them, switch between them on a test page, then pick favorites                                                                                     | Shader effects are hard to judge on paper. Trying them live settles it faster than debating.                                                                                                                                                                                                                             |
| Profile                         | Six floating buttons (About, Experience, Projects, Skills, Résumé, Contact), each opening a panel                                                              | The first screen stays just your face, while the full portfolio is one click away for every visitor and crawler.                                                                                                                                                                                                         |
| Crawlers                        | Welcome, AI crawlers included; all profile text is plain HTML                                                                                                  | Recruiters and AI tools find people through search and scraping. A site they can't read is invisible to them.                                                                                                                                                                                                            |
| Site builder                    | Astro, which outputs finished HTML, with the face, buttons and chat as one React + TypeScript component on top (an "island")                                   | Of the options compared, it's the only one where HTML is the default and React is the add-on. Crawlers read everything, text appears before three.js loads, and there are no hydration bugs. Hydration is React re-attaching to prebuilt HTML, which breaks when rendering depends on the pointer or tilt. More in §4.1. |
| Identifying visitors            | Anonymous browser ID plus IP address, no login                                                                                                                 | A login step would drive recruiters away. The trade-off: a determined person can dodge a lockout by clearing cookies.                                                                                                                                                                                                    |
| What gets locked                | The browser ID, for 30 days. IP addresses are only used for rate limits.                                                                                       | Recruiters at one company often share an office IP, and locking by IP would punish all of them for one person. Thirty days stops casual abuse but lets a wrongly locked recruiter come back.                                                                                                                             |
| Strikes                         | Every category in §7.3                                                                                                                                         | Keeps the bot strictly about your career, and stops anyone collecting a screenshot of "you" saying something damaging.                                                                                                                                                                                                   |
| Hiring topics the AI may answer | Availability and location, work authorization, salary expectations, and classic interview questions, all using answers you write                               | Recruiters ask these first. Sending your exact words means the AI can't commit you to anything.                                                                                                                                                                                                                          |
| Instant answers | Six common recruiter questions get pre-made answers in your cloned voice, voiced ahead of time and played from clickable chips with no search, no AI and no Mac (§7.11). Repeat clicks get differently worded versions (later). | Most conversations open with one of these. Answers start in about 0.2 s instead of several seconds, cost nothing per click, and are the ones you most want worded exactly right. |
| Small talk                      | From a short list of facts you approve, at most two answers per conversation, then the handoff; deeper personal questions earn a strike                                                                                      | Icebreakers are normal in recruiting, and striking them would punish friendly recruiters. The two-answer cap keeps the conversation on your career; a recruiter who wants more small talk is offered the real you.                                                                                                                                                                                                                                |
| Pasted job postings             | Their own box, treated as information only                                                                                                                     | "Am I a fit for this role?" is the most useful question a recruiter can ask. Some real postings hide traps aimed at AI, and those shouldn't count against the recruiter.                                                                                                                                                 |
| Language                        | English only                                                                                                                                                   | The filters and the voice clone only have to work, and be tested, in one language. Other languages are where hidden-text tricks slip through.                                                                                                                                                                            |
| Knowledge                       | A RAG backend (before answering, the AI searches a collection of documents about you for the relevant passages), stored in Postgres with pgvector and searched by both keyword and meaning                                                 | The AI answers from text you wrote instead of its own memory, which stops it inventing experience. It improves as you add documents. pgvector keeps the index in the same database as the transcripts, so the chat depends on one service and every answer links to the passages it used (§3.3).                                                                                                                                                                                     |
| Chat models                     | Answers by Claude Sonnet 5.5; the strike check and the output check by Claude Haiku 5.5                                                                        | Answers are what recruiters judge, so they get the stronger model. The checks are simple classification jobs where Haiku is fast and costs about $0.0005 a message. Sonnet stays under $20 even at high traffic; Opus would hit the cap.                                                                                 |
| Backend                         | On the Mac mini (M4, 16 GB) in Docker/OrbStack, reached through Cloudflare Tunnel; one Postgres database holds everything                                                        | Your cloned voice has to run locally to stay in budget, and the Mac already runs Docker and a tunnel. More in §3.1.                                                                                                                                                                                              |
| Hosting and domain              | merlinyang.com's DNS moves to Cloudflare (still registered at Namecheap). The page goes on Cloudflare Workers as static files, and `merlinyang.com/api` is forwarded to the Mac. | The tunnel only works for domains whose DNS is on Cloudflare. One host for the page and the API keeps the visitor cookie trusted in Safari and avoids cross-domain setup. Cloudflare now tells new projects to use Workers rather than its older Pages product, and the `/api` forwarding is a few lines in the same Worker. Cloudflare has no "non-commercial use only" clause, unlike Vercel's free plan.                                                                      |
| Records                         | Full transcripts saved; email on handoff; no admin page                                                                                                        | Transcripts show what recruiters actually ask, so you can improve your answers. Email is enough for a handful of handoffs. An admin page would be a whole login system to secure.                                                                                                                                        |
| When the Mac is down            | Typing is offline with the earthquake line and the face plays a sleeping clip; the six instant answers still work                                                                                          | Honest and on-brand. A cloud fallback would cost money and still wouldn't have your voice. The instant answers are static files, so keeping them working costs nothing and the site stays useful during an outage.                                                                                                                                                                                                                               |
| iOS app                         | Review and reuse `tools/FaceScan.swiftpm`                                                                                                                      | Its structure already matches what the site needs, so fixing the gaps is faster than starting over.                                                                                                                                                                                                                      |
| Old site                        | Removed on this branch; its content moves into `content/`. `main` keeps the old pages.                                                                         | A clean start without losing your writing. `main` stays as the fallback.                                                                                                                                                                                                                                                 |

---

## 3. Architecture

### 3.1 Hosting options considered

In every option the chat model is Claude, reached through the API. A 16 GB Mac can only run about a
4-billion-parameter chat model, and models that small are easy to trick past rules like yours.

|                                     | **A. Backend on the Mac mini (chosen)**                         | B. Hybrid: cloud API, Mac for voice                 | C. All cloud                                                   | D. Small rented server                    |
| ----------------------------------- | --------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| Chat API runs on                    | Mac (Docker), reached through Cloudflare Tunnel                 | Vercel Functions                                    | Vercel Functions                                               | Hetzner, Fly or Railway                   |
| Strike counts and transcripts       | Postgres on the Mac                                             | Neon (hosted Postgres, free tier)                   | Neon                                                           | On the server                             |
| RAG search index                    | pgvector in the Mac's Postgres                                            | Neon with pgvector             | Neon with pgvector, a Postgres add-on for meaning-based search | On the server                             |
| Cloned voice                        | Generated on the Mac                                            | Generated on the Mac                                | ElevenLabs or Cartesia                                         | Cloud voice (a cheap server can't run it) |
| Monthly cost, excluding chat models | About $0                                                        | About $0                                            | $3–47 for voice plus a $6 plan (estimate)                      | €5–7 plus cloud voice                     |
| When the Mac is off                 | Chat offline, as chosen                                         | Still offline, because every reply needs your voice | Unaffected                                                     | Unaffected                                |
| Traffic spike                       | Replies queue; about 2–3 voiced at once on a base M4 (estimate) | Same voice bottleneck                               | Scales, bill grows                                             | Scales somewhat, voice bill grows         |
| Fits under $20?                     | Yes                                                             | Yes                                                 | Only at low traffic                                            | Barely                                    |

**Why A:**

- Every reply needs your voice from the Mac, so staying up without the Mac (B's main advantage)
  is impossible anyway.
- Cloud voice cloning breaks the budget once traffic is moderate.
- **Way out:** A uses Postgres, so moving to B later means pointing the API at Neon. The SQL stays the same.

**Poor fits for a quiet portfolio:** Supabase's free plan pauses a project after a week of low
activity, and Qdrant Cloud's free plan suspends a cluster after a week unused and deletes it after four.

### 3.2 Layout

```
 Visitor's browser, or a crawler
   │  https://merlinyang.com   (everything the browser sees is on this one host)
   ▼
 Cloudflare
   ├─ DNS for merlinyang.com (registration stays at Namecheap)
   ├─ Worker static files: the site Astro builds (HTML, face data, scripts, instant-answer audio)
   ├─ Worker code on /api/*: forwards each request to the Mac and adds
   │    a secret header plus the visitor's real IP address
   ├─ Turnstile (bot check) and one rate-limit rule, applied to /api only
   └─ Tunnel: outbound-only connection from the Mac, so your home IP stays hidden
        │
        ▼
 Mac mini (M4, 16 GB)
   Docker / OrbStack
     ├─ api        Node + TypeScript (Hono), the whole chat pipeline (§7.1). It rejects any
     │             request without the secret header, so the tunnel can't be called directly.
     └─ postgres   visitors, strikes, transcripts, handoffs, spend, and the RAG
                   index (pgvector), all in one database
   Native macOS (outside Docker, because containers on a Mac can't use the graphics chip)
     └─ model server (services/models)
          ├─ text-to-speech in your cloned voice (Pocket-TTS, on the CPU; §6.3)
          ├─ forced aligner: given the text and the audio, finds when each word is spoken
          └─ embedding model: turns text into lists of numbers so similar meanings can be found

 Cloud services
   ├─ Claude API   Haiku 5.5 strike check and output check, Sonnet 5.5 answers
   └─ Resend       handoff emails (free tier: 3,000 a month)
```

**Why one host:**

- The browser ID cookie is set by merlinyang.com itself, so Safari treats it as the site's own
  cookie rather than a tracker's.
- No CORS setup (the browser's rules for calling another domain).

**Why each component:**

| Component                         | Why                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hono                              | A small TypeScript web framework, so the server shares types with the site and you work in one language.                                                               |
| mlx-audio                         | Runs models on the Mac's graphics chip through Apple's MLX library; here, the forced aligner. The voice itself, Pocket-TTS, runs on the CPU through Kyutai's own package (§6.3). |
| Worker code as the `/api` door    | Keeps everything on merlinyang.com. It adds the secret header, so the tunnel address is useless if someone finds it.                                                   |
| Turnstile                         | Free, and usually invisible to people: no puzzles. It stops scripts from creating visitor IDs in bulk.                                                                 |
| Resend                            | 3,000 free emails a month and a simple API; a few handoffs a month need nothing more.                                                                                  |

### 3.3 Database options compared

**Strike counts, transcripts, handoffs:**

| Option                        | Good                                                                                                                       | Bad                                                                                      | Verdict           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| Postgres in Docker on the Mac | Atomic counter updates (two requests can't both read "2 strikes" and miss the third); JSON columns; same SQL as Neon later | One more container, about 0.2–0.3 GB                                                     | **Chosen**        |
| SQLite file on the Mac        | No service to run                                                                                                          | Harder to move to the cloud later                                                        | Fine alternative  |
| Neon (hosted Postgres)        | Works while the Mac is off                                                                                                 | Network round trip; sleeps after 5 minutes idle; no benefit while chat is offline anyway | Only for option B |
| Upstash Redis                 | Built for rate limiting                                                                                                    | Not for transcripts                                                                      | Only for B or C   |

**RAG search index: pgvector in the same Postgres, chosen over your existing Qdrant.** pgvector is a
Postgres add-on that stores the embedding numbers and finds the closest matches.

| | Qdrant (already running) | pgvector (chosen) |
|---|---|---|
| Search speed for a few hundred passages | A few ms | A few ms; at this size it can compare against every row without an index |
| Keyword + meaning search | Built in | Postgres full-text search plus about 20 lines of SQL to merge the two rankings |
| Services the chat depends on | Postgres and Qdrant | Postgres only |
| Shared with your other RAG apps | Yes: their restarts or heavy load affect the chat | No |
| Updating the knowledge | Build a new collection, then switch an alias | One transaction; a visitor never searches a half-updated index |
| Debugging a bad answer | Passage IDs stored as text | Each message links to the exact passages it used; one query shows where an answer came from |
| Backups | Two systems | One `pg_dump` |
| Moving to the cloud later | Qdrant Cloud's free plan suspends after a week | Neon includes pgvector |

**Why pgvector:** Qdrant's strengths (millions of vectors, compression, distributed setups) never
come into play for one person's profile. What matters here is fewer moving parts and being able to
trace an answer back to its passages. Your Qdrant keeps serving your other projects.

**Why keyword + meaning search (called hybrid search):** recruiters ask about exact tool names.
Meaning-only search can rank a passage about "event streaming" above the one that literally says
"Kafka". Adding keyword search keeps exact names on top.

### 3.4 Memory budget on the 16 GB Mac mini (estimate)

| Item                                                   | Approx. memory                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| macOS and background apps                              | 4–5 GB                                                         |
| Docker VM: api, Postgres with pgvector                       | about 1 GB                                                     |
| Text-to-speech, cloned voice (Pocket-TTS, measured)     | about 2.7 GB                                                   |
| Forced aligner (Qwen3-ForcedAligner-0.6B)              | about 1–1.5 GB                                                 |
| Embedding model (Qwen3-Embedding-0.6B)                 | about 0.6 GB                                                   |
| **Total**                                              | **about 9.5–11 GB**, leaving roughly 5–6.5 GB for your other apps |

**Why these models:**

- **Qwen3-Embedding-0.6B:** small, Apache-2.0 licensed, and among the best English retrieval scores
  at its size.
- **The aligner:** works from text it already knows, so it gives better word timing than
  speech-to-text guessing.

- **Trimming option:** drop the aligner and time the lips in the browser from the playing audio
  (§6.2's fallback). That saves about 1–1.5 GB, with less accurate lip timing.
- **Speed:** a base M4 should voice about 2–3 replies at the same time before others queue
  (estimate). That's plenty for recruiter traffic.

### 3.5 Monthly cost (estimate)

**Traffic assumption:** 10–50 conversations a week with about 6 messages each. That is about 260,
650 or 1,300 messages a month at low, mid and high traffic.

**Tokens per visitor message** (a token is about three-quarters of a word):

- Haiku 5.5 strike check: about 2,500 in, 100 out.
- Haiku 5.5 output check: about 1,500 in, 50 out.
- Sonnet 5.5 answer: about 4,000 in, 300 out.

**Prices** (Anthropic's table, cached 2026-10-06, per 1M tokens in/out): Haiku 5.5 is $0.10/$0.50
and Sonnet 5.5 is $2/$10.

|                                                                 | Low   | Mid   | High |
| --------------------------------------------------------------- | ----- | ----- | ---- |
| Sonnet 5.5 answers and Haiku 5.5 checks, about $0.012 a message | $3.00 | $7.50 | $15  |

- **Prompt caching** isn't counted above. It re-uses the fixed part of each prompt (rules, approved
  answers) at a fraction of the price and lowers these figures further.
- **Everything else is $0:** voice, embeddings, Postgres, the tunnel,
  Cloudflare Workers (static files are free and unlimited; 100,000 `/api` requests a day free), Turnstile and Resend's free tier.
- **Instant answers cost nothing per click:** there are no AI calls, and the files come from
  Cloudflare's network. Every recruiter who clicks a chip instead of typing lowers the bill.
- **For comparison:** cloud cloned voice (ElevenLabs Flash plus a $6 plan) would add about $3, $20
  or $47 at the three traffic levels.

---

## 4. Page structure and crawlability

### 4.1 How crawlers read the site

A crawler (Googlebot, Bing, LinkedIn and Slack link previews, GPTBot, ClaudeBot, Common Crawl)
downloads the HTML exactly as the server sends it and reads its text, links and metadata. Only
Google, and Bing in part, also run the page's JavaScript; most others never do.

So everything worth finding must be in the HTML at download time. Astro builds every page into
finished HTML before it's uploaded. The face, the floating buttons' movement and the chat are a
single React + TypeScript island (an interactive component that loads on top of the HTML).

### 4.2 The six buttons and their panels

**In the HTML, without JavaScript:**

- The six buttons are an ordinary `<nav>` of links: `<a href="#experience">` and so on.
- Each panel is a `<section id="…">` with real headings and text.
- Without JavaScript a link simply jumps to its section, so the page reads like a plain portfolio.

**Once the island loads:**

- It positions the buttons around your head and floats them gently.
- Clicking a button opens its section as a pop-up panel (an HTML `<dialog>`). `<dialog>` is the
  browser's built-in pop-up: it moves keyboard focus into the panel, closes on Esc, and is announced
  properly by screen readers, all without extra code.
- A direct link such as `merlinyang.com/#projects` opens that panel.

**The buttons:**

| Button     | Panel                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| About      | Who you are, headline, short bio                                               |
| Experience | Roles, dates, what you did                                                     |
| Projects   | Project write-ups with links                                                   |
| Skills     | Skills and tools                                                               |
| Résumé     | Short summary and the PDF link (`/Merlin_Yang_Resume.pdf`)                     |
| Contact    | Email, LinkedIn, GitHub, and the "Talk to the real Merlin" handoff form (§7.5) |

**Interaction:**

- The face already follows the pointer, so hovering a button makes it look at that button.
- While a panel is open, the face glances toward it.
- On phones the buttons sit in an arc above the chat box, with tap targets of at least 44 px. Panels
  open as full-screen sheets.

**Button movement styles to try in the effects lab (§5.6):**

- Fixed to points on the head, so the buttons turn with the face.
- A slow independent orbit.
- A still ring with a gentle bob.
- With reduced motion turned on, the buttons stay still.

### 4.3 What crawlers get

- **Page basics:** `<h1>` with your name, your headline, and all six panels' text.
- **Head tags:** a `<title>`, a meta description and a canonical URL.
- **Link-preview tags** (Open Graph and Twitter cards): these control what LinkedIn, Slack and
  iMessage show when someone shares the link. The preview image is a still of your wireframe face,
  rendered at build time.
- **Structured data:** a JSON-LD block, which describes the page in a standard vocabulary
  (schema.org) that search engines read directly.
  - It's typed `ProfilePage` + `Person`: name, job title, URL, LinkedIn and GitHub (`sameAs`),
    school (`alumniOf`) and skills (`knowsAbout`).
- **`robots.txt`** allows every crawler, AI crawlers included (GPTBot, ClaudeBot, PerplexityBot,
  Google-Extended, CCBot), and points to **`sitemap.xml`**, which Astro generates.
- **`llms.txt`:** a proposed convention, a Markdown summary at `/llms.txt` for AI tools. Next to it,
  **`/profile.md`** has the whole profile in plain Markdown.
- **The résumé PDF** stays at a stable URL.

The six instant answers (§7.11) also appear as text in the About panel under "Common questions", so
crawlers get them too. Other chat answers aren't crawlable, which is fine: everything they draw on is
already public in the panels, apart from the private approved answers (§7.4).

### 4.4 Cloudflare settings that would silently block crawlers

Check these after moving the DNS, and again after launch:

- **AI crawler blocking.** Since July 2025 Cloudflare blocks AI crawlers by default on newly added
  domains, and can manage `robots.txt` for you to disallow them. Turn both off, or AI crawlers will
  never see your profile. Confirm the setting's current name in the dashboard ("AI Crawl Control" /
  "Block AI bots").
- **Bot Fight Mode:** leave it off. It can challenge legitimate crawlers.
- **Turnstile and the rate-limit rule** apply to `/api/*` only, never to pages.

### 4.5 One source for the profile

- **`content/`** (public, committed) holds Markdown for About, Experience, Projects, Skills and the
  Résumé summary.
  - Astro builds the panels from it and checks every file against a schema, so a missing date or
    title fails the build instead of showing up broken.
  - The chat's RAG ingest reads the same files, so the panels and the AI never disagree.
- **`knowledge/`** (private, ignored by git) holds the approved answers, small-talk facts and the AI
  instructions (§7.4).
- **The old site's content** (`about.html`, `assets/projectsArray.js`, `assets/skills.js`) moves
  into `content/` before those files are deleted.
- **`profile/`** (private, ignored by git) is your raw career material: résumé library, stories,
  facts, intake answers.
  - `content/` and `knowledge/` are written *from* it, keeping the honesty guards in
    `resume_library.yaml`.
  - It is never loaded into the chat's search index itself, because it mixes private details
    (phone number, pay notes, family) with working notes that the chat must never repeat.
  - The first answer drafts, for your review, are in `knowledge/answers.draft.md`.

---

## 5. The face

### 5.1 Capture: review of `tools/FaceScan.swiftpm`

**What already works:**

- **A neutral-face scan.** It averages 120 frames and rejects any frame where your expression is
  more than slightly off neutral. The output is `face.json` with the 1,220 vertices, the triangles,
  and both eye positions.
- **An offset per blendshape.** A blendshape is one of ARKit's 52 named face sliders, such as
  `jawOpen` or `eyeBlinkLeft`. Each offset says how every vertex moves when that slider is at 100%.
- **Clip recording.** The 52 slider values plus head rotation, 30 times a second.
- **Export** through the iOS share sheet.

**Gaps to fix:**

1. The code says the file formats are documented in `tools/face/README.md`, but that file doesn't
   exist. Write it.
2. **Clip types.** There are only two: idle (20 s) and talking (30 s). Add `sleeping` (eyes closed,
   slow breathing, for offline), `listening` and `thinking`. Make the clip list data-driven rather
   than hard-coded buttons.
3. **Viseme capture.** A viseme is the mouth shape shared by a group of speech sounds, such as "oo"
   or "f/v". Add a guided mode that asks you to hold each of the 15 standard visemes for about 1.5 s
   and saves the averaged slider values to `visemes.json`. The lip-sync then uses your own mouth
   shapes instead of a generic table.
4. **Expression shapes are Apple's average.** The offsets come from Apple's generic face model
   (`ARFaceGeometry(blendShapes:)`), applied to your scanned shape. This works because both meshes
   have the same points in the same order, but a smile is Apple's smile on your face. Your clips
   still carry your own timing and mannerisms. Accept this for version 1.
5. **Optional: "read this script" mode.** It records audio while you read a fixed text, which gives
   the voice clone a clean 20–30 s sample with an exact transcript.
6. **Tested on your iPhone 16 Pro Max** (2026-10-20). It builds and runs; the capture session is
   next. Brief tracking dropouts are normal and handled: the status dot ignores dropouts under half
   a second, and clips hold the last pose through them.

**Head and hair (phase 2b).** The iPhone only scans the face. A script generates the rest of the
head, the neck, the shoulders and the ears around your scan, checked against your three texture
photos, and the browser grows the hair (§5.8 has the details and why). The three photos also give
the face's point colors and realistic mode's skin image.


### 5.2 Data pipeline

`tools/face/build.ts` converts the app's exports into files the site loads quickly:

| Input          | Output         | Notes                                                                                                                                                           |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `face.json`    | `face.glb`     | glTF, a standard 3D format that three.js and Blender both open. Includes the 52 named offsets and a precomputed list of about 3,500 unique edges for the lines. |
| `clips/*.json` | `clips.bin`    | Values rounded and packed                                                                                                                                       |
| `visemes.json` | `visemes.json` | Copied as is                                                                                                                                                    |

### 5.3 Rendering

- **Stack:** React Three Fiber (React bindings for three.js) on three.js r180, inside the Astro island.
- **Expression mixing on the CPU, effects on the GPU.** Each frame, JavaScript adds up the active
  expression offsets into one position buffer and uploads it (about 15 KB). The graphics chip then
  applies every effect (wind, ripple, glitch, dust and the rest) in the shader on top of those
  positions. Points and lines read the same buffer, so they can't fall out of step.
  - **Why not mix on the GPU too:** both would work, but the work here is tiny. Each slider moves
    only part of the face and only about a dozen are active at once, so mixing takes tens of
    microseconds.
  - **Features that need the moved positions in JavaScript:**
    - Finding which point a click hit, for the ripple. This is raycasting: tracing the click into
      the 3D scene.
    - Placing buttons anchored to points on the head.
    - Keeping the eye rings with the eyelids.
    - The lab's inspectors.

    GPU mixing would need a second copy of the mixing in JavaScript for these, because reading
    positions back from the graphics chip is slow.
  - **When to switch:** with tens of thousands of points (a detailed head scan), or if a slow phone
    stutters. `face.glb` stores the offsets as standard glTF morph targets, which three.js can mix
    on the GPU, so switching is a contained change.
- **Eyes.** The scan has holes where the eyes are, so the eyes are drawn as small rings of points at
  the captured eye positions. They turn to look at the pointer.
  - Clips replay your recorded eyeball rotations.
  - Pointer-following stays within your own range, captured by the app's eye-range step
    (`gaze.json`). Your eyelids move the way they did when you looked each way.
- **Saving power.** Rendering stops when the tab is hidden, and the pixel ratio is capped at 2.
- **Loading.** The three.js code loads after the HTML is on screen, so the text and buttons appear first.
- **Without WebGL.** If the device can't draw 3D, a still image of the face stands in, and the
  buttons and panels still work.

### 5.4 Motion layers

Each layer overrides the one before it for the sliders it controls:

1. **Base clip.** `idle` by default; `listening`, `thinking` or `sleeping` depending on the state (§5.7).
2. **Talking clip, upper face only.** While audio plays: brows, blinks, cheeks and head sway. The
   clip's mouth and jaw sliders are muted, because the clip's mouth was saying different words and
   would fight the lip-sync.
3. **Lip-sync.** Mouth and jaw sliders from the viseme timeline (§6.2).
4. **Look-at.** Head rotation toward the pointer, a finger, a keyboard-focused button or an open
   panel, plus the eye sliders and eye rings.
5. **Shader effects** (§5.6).

### 5.5 Pointer and touch

- **Desktop.** The head turns toward the pointer, smoothed, with a limit of about ±25° left-right
  and ±15° up-down. The scan is only the front of the face, so turning further would show that it's
  a hollow mask. The eyes turn further than the head.
- **Touch.** The face follows the finger while it touches the screen, then drifts back to center.
- **No tilt (dropped 2026-10-21).** Following the phone's tilt was built and then removed.
  - On iPhone, Safari only shares motion data after the visitor taps a permission button, and that
    button sat among the six profile buttons.
  - Dragging a finger across the face already steers it, so tilt added little for the clutter.
- **Reduced motion.** `prefers-reduced-motion` is the operating-system setting for people who get
  motion sickness. When it's on: smaller head turns, still buttons, and minimal effects.

### 5.6 Effects lab

Open the site with `?lab` to get a control panel built with leva, a small React library for
tweaking values live. It takes a few lines per control, and it only loads with `?lab`, so visitors
never download it. Every effect and every button-movement style (§4.2) gets on/off, strength,
speed and color controls. There are buttons to trigger each state, and an "export settings" button
that copies JSON you commit as the new defaults.

| Effect                 | What it looks like                                                      |
| ---------------------- | ----------------------------------------------------------------------- |
| Wind / drift           | Always-on gentle noise displacement of the points                       |
| Ripple on click or tap | A ring wave spreads across the face from where the visitor clicked it   |
| Wave sweep             | A band passes over the face, used while the AI is thinking              |
| Voice pulse            | Points pulse with the loudness of the reply (works on mute, §6.2)       |
| Glitch                 | Red horizontal tearing, used on a strike                                |
| Dust dissolve          | The face blows away like dust, used on lockout                          |
| Breathing              | Slow brighten-and-dim, used while asleep                                |
| Scanline               | A thin bright line sweeps top to bottom                                 |
| Pointer magnet         | Points near the cursor push away or pull in                             |
| Depth fade             | Points further back dim, which adds depth                               |
| Edge shimmer           | Lines flicker in brightness                                             |
| Twinkle                | Random points briefly brighten                                          |
| Assemble intro         | On load, the points fly in from random positions into the face          |
| State color            | The palette shifts per state (e.g. cool when idle, warm while speaking) |

### 5.7 Face states

| State      | When                           | Face                                           | Default effect                                          |
| ---------- | ------------------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Sleeping   | The health check fails (§7.8)  | `sleeping` clip: eyes closed, slow breathing   | Breathing; typing shows the offline message. Clicking an instant-answer chip wakes the face to answer, then it dozes off again.               |
| Idle       | Nothing happening              | `idle` clip, looking at the pointer            | Wind                                                    |
| Listening  | Visitor is typing or recording | `listening` clip, glancing toward the chat box | Wind, slightly brighter                                 |
| Panel open | A profile panel is open        | Glances toward the panel                       | Wind, dimmed                                            |
| Thinking   | Waiting for a reply            | `thinking` clip                                | Wave sweep                                              |
| Speaking   | Reply audio playing            | Talking clip (upper face) plus lip-sync        | Voice pulse                                             |
| Strike     | A strike was just given        | Brief neutral or frown                         | Glitch; shows "Strike 1 of 3"                           |
| Locked     | Third strike                   | Dissolves and stays scattered                  | Dust; chat box disabled. Buttons and panels still work. |

Ripple on click works in every state except Locked.

---

### 5.8 Head, neck, shoulders and hair (phase 2b)

Your choices (2026-10-21):
- **Body:** head, neck and shoulders.
- **Hair:** generated in code.
- **Styles:** loose and bun, both switchable in the lab so you can compare them, with the length
  adjustable.

**Why the head is generated, not fitted (changed 2026-10-21).** The first version fitted MakeHuman's
base human. On screen its jaw stuck out below your chin, and a seam showed where its points met
your scan's. Two meshes with different spacing never quite meet, so the head is now built from your
scan alone.

**Your face stays your scan.** The script only builds what surrounds it. Your expressions, eye
movement and lip-sync keep driving your scanned face, as before.

**Building it** (`tools/head/build.ts`, run with `npm run head`; the result, `public/face/head.glb`,
opens in Blender):
1. **Describe the shape as distance.** For any point in space, the script can tell how far it is
   from the surface (a signed distance field).
   - The surface is a smooth blend of simple shapes: a skull, a jaw block, a neck, the shoulders and
     two ears.
   - Near your face, the blend gives way to your scan itself. The surface flows out of your scan's
     edge instead of meeting it at a step.
2. **Turn it into a mesh.** The script samples that distance on a 6–7 mm grid and builds triangles
   where the surface crosses, using a method called surface nets. It then evens the mesh out, so
   its spacing matches your face's.
3. **Cut out the face.** Wherever your scan covers the surface, it's removed, and the hole's edge
   is snapped onto your scan's outline points. Your own chin and jaw start the neck, so there's
   no second jaw.
4. **Size.**
   - Head width and top come from the front photo, where your hair is tied back, measured as
     before.
   - The turned photos give the back of the head (where its outline meets the wall) and the ears
     (where skin gives way to the hair behind them).
   - The front photo also gives the neck's width.
   - Each photo is read through a camera model fitted from your scan's points, and the result can
     be drawn over the photos to compare (`HEAD_OVERLAY`). The shoulders were set this way, against
     your shirt in the photos.
   - Typical proportions fill in anything a photo doesn't show clearly.
   - Lab sliders correct the head and ears by eye.
5. **Colors.** Every head point takes its color from the photo that sees it best: skin, hair,
   your shirt. Points no photo sees use hair or shirt colors. About 12,000 point colors are
   published in `head.glb`, but not the photos.
6. **Seam and neck.** Head points within 3 cm of your face's edge follow its expressions. The head
   turns about the top of the neck, the shoulders stay still, and the neck blends between the two.

**Hair** (`apps/site/src/island/face/hair.ts`, generated in the browser when the page loads):
- **The same hair on every visit,** because the random choices come from a fixed seed.
- **Lab settings:** style (loose or bun), strand count, length, part (center or side) and bun
  height.
- **Draping.** Strands start on the scalp and drape over a simplified head, neck and shoulders,
  so they don't pass through the body.
- **Loose:** strands fall down the back and over the shoulders, grouped into locks.
- **Bun:** strands run from the hairline over the scalp to the bun, which is a coil of strands.
- **Drawing:** lines in the same shader as the face. Wind sways the ends more than the roots, and
  when the head turns, the ends trail behind for a moment.

**Rendering changes:**
- **One rotation for everything.** A single head turn, applied on the graphics chip, moves the
  face, eyes, head and hair together, weighted across the neck.
- **Framing** widens to fit the shoulders, so the face is smaller on screen.
- **The turn limit loosens** from ±25° to ±35° (lab), now that there's no hollow mask to hide.
- **Face colors from the photos.**
  - The converter samples your three photos onto the face's points.
  - A lab "photo color" effect blends them in. It's off by default, to keep the wireframe palette.
  - Only the 1,220 point colors are published, not the photos.

**Decision after comparing (2026-10-21): realistic means a proper 3D model, made in Blender.**
- **Why.** The code-generated head, hair and bust, and the photo-textured realistic mode built on
  them, showed that a convincing realistic version (head, hair and bust) needs a properly modeled
  3D model. Generated shapes and strands only approximate it.
- **Later, in Blender** (5.0.1 is installed), after the core features (paused 2026-10-21):
  - Model the head, hair and bust as a proper 3D model, around the scanned face.
  - Inputs to use as reference:
    - `face.glb`: the scan, with its UVs and point colors.
    - `face-texture.jpg`: the skin image, local only.
    - `head.glb`: the generated head, as a starting shape.
    - The three texture photos. Each has a camera model fitted in `tools/head/build.ts`, and
      `HEAD_OVERLAY` draws a model over the photos to compare outlines.
- **The face mesh stays too.** The points-and-edges face is a cool interpretation and an artistic
  choice, so the face-mesh-only look is kept alongside the realistic model.
- **Until then.** The generated head, hair and realistic mode stay in the code and the lab as
  interim versions. Which look the live site shows by default is still to decide.

**Realistic mode, to compare in the lab (added 2026-10-21):**
- **The face as a solid surface.** It's textured with your photos and softly lit, with a slider
  that blends between it and the points and edges.
- **The skin image.** The converter makes it by wrapping the three photos onto the scan.
  - It's your face, unwrapped flat, so it stays out of git and only exists on this Mac until you
    decide to publish it.
  - Until then the deployed site doesn't offer the option.
- **Limits:**
  - The scan's 1,220 points make the nose and lips slightly faceted; smoothing helps.
  - The skin is only as sharp as the phone photos.
  - The eyes and the inside of the mouth are simple stand-ins.
  - The hair stays stylized strands.

**Done when:**
- The full head and shoulders turn with the pointer.
- No seam or second jaw shows when the face moves.
- Both hairstyles switch in the lab.
- Realistic mode can be compared in the lab on this Mac.
- The browser tests pass.

## 6. Voice and lip-sync

### 6.1 Reply audio pipeline

1. The server has the final, checked reply text (§7.1). It is never streamed word by word before
   the check, so nothing unchecked is ever spoken.
2. Split the text into sentences.
3. **Pronunciation list.** Swap tricky names for sound-it-out spellings the voice model can't get
   wrong, such as "Qdrant" → "quadrant", "pgvector" → "P G vector", "nginx" → "engine X".
   - The voice model guesses unfamiliar words from their spelling, whether it copies from a sample
     or was fine-tuned.
   - The list is built from how you say each word in `knowledge/voice/words.m4a`.
   - Only the spoken audio changes; the text on screen keeps the real spelling.
4. For each sentence, in order:
   1. Text-to-speech in your cloned voice produces the audio.
   2. The forced aligner returns each word's start and end time.
   3. Words become phonemes (individual speech sounds) using a pronunciation dictionary, then
      visemes, then slider values using your `visemes.json`.
5. The browser gets a stream of events: the sentence text, a link to its audio, and its viseme
   timeline. The first sentence starts playing while later ones are still being generated.

**Why sentence by sentence:** a 120-word reply is about 55 seconds of speech. Voicing it all before
playing would add tens of seconds of silence. This way the wait is roughly one sentence.

**Why SSE:** the events travel over SSE (server-sent events), a one-way stream from server to
browser over plain HTTP. Only the server needs to push during a reply, so a two-way WebSocket isn't
needed, and plain HTTP passes through the Worker and the tunnel. Confirm this in phase 5 (§12).

### 6.2 Playback in the browser

- **Audio setup.** Audio goes through the Web Audio API into a volume control. Mute sets the volume
  to 0 and the audio still plays, so the timing is identical.
  - **Why Web Audio rather than an `<audio>` tag:** it has a precise clock to schedule mouth shapes
    against, and it can measure loudness for the voice-pulse effect.
- **No autoplay block.** Browsers block sound until the visitor interacts with the page. The first
  Send click counts, so the muted-by-default design never runs into that block.
- **Sync.** Viseme timelines are scheduled against the audio clock, not timers, so the lips can't
  drift from the sound.
- **Voice pulse.** The effect reads loudness before the volume control, so it works on mute.
- **Text reveal.** The reply text appears word by word in step with the speech.
- **Screen readers.** Screen readers get each full sentence once, through a polite live region (an
  area announced when it changes, without interrupting).
- **Fallback.** If alignment fails for a sentence, the browser analyzes the playing audio for mouth
  shapes instead, as wawa-lipsync and HeadAudio do. It's less accurate, but the lips still move.

### 6.3 Voice bake-off (on your actual Mac)

Base-M4 speeds for these models aren't published, so test the top three with your recorded sample
before committing. All three licenses allow use for job hunting.

| Model                     | License                     | Size               | Known speed                                                              | Notes                                                                                                                      |
| ------------------------- | --------------------------- | ------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Qwen3-TTS 0.6B Base (MLX) | Apache-2.0                  | about 2 GB (8-bit) | 1.7B version: 83 s of audio in 51 s on an unspecified MacBook Pro        | Clones from 20–30 s of audio plus its exact transcript                                                                     |
| Chatterbox Turbo (MLX)    | MIT                         | 1–2 GB             | Starts in about 200 ms; slower through PyTorch on an M4 (1.1× real time) | Adds an inaudible watermark                                                                                                |
| Pocket-TTS (Kyutai)       | Code MIT, weights CC-BY-4.0 | under 1 GB         | About 6× real time on an M4 Air, **on the CPU**                          | Leaves the graphics chip free for other models; its terms forbid cloning without consent, which is fine for your own voice |

Score each model on four things:

- Does it sound like you?
- Real-time factor: seconds of compute per second of audio. It must stay under 1, so playback never stalls.
- Memory used.
- Time to the first sentence of audio.

Avoid F5-TTS, XTTS-v2 and Higgs Audio: their licenses forbid commercial use, and job hunting is a
grey area under those terms.

**If no model is fast enough on the Mac mini (your fallback, 2026-10-21):** every answer is
written, approved and voiced ahead of time, and the chat never writes or voices anything new.
- **An answer library.** Each approved answer has its audio and mouth timing made in advance.
  Speed doesn't matter for that, so the best-sounding model wins, even a slow one.
- **Typed messages are matched, not answered.** A message is matched to the closest answer in the
  library by meaning, using the embedding search, and the strike check's AI call (which already
  reads every message) confirms the match.
- **No match.** A fixed, pre-voiced line says the question isn't covered yet and offers the
  handoff to the real you.
- **Trade-off.** Answers can't combine facts or follow up on details, but nothing unchecked is
  ever said, and there is no AI writing cost.
- **What this changes in the bake-off.** Sound comes first. Speed only decides whether live
  answers are possible.

**Bake-off on the MacBook Air first.** The Air has the same M4 chip as the Mac mini, so it shows how
each model sounds and roughly how fast it is. It has no fan and slows down under long loads, and its
24 GB of memory is more than the mini's 16 GB. So the speeds are re-measured on the mini before
anything is decided on speed.

**First results on the MacBook Air (2026-10-21).** Every voice copied your reference recording
(`sample.m4a`; Qwen3-TTS uses its first 21 s with the transcript, Chatterbox its first 10–15 s,
Pocket-TTS its first 30 s) and
read the same 18 lines from your recording script. `services/models/README.md` explains how to
rerun them; the listening page is `knowledge/voice/bakeoff/index.html`.

| Voice | Sounds like you | Speed (RTF) | First sound | Short sentence, whole | Memory |
|---|---|---|---|---|---|
| Qwen3-TTS 0.6B | 0.98 | 0.73 | 0.9 s | 1.9 s | 4.3 GB |
| Qwen3-TTS 0.6B, whole answers | 0.97 | 0.52 | 0.7 s | – | 4.0 GB |
| Qwen3-TTS 0.6B, whole answers, conversational reference | 0.99 | 0.53 | 0.8 s | – | 4.3 GB |
| Qwen3-TTS 1.7B | 0.97 | 1.04 | 1.6 s | 2.4 s | 5.1 GB |
| Chatterbox Turbo | 0.92 | 0.78 | 3.1 s | 1.9 s | 5.6 GB |
| Chatterbox Turbo, 8-bit | 0.92 | 0.50 | 2.1 s | 1.3 s | 3.9 GB |
| Pocket-TTS (on the CPU) | 0.88 | 0.12 | 0.04 s | 0.3 s | 2.7 GB |

- **Sounds like you:** an estimate from a voiceprint model, which turns a recording into numbers
  that match for the same voice. Your own takes score 1.00 against each other, and a stranger (the
  Mac's built-in voices) scores 0.73–0.78. Your ears decide.
- **Your first impression (2026-10-21):** Qwen3-TTS 0.6B has the best overall quality and
  accuracy, and Chatterbox Turbo the most natural flow and cadence. Two Qwen variants test where
  the flow is lost:
  - **Whole answers:** each answer voiced in one go, so the intonation carries across sentences.
    It's also faster, with fewer calls.
  - **Conversational reference:** the voice is copied from your take of a Part 3 answer instead of
    the scripted reading in `sample.m4a`. That take comes from the same recording as the takes it's
    scored against, which may lift its score a little.
- **Words said right.** Parakeet's transcript of each voice matches the script about as closely as
  its transcript of you. The exception is Pocket-TTS, which dropped "with pgvector in Postgres" from
  one names line.
- **Pocket-TTS** is by far the fastest and leaves the graphics chip free, but sounds least like you.
- **Speed (RTF)** is seconds of computing per second of speech; under 1 keeps ahead of playback.
  Qwen3-TTS 1.7B is just slower than real time on the Air.
- **Memory is higher than the 1–2 GB estimated in §3.4**, at 4–6 GB per voice. That's even with
  MLX's reuse cache capped at 1 GB: without the cap, it held 18 GB.
- **First sound** is the typical wait for a sentence's first audio. Qwen3-TTS streams, handing
  over audio in pieces; without streaming it decodes your whole reference clip again for every
  sentence, which adds about 3 s. Chatterbox is faster voicing each sentence in one piece, so its
  first sound is the whole sentence.
- **Short sentence, whole** is the time to voice all of a sentence of 8 words or fewer, which is
  what the chat needs before it can time the lips.
- **Lip timing.** `speak.py` voiced a 14-word sentence (7.3 s of speech) in 4.7 s, then timed the
  words and mouth shapes in 0.3 s.

**Decision (2026-10-21): Pocket-TTS with the sound-it-out spellings ("pocket-respelled").** The
other bake-off models were deleted from the Mac to free 11 GB; `bakeoff/run.py` still lists them,
so any can be downloaded again.

**Pocket-TTS, after listening (2026-10-21).** You found it performs very well, and the only problem
you heard was jumbled tech names. You also found the two Qwen variants worse than plain Qwen3-TTS
0.6B. What was tried:
- **The graphics chip is slower for it.** On the CPU, Kyutai's own package voices at 0.11 of real
  time. mlx-audio's port to the graphics chip runs at 0.17, and it cut sentences short. The model
  is tiny (219 MB) and makes audio a sliver at a time: each step is too small to keep the graphics
  chip busy, and Apple's CPU cores are fast at small sequential work. Staying on two CPU cores also
  leaves the graphics chip free for the aligner and the search model.
- **Fine-tuning is out.** Kyutai's training guide needs at least 100 hours of transcribed speech,
  with 1,000+ for a strong model, plus Linux and an NVIDIA graphics card. Fine-tuning teaches a
  new voice from many hours; one person's voice comes from a short sample instead, which is what
  the bake-off already does.
- **The larger 24-layer English model is no better.** It sounds no more like you, runs at 0.36–0.38
  of real time instead of 0.12, and still cut the "This site uses…" line short.
- **The end-of-speech setting doesn't matter.** Raising it changed nothing. The failures were the
  model repeating a word ("JavaScript, JavaScript") in place of letters it couldn't read.
- **Sound-it-out spellings fix the names.** They're in `services/models/pronunciations.json`,
  chosen with `bakeoff/words.py`, which voices each spelling twice and checks it came out whole.
  - With them, all nine names lines come out whole, up from six.
  - Names you spell out (ARC, SQL, MPNN, judged by how long each took you) work best as letters or
    as letter names written as words, such as "ess cue ell". Bare capitals like "SQL" got jumbled.
  - Next: you check the spellings on `knowledge/voice/words/index.html`.
- **A better reference clip is the main way left to sound more like you.** Pocket-TTS copies the
  recording quality of its sample as well as the voice, and reads only its first 30 s. The current
  sample was recorded while you were sick, so a clean 30 s re-recording, once you've recovered, may
  help.

---

## 7. Chat backend

### 7.1 What happens to one visitor message

Clicked instant-answer chips skip this whole pipeline (§7.11). Typed messages always go through it.

1. **Gate (code, no AI).**
   - The request must carry the secret header from the Worker.
   - The browser ID must be valid and not locked.
   - The visitor must be within rate limits, and the month within the spend cap.
   - The message must be within the length limits.
   - Anything failing gets a fixed reply, with no AI call and no cost.
2. **Pre-filter (code, no AI).**
   - Base64 or hex blobs and reversed text are disguised text and earn a strike.
   - A non-English message gets a fixed English reply asking to continue in English, with no strike.
   - Links and gibberish are flagged.
   - **Why code first:** these checks are free and can't be talked out of their decision, so
     abusers can't burn paid AI calls.
3. **Strike check (Haiku 5.5, structured output).** Structured output means the reply is forced into
   a fixed JSON shape, so the server reads exact fields instead of interpreting prose.
   - **It sees:** the last 10 turns, a running per-conversation risk note, the new message, and the
     job posting if there is one, marked as information only.
   - **It returns:** a `category`, an `intent` (which approved answer applies, if any), and a short reason.
   - **The server decides strikes, not the model.** Code maps each category to an action (§7.3),
     including the "strike only if they ask again after a refusal" rules. A model can be argued
     with; a lookup table can't. The rules can also be unit-tested.
4. **Strike, if any.** Recorded in one database transaction. The visitor gets a pre-written reply
   saying how many strikes are left, never AI-written text, so the refusal itself can't be hijacked.
   On the third strike the browser ID is locked for 30 days.
5. **Answer.**
   - **Approved topics and typed versions of the six instant questions.** The approved topics are
     salary, work authorization, availability, classic interview questions and small talk.
     - The server returns your exact pre-written text with its pre-made audio and mouth timing,
       with no search, no answer call, no output check and no voicing.
     - The AI only chooses which one applies, so it can't turn "I'm open to roles starting in
       January" into "yes, I can start Monday".
   - **Everything else:** search Postgres for the 6 most relevant passages, by meaning (pgvector)
     and by keyword (full-text search), then Sonnet 5.5 answers.
     Its instructions: answer only from those passages, correct false premises ("I haven't worked at
     Google"), stay under about 120 words, and offer the handoff when unsure.
6. **Output check (Haiku 5.5, structured output).**
   - **It checks for:** commitments or admissions on your behalf, negative remarks about people or
     employers, claims the passages don't support, and anything off-policy. Anything flagged is
     replaced with "That one's for the real me. Want me to pass your details along?"
   - **Why a second check:** a clever conversation can still nudge the answer model. A separate
     model that only sees the finished reply, not the persuasion that led to it, is much harder to
     fool, and it runs before anything is spoken.
   - **Code then cleans the reply:** formatting and HTML are stripped, and only links to your own
     sites survive (GitHub, LinkedIn, the résumé, project URLs).
7. **Voice** (§6.1).
8. **Save** the message, category, action, model, tokens and cost to Postgres.

### 7.2 Visitor identity and the strike counter

- **Getting an ID.**
  - On the first chat, the browser sends a Turnstile token. The server creates a random visitor ID
    and returns it in a cookie for merlinyang.com.
  - The cookie is signed with a secret (an HMAC signature, so a changed cookie is detected), marked
    `httpOnly` (page scripts can't read it) and `Secure`, and lasts a year.
  - New IDs are limited to 5 per IP address per hour, so a script can't mint fresh IDs to dodge a lockout.
- **IP addresses are stored only as a salted hash** (scrambled one-way with a secret, so the raw
  address isn't kept) and used only for rate limits. The real address comes from the
  Worker's forwarded header, which the API trusts only alongside the secret header.
- **Lockout.**
  - The third strike sets `locked_until` to 30 days ahead.
  - When it passes, the strike count starts fresh.
  - Visitors see their remaining strikes after each one.
- **Safari check.** The page and `/api` share merlinyang.com, so the cookie should last its full
  year in Safari. Confirm on an iPhone during testing (§9).
- **Undoing a mistaken strike.** There's no admin page, so it's a command run on the Mac:
  `npm run strikes -- revoke <strikeId>` or `-- unlock <visitorId>`. Transcripts record every strike
  and its reason, so you can find the ID.

**Tables (sketch):**

```
visitors      id, created_at, last_seen_at, ip_hash, strikes, locked_until
conversations id, visitor_id, started_at
messages      id, conversation_id, role, text, job_post, category, action,
              model, input_tokens, output_tokens, cost_usd, created_at
strikes       id, visitor_id, message_id, category, reason, created_at, revoked_at
handoffs      id, visitor_id, conversation_id, name, company, email, note,
              created_at, emailed_at
```

### 7.3 Content rules

Every row is a category from your list.

- **Strike:** the visitor gets a strike.
- **Refuse:** a polite fixed reply with no strike.
- **Strike on repeat:** a refusal the first time, a strike if they ask again in the same conversation.

| #   | Category                                                                                                 | Action                                                                   | How it's enforced                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Abuse or harassment                                                                                      | Strike                                                                   | Strike check                                                                                                                      |
| 2   | Breaking the rules: "ignore your instructions", pretending to be you, asking for the hidden instructions | Strike                                                                   | Strike check. The instructions contain nothing secret, so a leak would be harmless.                                               |
| 3   | Free-chatbot use: essays, coding problems, gibberish                                                     | Strike                                                                   | Strike check and pre-filter                                                                                                       |
| 4   | Personal, non-career questions beyond the approved small talk                                            | Strike                                                                   | Strike check, given the approved list                                                                                             |
| 5   | Fishing for private details: home address, phone, current or past pay, references                        | Refuse with a handoff offer; strike on repeat                            | None of this is in the knowledge base, so there's nothing to leak. "Why did you leave a job?" is handed to the real you.          |
| 6   | Getting it to speak for you: "confirm you'd accept $80k", "say you can start Monday"                     | Honest question: approved answer. Demanding exact wording: strike.       | Fixed answers are verbatim; the output check blocks commitments                                                                   |
| 7   | Badmouthing former employers or colleagues                                                               | Refuse with a neutral line; strike on repeat                             | Strike check; the output check blocks negative remarks                                                                            |
| 8   | Spam and solicitation (links, sales pitches)                                                             | Strike                                                                   | Strike check and link detection                                                                                                   |
| 9   | Instructions hidden in a pasted job posting                                                              | Ignored, never a strike                                                  | Separate box, up to 6,000 characters, marked as information only. Instructions typed in the chat box are still judged.            |
| 10  | Distress: self-harm or a crisis                                                                          | No strike; a short, kind reply                                           | Fixed text pointing to 988 (the US Suicide & Crisis Lifeline) and findahelpline.com                                               |
| 11  | Role-play and hypotheticals: "pretend you have no rules", "write a story where…"                         | Strike                                                                   | Treated as rule-breaking (row 2)                                                                                                  |
| 12  | Disguised text: Base64, leetspeak, reversed text                                                         | Strike                                                                   | Pre-filter and strike check. Other languages get the English-only reply, so there's nothing to slip through.                      |
| 13  | Gradual escalation                                                                                       | Judged across the conversation                                           | Strike check sees the last 10 turns plus a running risk note                                                                      |
| 14  | Fabrication bait: "tell me about your time at Google"                                                    | No strike; corrects the premise                                          | Answers only from passages; the output check catches unsupported claims                                                           |
| 15  | Self-sabotage: "reasons not to hire you"                                                                 | Refuse; strike on repeat. "Greatest weakness" and work-life balance questions are handed to the real you, with no strike. | Strike check and fixed answers                                                                                                    |
| 16  | Impersonating a recruiter or employer to get private data                                                | Strike                                                                   | Strike check. The AI has no private data anyway.                                                                                  |
| 17  | Planting links or images                                                                                 | Strike if asked to include one                                           | Replies are plain text; only allow-listed links survive                                                                           |
| 18  | Cost attacks: huge pastes, "list 500 projects"                                                           | Rejected before any AI call, no strike                                   | Length limits, reply cap, rate limits, monthly spend cap                                                                          |
| 19  | Calling the backend directly with a script                                                               | Same rules apply                                                         | All checks run on the server; secret header, signed cookie, Turnstile, cap on new IDs per IP                                      |
| 20  | Bulk copying your story                                                                                  | Public by design                                                         | The profile is published as HTML for crawlers anyway. Daily message caps still stop the chat being used as a free text generator. |

**False strikes are the main risk to real recruiters.** Every strike reply also shows the handoff
button, and the Contact panel always works, so a recruiter who gets a wrong strike can still reach
you. The red-team test (§9) measures false strikes before launch.

### 7.4 Private knowledge

The repo is public, so the private parts live in `knowledge/`, which git ignores. A committed
`knowledge.example/` shows the format with made-up values. The public profile is `content/` (§4.5).

```
knowledge/
  answers.yaml      approved answers: availability_location, work_authorization,
                    salary_expectations, weakness, why_left_<company>, ...
  smalltalk.yaml    approved small-talk facts
  extra/*.md        anything the AI may use that you don't want on the page
  prompts/          strike-check, answer and output-check instructions
```

- **The instructions are private too,** because publishing them would show attackers exactly what to get around.
- **Loading it:** `npm run ingest` splits `content/` and `knowledge/extra/` at each heading, turns
  each piece into numbers with the embedding model, and loads them into Postgres. It swaps old
  passages for new in one transaction, so a visitor never searches a half-updated index. Run it after
  editing either folder.
- **Speed for fixed answers:** their audio and lip timing are generated ahead of time and cached,
  so those replies play instantly.

### 7.5 Handoff

- **Starting it:** the AI offers it, or the visitor uses the form in the Contact panel at any time.
- **The form:** name, company, email, role link (optional) and a message. Protected by Turnstile and
  limited to 2 per browser per day.
- **Without the Mac:** the Contact panel's email and LinkedIn links are plain HTML, so they work
  even when the Mac is down. Only the form needs the Mac.
- **The email to you** (through Resend) has their details, a two-line chat summary written by
  Haiku 5.5, and the full transcript. Resend needs merlinyang.com verified as a sending domain,
  which takes a few DNS records on Cloudflare.

### 7.6 Transcripts and privacy

- **Notice by the chat box:** "You're chatting with an AI version of Merlin. The voice is
  AI-generated. Conversations are saved so Merlin can read them. Please don't share sensitive information."
- **Retention:** transcripts are deleted after 12 months by default. That's long enough to cover a
  job search, and it limits how much personal data sits on your Mac.
- **Reading them:** no admin page, so `npm run transcripts -- recent` on the Mac, or any Postgres client.

### 7.7 Limits (starting values, to be tuned)

| Limit                        | Value                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat message length          | 1,000 characters                                                                                                                                    |
| Job posting length           | 6,000 characters                                                                                                                                    |
| Reply length                 | about 120 words                                                                                                                                     |
| Small talk | 2 answers per conversation, then the handoff offer (no strike) |
| Per browser                  | 10 messages per 5 minutes, 60 per day                                                                                                               |
| Per IP address               | 30 messages per 10 minutes; 5 new browser IDs per hour                                                                                              |
| Replies being voiced at once | 3; others queue while the face shows Thinking                                                                                                       |
| Monthly AI spend             | Stops at $18. Chat pauses with a message, and you get an email. That covers the high-traffic estimate (§3.5) with a $2 buffer under your $20 limit. |

These are starting values: low enough that one script can't do much damage, and high enough that a
real recruiter never hits them.

### 7.8 Offline detection

- The page calls `GET /api/health` on load and every 60 seconds.
- Health only passes if the API, Postgres **and the voice model** all respond, because every
  reply needs your voice.
- No answer within 4 seconds puts the face to sleep, and the chat shows: "Merlin's server is
  self-hosted in California. It might be an earthquake. Try again later, or use the Contact panel."
- The six instant-answer chips stay clickable while offline (§7.11).
- Optional: a free uptime monitor (e.g. UptimeRobot) calls the same health check and emails you
  when the Mac is down.

### 7.9 No voice input (changed 2026-10-21)

- **Visitors only type.** The site has no mic button, and it never records, uploads or receives a
  visitor's voice.
- **Dictation still works.** Phones and computers have dictation built into the keyboard (the mic
  key on an iPhone or Android keyboard, Dictation on a Mac). It types into the chat box like any
  keyboard, so only text reaches the site, and the visitor sees and can fix it before sending.
- **What this removes:** speech-to-text on the Mac (about 1.5 GB of memory) and the 30 s
  recording limit.

### 7.10 Speed

**Where the time goes.** This is the time from Send to the first sound and lip movement for a
generated answer, before any speed work. All figures are estimates; measure them in phase 5.

| Step | Time |
|---|---|
| Browser → Cloudflare → tunnel → Mac | 0.1–0.3 s |
| Gate and pre-filter | about 0.02 s |
| Strike check (Haiku 5.5, thinking off) | 0.4–0.8 s |
| Search | about 0.05 s |
| Answer (Sonnet 5.5, about 120 words) | 1.5–3.5 s |
| Output check | 0.4–0.8 s |
| Voicing the first sentence | 2.5–5 s (unverified on a base M4) |
| Aligning it and downloading the audio | 0.3–0.8 s |
| **Total** | **about 5–11 s** |

The face shows Thinking during the wait. Speed improves in rounds, measuring each time:

| Round | Changes | Expected typical wait for a generated answer |
|---|---|---|
| v1, at launch | Instant answers (§7.11); thinking off or low on all three AI calls; prompt caching, which also makes responses start sooner; models kept loaded and connections kept open; a first sentence of 8 words or fewer, so the first audio is quick to make | 4–7 s |
| v2 | The strike check runs at the same time as search and answering, and a flagged message's answer is thrown away unseen. The answer streams sentence by sentence: each finished sentence gets its own output check, with the earlier sentences as context, and goes to voicing while the next is written. | 2.5–4 s |
| v3 | Reuse an earlier checked answer and its audio when a conversation's first question closely matches one. A monthly script lists the most-asked questions so you can promote them to instant answers. | Common questions near-instant |

**v2 trade-offs:**
- Running the strike check in parallel wastes about $0.01 per flagged message, on the answer that's
  thrown away. Only bad messages cost this.
- If a later sentence fails its check, the earlier ones have already been spoken. They passed their
  own checks, so that's safe; the failing sentence is replaced with the handoff line.

**Measuring.** Every message stores how long each stage took. `npm run speed` prints, per stage,
the typical time (median) and the slow time (95th percentile, meaning 1 message in 20 is slower).
Each round goes after the biggest number.

### 7.11 Instant answers

Six common recruiter questions get pre-made answers in your voice: no search, no AI calls, and no
work on the Mac.

**Three speeds of answer:**

| Speed | Questions | Path | Time to first sound |
|---|---|---|---|
| Instant | The six below, clicked as chips | Pre-made audio and mouth timing from Cloudflare's network | about 0.2 s |
| Fixed | Typed versions of the six; your private approved answers (salary, work authorization, why you left…) | Gate and strike check (to recognize the question), then your text with pre-made audio | about 1–1.5 s |
| Generated | Everything else | The full pipeline (§7.1) | See §7.10 |

**The six (edit freely):**

1. Tell me about yourself.
2. What kind of role are you looking for?
3. What project are you most proud of?
4. What's your strongest tech stack?
5. What are you working on right now?
6. What makes you different?

**How it works:**

- **The source file.** `content/instant.yaml` holds each question, a few ways people phrase it, and
  your answer (about 60–90 words).
  - It's public, so salary and work authorization stay in the private fixed answers (§7.4).
- **Voicing.** `npm run voice:instant`, run on the Mac, voices and aligns each answer into
  `apps/site/public/instant/`.
  - Those files are committed, because Cloudflare's build servers can't run your voice model.
  - Each file records which answer text it was made from, so the build fails if an answer changed
    without being re-voiced.
- **On the page.** The chips sit under the chat box. After an answer plays, the questions not yet
  asked stay, which nudges the conversation along.
- **Preloading.** The six answers' audio (about 1 MB, estimate) downloads once the visitor clicks
  into the chat or hovers a chip, so playback starts at once.
- **Your AI voice throughout.** Instant answers are voiced by your clone ahead of time, never
  recorded live, so every answer on the site sounds the same. The files stream from Cloudflare's
  network: playback starts before the download finishes.
- **Varied wording on repeat clicks (later).**
  - Each question gets two or three versions with the same facts, worded and structured
    differently, all voiced ahead of time.
  - Clicking the same question again plays the next version, never the same one twice in a row.
  - The first version is the one shown in the About panel for crawlers.
  - You approve every version, under the same honesty rules as the answers themselves.
  - Only the first version preloads; later ones download when first needed, which keeps the first
    load small.
- **When the Mac is down,** the chips still work: the sleeping face wakes, answers and dozes off
  again. Typing stays offline.
- **Logging.** When the Mac is up, a click sends a small note to `/api` so it appears in the
  transcript. When it's down, clicks aren't recorded.
- **Locked browsers:** the chips are disabled along with the chat.
- **Crawlers:** the six questions and answers also appear as text in the About panel (§4.3).

**Why:** most conversations open with one of these. That's the moment a visitor decides whether the
chat is worth it, so it should be instant. These are also the answers you most want worded exactly
right, so you write them once instead of letting the AI improvise them each time.

---

## 8. Repo layout on this branch

```
apps/site/             Astro site (static HTML) + one React + TypeScript island
  src/pages/index.astro    home page: <nav> of six links, six panel sections, the island
  src/components/          .astro panel components, head tags, structured data
  src/island/              React + TS: face/, buttons/, chat/, state/ (face states, §5.7)
  public/                  face/ (face.glb, clips.bin, visemes.json), Merlin_Yang_Resume.pdf,
                           favicon.png, robots.txt, llms.txt, preview image,
                           instant/ (pre-made answer audio and mouth timing, committed)
apps/server/           Node + TypeScript (Hono), Dockerfile
  src/pipeline/            gate, pre-filter, strike check, answer, output check, voice
  src/policy/              category → action table (§7.3), tested in isolation
  src/rag/                 ingest, hybrid search (pgvector + full-text)
  src/db/                  schema, migrations, strike and transcript commands
packages/shared/       types shared by site and server (chat events, face states)
services/models/       native macOS model server setup, launchd file, bake-off scripts
content/               public profile Markdown, plus instant.yaml (the six questions and answers)
knowledge/             private, ignored by git
knowledge.example/     committed template
tools/FaceScan.swiftpm iPhone capture app
tools/face/            build.ts and README.md (the file formats)
docker-compose.yml     api and postgres (with the pgvector extension)
worker/index.ts        Cloudflare Worker code that forwards /api to the tunnel (phase 5)
wrangler.jsonc         Cloudflare Workers config: the folder of static files, and the /api route
```

Removed on this branch: `index.html`, `about.html`, `scripts/`, `styles/`, `assets/`,
`vite.config.js`, `vercel.json`, `wireframe.png`. `main` still has them.

---

## 9. Testing

- **Red-team set** (attacks written to break the rules on purpose):
  - About 150 attack messages across all 20 categories, including multi-turn escalation scripts.
  - About 100 genuine recruiter questions.
  - Run it against the strike check and the output check before launch, and after every change to
    the instructions.
  - Starting targets: no more than 1 false strike in the 100 genuine questions, and at least 95% of
    attacks caught.
- **Unit tests:**
  - The category → action table.
  - The strike counter under two requests at once (never skips or double-counts).
  - Lockout expiry, rate limits, link stripping and the pre-filter detectors.
- **Crawlability:**
  - `curl https://merlinyang.com/` returns all six panels' text.
  - With JavaScript disabled, every panel is readable.
  - Google's Rich Results Test accepts the structured data.
  - LinkedIn's Post Inspector shows the preview image.
  - `robots.txt` as served is your file, not one Cloudflare manages.
- **Browser tests** (Playwright):
  - The page loads.
  - The panels open from the buttons and from `#links`.
  - A message gets a voiced reply.
  - Stopping the API puts the face to sleep.
  - A third strike locks the chat while the panels still work.
- **Devices:**
  - iPhone Safari: the visitor cookie surviving more than 7 days.
  - Desktop with reduced motion turned on.
  - A browser with WebGL off: the still image shows and the panels work.
- **Speed:**
  - Stage timings are saved for every message and reviewed against §7.10.
  - Instant-answer chips start in under 0.3 s, including with the API stopped.

## 10. Build order

Each phase ends with something you can see working.

| Phase | Work                                                                                                                                                                           | Done when                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 0     | Set up the Astro + React + TypeScript workspace; move the old site's content into `content/`; remove the old pages; deploy to a Cloudflare Workers address (`*.workers.dev`)     | The preview address shows six readable panels, and `curl` returns their text                                  |
| 0b    | Move merlinyang.com's DNS to Cloudflare. Records keep pointing at Vercel, so the current site stays up. Recreate Namecheap's email forwarding in Cloudflare Email Routing, which stops working otherwise. Set up the tunnel hostname for the API.                                | DNS answers from Cloudflare; the current site and email forwarding are unchanged                                                    |
| 1     | Build the iPhone app on your phone; add the new clips, viseme capture and the format README; capture your data                                                                 | `face.json`, 5 clips, `visemes.json`, `gaze.json` and the texture photos are on the Mac                                                                               |
| 2     | Face rendering, motion layers, pointer and finger following, floating buttons, all effects, the `?lab` page                                                                                | The face follows the pointer and a finger, the buttons float and open panels, and every effect toggles in the lab |
| 2b | Head, neck, shoulders and hair (§5.8): a script generates them around your scan from simple shapes and your photos; hair is generated in the browser in two styles; the seam follows the face; face colors and a realistic mode from the photos | The full head turns with the pointer, and no seam shows when the face moves |
| 3     | Native model server on the Mac and the voice bake-off                                                                                                                          | A script turns a sentence into your voice plus lip timing; RTF measured                                       |
| 4     | Private knowledge folder, ingest into Postgres (pgvector + keyword search), search test                                                                                                                      | Your test questions pull the right passages                                                                   |
| 5     | Chat backend: §7.1 pipeline, strikes, limits, handoff email, transcripts, health check, Worker `/api` proxy, stage timing logs                                                                   | Red-team set meets its targets; SSE confirmed through the proxy                                               |
| 6     | Chat UI wired to the face: voice, lip-sync, text reveal, states, notices; write and voice the six instant answers and add their chips                                                                                                       | A full conversation works on desktop and phone                                                                |
| 7     | Launch: point merlinyang.com at the Worker, check the Cloudflare crawler settings (§4.4), uptime monitor, merge to `main`, retire Vercel                                            | merlinyang.com serves the new page and the crawlability checks pass                                           |
| 8 | Speed v2 (§7.10): strike check in parallel, sentence-by-sentence answers | A typical generated answer starts within 4 s |
| 9 | Speed v3 (§7.10): answer reuse, monthly most-asked report | Common typed questions start almost instantly |

Phases 1 and 3 can run alongside each other, since one is iPhone work and the other is Mac setup.

## 11. Defaults you can change any time

- Transcripts kept for 12 months.
- Monthly AI spend cap of $18.
- The rate limits in §7.7.
- Default effects per state (set from the lab).
- The six instant questions and their answers (§7.11).

## 12. Risks

| Risk                                                 | Mitigation                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The strike check strikes a real recruiter            | False-strike target in the red-team set; handoff button on every strike reply; Contact panel always works; revoke command |
| A base M4 is too slow for your voice clone           | Bake-off first (phase 3); Pocket-TTS runs on the CPU as a fallback; queue plus Thinking state                             |
| The Mac runs out of memory alongside your other apps | Budget in §3.4; drop the aligner and time the lips in the browser from the audio (§6.2)                                   |
| SSE streaming misbehaves through the Worker or the tunnel | Confirm in phase 5 with a test stream. Send a keep-alive comment every 15 s so idle streams aren't closed |
| Cloudflare blocks AI crawlers by default             | §4.4 checklist at DNS move and launch; `robots.txt` check in §9                                                           |
| A viral spike                                        | Rate limits, voicing queue, monthly spend cap, Cloudflare rate-limit rule                                                 |
| Home internet or power outage                        | Designed in: sleeping face, offline message; panels and contact links stay up                                             |
| Generated answers feel slow | Instant answers for the six common questions; the Thinking animation covers the wait; speed rounds v2 and v3 (§7.10) |
| Building the head and long hair takes longer than expected | Both are generated by scripts and checked against the photos, not modeled by hand. It's phase 2b, after the moving face works, so the face-only version can ship first |
| Voice clone misuse                                   | Only your own voice; the page says it's AI-generated; Chatterbox adds a watermark if chosen                               |

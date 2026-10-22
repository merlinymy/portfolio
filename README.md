# portfolio

Source for [merlinyang.com](https://merlinyang.com).

This branch, `Remake_1_face_scan`, rebuilds the home page as a 3D wireframe of my face with a
career-only chat. The full plan is in
[docs/remake-1-face-scan-plan.md](docs/remake-1-face-scan-plan.md).

## Layout

| Path | What's there |
|---|---|
| `apps/site/` | The website: Astro builds plain HTML, with React + TypeScript for the interactive parts |
| `content/` | Profile text (experience, projects, skills, common questions) that the site is built from |
| `tools/FaceScan.swiftpm/` | iPhone app that captures the face mesh and expression clips |
| `apps/server/` | The chat backend, so far its search: the profile cut into passages and searched by meaning and keyword in Postgres ([apps/server/README.md](apps/server/README.md)) |
| `services/models/` | Your cloned voice, the lip-timing model and the embedding model for search, run natively on the Mac, and the model server the chat calls ([services/models/README.md](services/models/README.md)) |
| `knowledge.example/` | The format of the private `knowledge/` folder (fixed answers, small talk, private notes), with made-up values |
| `docker-compose.yml` | Postgres with pgvector, in Docker, reachable from this Mac only |
| `docs/` | Plans and design notes |
| `wrangler.jsonc` | Cloudflare Workers config: which folder to publish, and later the `/api` route |

## Commands

Run from the repo root, with Node 22.22 or newer:

| Command | What it does |
|---|---|
| `npm install` | Installs everything |
| `npm run dev` | Local dev server at http://localhost:4321 |
| `npm run dev:lan` | The same, also reachable from phones on the same Wi-Fi (it prints the address) |
| `npm run build` | Builds the static site into `apps/site/dist/` |
| `npm run check` | Type-checks the site |
| `npm run voice` | Starts the model server: your cloned voice with lip timing, and the embedding model for search, on this Mac only ([services/models/README.md](services/models/README.md)). With `npm run dev` running too, the lab's "Say" box at http://localhost:4321/?lab makes the face speak a sentence |
| `npm run db` | Starts Postgres in Docker (needs Docker running, and `.env` from `.env.example`) |
| `npm run ingest` | Cuts `content/` (and any private notes in `knowledge/extra/`) into passages and loads them into the search. Needs `npm run voice` and `npm run db`. Run it after editing either folder |
| `npm run search -- "A question?"` | Shows the passages the chat would be given for a question |
| `npm run test:search` | Checks that every test question in `apps/server/test/search-questions.yaml` finds its passage |
| `npm run face` | Turns the private face capture in `knowledge/faceScan/` into the site's `apps/site/public/face/` files ([tools/face/README.md](tools/face/README.md)) |
| `npm run head` | Generates the head, neck, shoulders and ears around the face from your scan and texture photos ([tools/face/README.md](tools/face/README.md)) |
| `npm run face:still` | After a build, renders the still face image (for browsers without 3D) and the link-preview image with Chrome. Build again afterwards to include them. |
| `npm run test:e2e` | Builds the site and runs the browser tests in `tests/e2e/` with the Chrome on this Mac |
| `npx wrangler dev` | After a build, serves `apps/site/dist/` the way Cloudflare will, at http://localhost:8787 |

## The effects lab

Add `?lab` to the address, for example http://localhost:4321/?lab. A control panel opens with:
- every face effect, with on, off or "auto" (whatever the face's current state uses)
- the motion settings
- buttons for each face state
- **Style:** how the face is drawn. "points and edges" is the original; "flame" and "ink in water" are
  artistic looks (docs/face-looks-plan.md). Each look has its own folder of settings, and hovering a
  setting shows what it does. "frame time" shows how long each frame takes to draw (16.7 ms is 60
  frames a second). Add `&look=flame` or `&look=ink` to the address to open straight into a look.
- **Say** (only with `npm run dev`): type a sentence and the face says it in your cloned voice, with
  its lips timed to the words. Start the voice first with `npm run voice`; it takes about 5 s to
  load. "lip lead" under Motion sets how far the mouth moves ahead of the sound. To try it on your
  iPhone, start the site with `npm run dev:lan` instead, and open the address it prints under
  "Network" with `?lab` added. The phone must be on the same Wi-Fi. Only one local site runs at a
  time, so stop any other first (`npx astro dev stop` in `apps/site`, or Ctrl+C where it runs).

**Export settings** copies the current values. Paste them over
`apps/site/src/island/face/settings.json` to make them the defaults. Changes made in the panel
only last until you reload the page.

## AI usage

- asked ChatGPT 5 on font choice. Prompt: I think I want to use quicksand font
  from google for 90%. Suggest me some font for h1 and h2

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
| `docs/` | Plans and design notes |
| `wrangler.jsonc` | Cloudflare Workers config: which folder to publish, and later the `/api` route |

## Commands

Run from the repo root, with Node 22.22 or newer:

| Command | What it does |
|---|---|
| `npm install` | Installs everything |
| `npm run dev` | Local dev server at http://localhost:4321 |
| `npm run build` | Builds the static site into `apps/site/dist/` |
| `npm run check` | Type-checks the site |
| `npm run face` | Turns the private face capture in `knowledge/faceScan/` into the site's `apps/site/public/face/` files ([tools/face/README.md](tools/face/README.md)) |
| `npm run head` | Builds the head, neck and shoulders around the face from MakeHuman's CC0 base human ([tools/face/README.md](tools/face/README.md)) |
| `npm run face:still` | After a build, renders the still face image (for browsers without 3D) and the link-preview image with Chrome. Build again afterwards to include them. |
| `npm run test:e2e` | Builds the site and runs the browser tests in `tests/e2e/` with the Chrome on this Mac |
| `npx wrangler dev` | After a build, serves `apps/site/dist/` the way Cloudflare will, at http://localhost:8787 |

## The effects lab

Add `?lab` to the address, for example http://localhost:4321/?lab. A control panel opens with:
- every face effect, with on, off or "auto" (whatever the face's current state uses)
- the motion settings
- buttons for each face state

**Export settings** copies the current values. Paste them over
`apps/site/src/island/face/settings.json` to make them the defaults. Changes made in the panel
only last until you reload the page.

## AI usage

- asked ChatGPT 5 on font choice. Prompt: I think I want to use quicksand font
  from google for 90%. Suggest me some font for h1 and h2

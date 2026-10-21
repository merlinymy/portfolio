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
| `npx wrangler dev` | After a build, serves `apps/site/dist/` the way Cloudflare will, at http://localhost:8787 |

## AI usage

- asked ChatGPT 5 on font choice. Prompt: I think I want to use quicksand font
  from google for 90%. Suggest me some font for h1 and h2

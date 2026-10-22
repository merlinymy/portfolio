# The Worker (`worker/index.ts`)

The Cloudflare Worker is the chat's front door. Visitors' browsers call `/api/...` on the same
address as the site, and the Worker passes each of those calls on to the api running on the Mac,
through a Cloudflare Tunnel (a connection the Mac opens out to Cloudflare, so the home network
needs no open port). It adds two headers on the way: `x-origin-secret`, which the api requires, so
the tunnel's address is useless to anyone who finds it, and `x-real-ip`, the visitor's address as
Cloudflare saw it. It deletes any copy of those two headers the visitor sent. The reply goes back
as a stream and isn't held in memory, so the chat's reply (server-sent events: sentences pushed
one at a time over a plain HTTP response) reaches the page as it's produced.

Every other address (the pages, face data, audio files) is the static site, served by Cloudflare
without running the Worker at all (`run_worker_first: ["/api/*"]` in `wrangler.jsonc`).

## When the chat is offline

If `ORIGIN_URL` or `ORIGIN_SECRET` isn't set, or the Mac can't be reached (connection refused, or
Cloudflare saying the tunnel is down: 502, 504 or 520-530), `/api/...` answers `503` with
`{"error":"offline"}`. The page treats that as "the chat is asleep".

The committed `wrangler.jsonc` sets neither value, so the preview site answers 503 on `/api` until
launch. That is deliberate, not a broken deploy.

## Trying it on this Mac

```
npm run db && npm run voice     # Postgres and the model server, in their own terminals if needed
npm run api                     # the api on 127.0.0.1:8791
```

Create `.dev.vars` in the repo root (git ignores it) with the same `ORIGIN_SECRET` as `.env`:

```
ORIGIN_URL=http://127.0.0.1:8791
ORIGIN_SECRET=<the ORIGIN_SECRET line from .env>
```

Then `npx wrangler dev` serves the site and the Worker together at <http://localhost:8787> (the site
comes from `apps/site/dist`, so run `npm run build` first). For example,
`curl -N http://localhost:8787/api/health`. Without `.dev.vars`, `/api` answers 503 offline.
`wrangler dev` runs everything on this Mac; nothing is deployed.

## The test

```
npm run build                   # only if apps/site/dist is missing or old
node worker/test-stream.ts
```

It starts a stand-in api (port 8799) that records the headers it receives and sends three events a
second apart, and three local Workers (ports 8796-8798). It checks that the events arrive one by one,
that a visitor's fake `x-origin-secret` and `x-real-ip` are replaced, that the request and the
reply (method, query, body, cookies, status) pass through unchanged, that the site still serves,
and that each way of being offline answers 503. It uses a made-up secret, never the one in `.env`,
and stops everything it started. It won't run while a `.dev.vars` exists, since that would change
what it sees; move the file aside first. `npx tsc -p worker` type-checks both files.

## Needed at launch

1. The tunnel's public address (a hostname such as `https://api-origin.merlinyang.com`, set up with
   the Mac mini), and a long random `ORIGIN_SECRET`, the same value as in the Mac's `.env`.
2. Give both to the Worker as secrets, which keeps them out of the public repo and keeps them
   through every deploy (a plain variable set in the dashboard is removed by the next deploy
   unless it's also in `wrangler.jsonc`):

   ```
   npx wrangler secret put ORIGIN_URL
   npx wrangler secret put ORIGIN_SECRET
   ```
3. The api, the tunnel and the model server running on the Mac. `/api/health` shows whether the
   chat is awake.

The api reads the visitor's address only from `x-real-ip` and ignores `x-forwarded-for`, which a
visitor can fake.

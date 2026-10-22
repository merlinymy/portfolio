/**
 * The Cloudflare Worker (plan §3.2). It only handles /api/*: each request is forwarded to the api
 * on the Mac (through the tunnel) with a secret header and the visitor's real IP address added.
 * Everything else is the static site, which Cloudflare serves without running this code
 * (wrangler.jsonc: run_worker_first).
 *
 * Until the tunnel exists, ORIGIN_URL isn't set and every /api request answers 503 "offline",
 * which the page reads as "the chat is asleep".
 */

interface Env {
  /** The static site (the built Astro files). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Where the api lives: the tunnel's address, or http://127.0.0.1:8791 with `wrangler dev`. */
  ORIGIN_URL?: string;
  /** Shared with the api (ORIGIN_SECRET in .env); it refuses any request without it. */
  ORIGIN_SECRET?: string;
}

function offline(): Response {
  // no-store: a Cloudflare cache must never keep this and keep answering "offline" after launch.
  return Response.json({ error: "offline" }, { status: 503, headers: { "cache-control": "no-store" } });
}

/**
 * Cloudflare answers for the Mac itself when the tunnel is down (502, 504, or its own 520-530
 * codes, for example 530 when no tunnel is connected). That's "can't be reached", same as a
 * refused connection.
 */
function originIsDown(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 530);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (!env.ORIGIN_URL || !env.ORIGIN_SECRET) return offline();

    // The visitor can send any headers they like, so drop their copies of the two the api trusts
    // before adding ours.
    const headers = new Headers(request.headers);
    headers.delete("x-origin-secret");
    headers.delete("x-real-ip");
    headers.set("x-origin-secret", env.ORIGIN_SECRET);
    const ip = request.headers.get("cf-connecting-ip");
    if (ip) headers.set("x-real-ip", ip);

    try {
      const target = env.ORIGIN_URL.replace(/\/+$/, "") + url.pathname + url.search;
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        // An api redirect is for the visitor's browser to follow, not for this Worker.
        redirect: "manual",
      });
      if (originIsDown(response.status)) {
        await response.body?.cancel();
        return offline();
      }
      // The body is handed on as a stream and never read here, so server-sent events (the chat's
      // reply, one sentence at a time) reach the browser as they're produced.
      return response;
    } catch {
      return offline();
    }
  },
};

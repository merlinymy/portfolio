/**
 * Checks the Worker in the real Workers runtime (`wrangler dev`, local only, nothing is deployed)
 * against a throwaway stand-in for the api. Run it from the repo root:
 *
 *   node worker/test-stream.ts
 *
 * It starts the stand-in api on port 8799 and three local Workers on 8796-8798, and checks that:
 * server-sent events come through one by one instead of all at the end, the visitor's fake
 * x-origin-secret and x-real-ip are replaced, method, query, body and cookies arrive intact, the
 * api's own status codes and Set-Cookie come back unchanged, other URLs still serve the site, and
 * an unset, missing or unreachable origin answers 503 {"error":"offline"}.
 *
 * The secret below is made up for this test; it is not the one in .env. The built site must exist
 * in apps/site/dist (`npm run build`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import worker from "./index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET = "test-only-secret-not-the-real-one";
const ORIGIN_PORT = 8799;
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
// Three Workers: pointed at the stand-in api, with nothing configured, and pointed at a port
// where nothing listens.
const CONFIGURED = { port: 8798, inspector: 9248 };
const UNSET = { port: 8797, inspector: 9247 };
const UNREACHABLE = { port: 8796, inspector: 9246 };
const NOTHING_LISTENS = "http://127.0.0.1:8795";
const FAKE_EDGE_IP = "203.0.113.9";

if (!existsSync(`${ROOT}apps/site/dist/index.html`)) {
  console.error("The site isn't built: run `npm run build` first.");
  process.exit(1);
}
if (existsSync(`${ROOT}.dev.vars`)) {
  // wrangler would read it and the "nothing configured" check would no longer be true.
  console.error("A .dev.vars file exists and would change what this test sees. Move it aside first.");
  process.exit(1);
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---- The stand-in api: records what it receives and streams on request. -----------------------

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };
const seen: Seen[] = [];

const origin = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const record: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
  seen.push(record);

  const path = new URL(record.url, "http://stand-in").pathname;
  if (path === "/api/stream") {
    // Three events, one second apart, the first at once.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (let n = 1; n <= 3; n++) {
      if (res.destroyed) return;
      res.write(`event: tick\ndata: ${JSON.stringify({ n })}\n\n`);
      if (n < 3) await sleep(1000);
    }
    res.end();
  } else if (path === "/api/echo") {
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "mv=abc; Path=/api; HttpOnly" });
    res.end(JSON.stringify(record));
  } else if (path === "/api/unhealthy") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end('{"ok":false}');
  } else if (path === "/api/forbidden") {
    res.writeHead(403).end();
  } else if (path === "/api/tunnel-down") {
    // What Cloudflare itself answers when the tunnel to the Mac isn't connected.
    res.writeHead(530, { "content-type": "text/plain" });
    res.end("error code: 1033");
  } else if (path === "/api/reset") {
    req.socket.destroy();
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => origin.listen(ORIGIN_PORT, "127.0.0.1", resolve));

// ---- Local Workers. ---------------------------------------------------------------------------

const children: ChildProcess[] = [];
// Each local Worker keeps its state in its own folder; two sharing one lock each other out.
const stateFolder = mkdtempSync(join(tmpdir(), "worker-test-"));

function stopAll() {
  for (const child of children) {
    // Negative pid: the whole group, because wrangler starts the runtime as a child process.
    if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  origin.closeAllConnections();
  origin.close();
  rmSync(stateFolder, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(130);
  });
}

async function startWorker(where: { port: number; inspector: number }, vars: Record<string, string>) {
  const args = [
    "dev", "--local", "--ip", "127.0.0.1", "--port", String(where.port),
    "--inspector-port", String(where.inspector), "--persist-to", join(stateFolder, String(where.port)),
    "--log-level", "warn",
    "--show-interactive-dev-session=false",
  ];
  for (const [name, value] of Object.entries(vars)) args.push("--var", `${name}:${value}`);
  const child = spawn(`${ROOT}node_modules/.bin/wrangler`, args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (data) => (output += data));
  child.stderr?.on("data", (data) => (output += data));
  let exited = false;
  child.on("exit", () => (exited = true));

  const base = `http://127.0.0.1:${where.port}`;
  for (let tries = 0; tries < 400; tries++) {
    if (exited) throw new Error(`wrangler dev on ${where.port} stopped early:\n${output}`);
    try {
      await fetch(`${base}/`);
      return base;
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`wrangler dev on ${where.port} never answered:\n${output}`);
}

/** Reads a server-sent event stream and notes how many seconds after the request each event arrived. */
async function readEvents(url: string, init: RequestInit = {}) {
  const start = performance.now();
  const response = await fetch(url, init);
  const headersAt = (performance.now() - start) / 1000;
  const arrivals: number[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes("\n\n")) {
      buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
      arrivals.push((performance.now() - start) / 1000);
    }
  }
  return { response, headersAt, arrivals };
}

async function isOffline(response: Response) {
  const body = await response.text();
  return response.status === 503 && body === '{"error":"offline"}' && /json/.test(response.headers.get("content-type") ?? "");
}

// ---- The checks. ------------------------------------------------------------------------------

try {
  // Without a running Worker: every way of not being configured, and what isn't /api.
  const site = { fetch: async () => new Response("the static site") };
  const before = seen.length;
  for (const [label, env] of [
    ["nothing set", {}],
    ["only the address set", { ORIGIN_URL: ORIGIN }],
    ["only the secret set", { ORIGIN_SECRET: SECRET }],
    ["both set but empty", { ORIGIN_URL: "", ORIGIN_SECRET: "" }],
  ] as const) {
    const response = await worker.fetch(new Request("https://site.test/api/health"), { ASSETS: site, ...env });
    check(`${label}: /api answers 503 offline`, await isOffline(response));
  }
  check("none of those reached the api", seen.length === before);
  const page = await worker.fetch(new Request("https://site.test/api"), { ASSETS: site, ORIGIN_URL: ORIGIN, ORIGIN_SECRET: SECRET });
  check("/api without a slash is the site's, not forwarded", (await page.text()) === "the static site" && seen.length === before);

  console.log("\nstarting three local Workers (takes a few seconds)...");
  const [configured, unset, unreachable] = await Promise.all([
    startWorker(CONFIGURED, { ORIGIN_URL: ORIGIN, ORIGIN_SECRET: SECRET }),
    startWorker(UNSET, {}),
    startWorker(UNREACHABLE, { ORIGIN_URL: NOTHING_LISTENS, ORIGIN_SECRET: SECRET }),
  ]);

  console.log("\nstreaming:");
  // On Cloudflare the edge sets CF-Connecting-IP itself; `wrangler dev` passes the client's on,
  // so the test plays the edge.
  const forged = { "x-origin-secret": "forged-by-the-visitor", "x-real-ip": "6.6.6.6", "cf-connecting-ip": FAKE_EDGE_IP };
  const stream = await readEvents(`${configured}/api/stream?probe=1`, { headers: forged });
  const [first = 0, second = 0, third = 0] = stream.arrivals;
  console.log(`  response headers at ${stream.headersAt.toFixed(2)} s`);
  stream.arrivals.forEach((at, i) => console.log(`  event ${i + 1} arrived at ${at.toFixed(2)} s`));
  check("content-type stays text/event-stream", stream.response.headers.get("content-type") === "text/event-stream");
  check("three events arrived", stream.arrivals.length === 3);
  check(
    "events arrive one by one, about a second apart (not all at the end)",
    second - first > 0.8 && third - second > 0.8,
    `gaps ${(second - first).toFixed(2)} s and ${(third - second).toFixed(2)} s`,
  );
  check("the first event arrives before the api has sent the third", first < third - 1.5);

  console.log("\nheaders the api received:");
  const streamed = seen.find((s) => s.url === "/api/stream?probe=1")!;
  check("x-origin-secret is ours, not the visitor's", streamed.headers["x-origin-secret"] === SECRET);
  check("x-real-ip is not the visitor's fake", streamed.headers["x-real-ip"] !== "6.6.6.6");
  check("x-real-ip is the CF-Connecting-IP value", streamed.headers["x-real-ip"] === FAKE_EDGE_IP, `got ${streamed.headers["x-real-ip"]}`);
  check("the path and query arrived as sent", streamed.url === "/api/stream?probe=1");

  console.log("\nrequest and response pass through:");
  const echo = await fetch(`${configured}/api/echo?x=1&y=two`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "mv=visitor.signature" },
    body: '{"message":"hello"}',
  });
  const echoed = (await echo.json()) as Seen;
  check("method, query and body arrive intact", echoed.method === "POST" && echoed.url === "/api/echo?x=1&y=two" && echoed.body === '{"message":"hello"}');
  check("the visitor's cookie and content-type arrive", echoed.headers.cookie === "mv=visitor.signature" && echoed.headers["content-type"] === "application/json");
  check("the api's Set-Cookie comes back", echo.headers.get("set-cookie") === "mv=abc; Path=/api; HttpOnly");
  const unhealthy = await fetch(`${configured}/api/unhealthy`);
  check("the api's own 503 passes through with its body", unhealthy.status === 503 && (await unhealthy.text()) === '{"ok":false}');
  const forbidden = await fetch(`${configured}/api/forbidden`);
  check("the api's 403 passes through", forbidden.status === 403);

  console.log("\nthe site:");
  const home = await fetch(`${configured}/`);
  check("/ serves the built site", home.status === 200 && (await home.text()).includes("<html"));
  const robots = await fetch(`${configured}/robots.txt`);
  check("/robots.txt serves the file", robots.status === 200);
  const count = seen.length;
  const near = await fetch(`${configured}/apix`);
  await near.arrayBuffer();
  check("a path that only starts like /api isn't forwarded", seen.length === count);

  console.log("\noffline:");
  check("nothing configured: /api answers 503 offline", await isOffline(await fetch(`${unset}/api/health`)));
  const unsetHome = await fetch(`${unset}/`);
  check("nothing configured: the site still serves", unsetHome.status === 200 && (await unsetHome.text()).includes("<html"));
  check("api address with nothing listening: 503 offline", await isOffline(await fetch(`${unreachable}/api/health`)));
  check("api drops the connection: 503 offline", await isOffline(await fetch(`${configured}/api/reset`)));
  check("tunnel down (Cloudflare's 530): 503 offline", await isOffline(await fetch(`${configured}/api/tunnel-down`)));
} catch (error) {
  failures++;
  console.error(error);
} finally {
  stopAll();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

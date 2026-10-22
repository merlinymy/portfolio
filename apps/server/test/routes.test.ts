/**
 * The api's routes (src/app.ts) through `app.request()`: the secret header, the visitor cookie,
 * the event stream parsed back into events, the handoff and the instant clicks, plus the email
 * sender (src/mail.ts). Turnstile, the model server and Resend are stubbed; Postgres is a
 * throwaway database; nothing calls Claude.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import type { ChatEvent, VisitorStatus } from "@portfolio/shared/chat";
import postgres from "postgres";
import { createApp, makeRequestCounter } from "../src/app.ts";
import type { AppConfig, AppContext } from "../src/app.ts";
import { MAX_STRIKES, messageCounts } from "../src/db/chat.ts";
import { hashIp, signVisitor, verifyVisitor } from "../src/identity.ts";
import { loadButtons } from "../src/chat/buttons.ts";
import { makeGate } from "../src/chat/gate.ts";
import { makeSpeaker } from "../src/chat/voice.ts";
import { readButtons } from "../src/wiring.ts";
import { purgeOutbox, sendMail } from "../src/mail.ts";
import type { Mail, MailConfig } from "../src/mail.ts";
import { ERROR, GATE } from "../src/chat/replies.ts";
import { FIXED } from "./helpers/rig.ts";
import type { Turn } from "../src/chat/types.ts";
import { addVisitor, createTestDb } from "./helpers/db.ts";
import type { TestDb } from "./helpers/db.ts";
import { BUTTONS, haiku, rig as makeRig } from "./helpers/rig.ts";
import type { Rig } from "./helpers/rig.ts";

const ORIGIN = "origin-secret-for-tests";
const COOKIE_SECRET = "cookie-secret-for-tests";
const SALT = "salt-for-tests";

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.drop();
});

interface Harness {
  app: ReturnType<typeof createApp>;
  rig: Rig;
  logs: string[];
  sent: Mail[];
  summarized: Turn[][];
  turnstileCalls: URLSearchParams[];
  /** Turn things off or on: the model server's health, the email, the summary. */
  state: { modelsOk: boolean; mailFails: boolean; summaryFails: boolean };
}

function harness(overrides: Partial<AppContext> = {}, config: Partial<AppConfig> = {}, rigOptions: { voicedAtOnce?: number } = {}): Harness {
  const r = makeRig(db.sql, rigOptions);
  const logs: string[] = [];
  const sent: Mail[] = [];
  const summarized: Turn[][] = [];
  const turnstileCalls: URLSearchParams[] = [];
  const state = { modelsOk: true, mailFails: false, summaryFails: false };
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.startsWith("https://challenges.cloudflare.com/")) {
      const form = init?.body as URLSearchParams;
      turnstileCalls.push(form);
      return Response.json({ success: form.get("response") === "good-token" });
    }
    if (address === "http://models.test/health") return state.modelsOk ? Response.json({ ok: true }) : new Response("loading", { status: 503 });
    throw new Error(`unexpected fetch ${address}`);
  }) as typeof fetch;
  r.ctx.log = (line) => logs.push(line);
  const app = createApp({
    sql: db.sql,
    pipeline: r.ctx,
    buttons: BUTTONS,
    config: {
      originSecret: ORIGIN,
      cookieSecret: COOKIE_SECRET,
      ipSalt: SALT,
      turnstileSecret: "turnstile-secret",
      handoffPerDay: 2,
      modelsUrl: "http://models.test",
      keepAliveMs: 20,
      healthTimeoutMs: 300,
      requestLimits: { perIpPerMinute: 10_000, perBrowserPerMinute: 10_000 },
      allowedOrigins: ["https://merlinyang.com", "http://localhost:4321"],
      emitTimeoutMs: 10_000,
      ...config,
    },
    summarize: async (turns) => {
      summarized.push(turns);
      if (state.summaryFails) throw new Error("no key");
      return { text: "Asked about Postgres and wants a call.", usage: haiku(0.0007, 400) };
    },
    mail: async (mail) => {
      if (state.mailFails) throw new Error("Resend answered 500 (application_error)");
      sent.push(mail);
    },
    claudeConfigured: () => false,
    fetch: fetchStub,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { app, rig: r, logs, sent, summarized, turnstileCalls, state };
}

interface CallOptions {
  method?: string;
  body?: unknown;
  /** The visitor id to send a signed cookie for, or a raw cookie value. */
  visitor?: string;
  cookie?: string;
  /** false leaves the secret header off. */
  secret?: string | false;
  ip?: string;
  signal?: AbortSignal;
  origin?: string;
  /** Replaces the JSON content type. */
  contentType?: string;
}

function call(h: Harness, path: string, o: CallOptions = {}) {
  const headers: Record<string, string> = { "content-type": o.contentType ?? "application/json" };
  if (o.origin !== undefined) headers.origin = o.origin;
  if (o.secret !== false) headers["x-origin-secret"] = o.secret ?? ORIGIN;
  if (o.ip !== undefined) headers["x-real-ip"] = o.ip;
  const value = o.cookie ?? (o.visitor ? signVisitor(o.visitor, COOKIE_SECRET) : undefined);
  if (value) headers.cookie = `mv=${value}`;
  return h.app.request(path, {
    method: o.method ?? (o.body === undefined ? "GET" : "POST"),
    headers,
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
    signal: o.signal,
  });
}

/** A stream of server-sent events, read back into events and comment lines. */
function parseSse(text: string) {
  const events: { name: string; data: ChatEvent }[] = [];
  const comments: string[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    if (lines.every((l) => l.startsWith(":"))) {
      comments.push(...lines);
      continue;
    }
    const name = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null";
    events.push({ name, data: JSON.parse(data) });
  }
  return { events, comments };
}

const chat = async (h: Harness, visitor: string, message: string, extra: Record<string, unknown> = {}) => {
  const res = await call(h, "/api/chat", { body: { message, ...extra }, visitor, ip: visitor });
  return { res, ...parseSse(await res.text()) };
};

// ---- The secret header -------------------------------------------------------------------------

test("every route refuses a request without the secret header: 403 and nothing in the body", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const routes: [string, CallOptions][] = [
    ["/api/health", {}],
    ["/api/visitor", {}],
    ["/api/visitor", { body: { turnstileToken: "good-token" } }],
    ["/api/chat", { body: { message: "hi" }, visitor }],
    ["/api/handoff", { body: {}, visitor }],
    ["/api/instant", { body: { id: "tell-me-about-yourself" } }],
    ["/api/nothing-here", {}],
  ];
  for (const [path, options] of routes) {
    for (const secret of [false, "wrong-secret", ""] as const) {
      const res = await call(h, path, { ...options, secret });
      assert.equal(res.status, 403, `${path} with ${JSON.stringify(secret)}`);
      assert.equal(await res.text(), "");
    }
  }
  assert.equal((await call(h, "/api/health")).status, 200, "and the right secret gets in");
});

// ---- Health ------------------------------------------------------------------------------------

test("health: ok when the database and the model server answer; 503 when either doesn't; claude doesn't matter", async () => {
  const h = harness();
  const ok = await call(h, "/api/health");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, db: true, models: true, claude: false });

  h.state.modelsOk = false;
  const down = await call(h, "/api/health");
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { ok: false, db: true, models: false, claude: false });

  const unreachable = harness({
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  assert.equal((await call(unreachable, "/api/health")).status, 503);

  const dead = postgres({ host: "127.0.0.1", port: 1, database: "nothing", max: 1, connect_timeout: 1, onnotice: () => {} });
  try {
    const noDb = harness({ sql: dead });
    const res = await call(noDb, "/api/health");
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { db: boolean }).db, false);
  } finally {
    await dead.end({ timeout: 0 });
  }
});

// ---- The visitor cookie ------------------------------------------------------------------------

test("no valid cookie: 401 'no visitor' on chat, visitor and handoff", async () => {
  const h = harness();
  const unknown = "5a7dbb0c-1a3b-4c47-9d0e-0a3d3f5b2c11"; // signed correctly, but no such browser
  const cases: [string, CallOptions][] = [
    ["/api/chat", { body: { message: "hi" } }],
    ["/api/visitor", {}],
    ["/api/handoff", { body: { name: "A" } }],
  ];
  const real = await addVisitor(db.sql);
  const good = signVisitor(real, COOKIE_SECRET);
  const tampered = `${real}.${good.split(".")[1].replace(/.$/, (c) => (c === "A" ? "B" : "A"))}`;
  for (const [path, options] of cases) {
    for (const cookie of [undefined, "garbage", tampered, signVisitor(unknown, COOKIE_SECRET), signVisitor(real, "another-secret")]) {
      const res = await call(h, path, { ...options, cookie });
      assert.equal(res.status, 401, `${path} with ${cookie ?? "no cookie"}`);
      assert.deepEqual(await res.json(), { error: "no visitor" });
    }
  }
});

test("getting a browser: Turnstile, then a signed cookie with the right attributes, and the address is stored only scrambled", async () => {
  const h = harness();
  const refused = await call(h, "/api/visitor", { body: { turnstileToken: "bad-token" }, ip: "203.0.113.50" });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("set-cookie"), null);

  const res = await call(h, "/api/visitor", { body: { turnstileToken: "good-token" }, ip: "203.0.113.50" });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as VisitorStatus, { strikes: 0, strikesLeft: MAX_STRIKES, lockedUntil: null });
  const form = h.turnstileCalls.at(-1)!;
  assert.equal(form.get("secret"), "turnstile-secret");
  assert.equal(form.get("remoteip"), "203.0.113.50", "Cloudflare is told the visitor's address from x-real-ip");

  const setCookie = res.headers.get("set-cookie") ?? "";
  const [pair, ...attributes] = setCookie.split("; ");
  assert.match(pair, /^mv=/);
  const id = verifyVisitor(decodeURIComponent(pair.slice(3)), COOKIE_SECRET);
  assert.ok(id, "the cookie verifies");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api", "Max-Age=31536000"]) {
    assert.ok(attributes.some((a) => a.toLowerCase() === attribute.toLowerCase()), `${attribute} in ${setCookie}`);
  }

  const [row] = await db.sql<{ ip_hash: string }[]>`select ip_hash from visitors where id = ${id}`;
  assert.equal(row.ip_hash, hashIp("203.0.113.50", SALT));
  assert.ok(!row.ip_hash.includes("203.0.113"));

  const status = await call(h, "/api/visitor", { cookie: decodeURIComponent(pair.slice(3)) });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { strikes: 0, strikesLeft: 3, lockedUntil: null });
});

test("a body without a token is a bad request; a browser that has a cookie keeps it; new browsers are limited per address", async () => {
  const h = harness();
  assert.equal((await call(h, "/api/visitor", { body: {}, ip: "198.51.100.1" })).status, 400);
  assert.equal((await call(h, "/api/visitor", { body: "{not json", ip: "198.51.100.1" })).status, 400);

  const existing = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '3 days' where id = ${existing}`;
  const again = await call(h, "/api/visitor", { body: { turnstileToken: "good-token" }, visitor: existing, ip: "198.51.100.2" });
  assert.equal(again.status, 200);
  const status = (await again.json()) as VisitorStatus;
  assert.equal(status.strikesLeft, 0, "asking for a new browser doesn't get a locked one a fresh start");
  assert.ok(status.lockedUntil);
  assert.equal(verifyVisitor(decodeURIComponent((again.headers.get("set-cookie") ?? "").split(";")[0].slice(3)), COOKIE_SECRET), existing);

  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await call(h, "/api/visitor", { body: { turnstileToken: "good-token" }, ip: "198.51.100.77" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
});

test("a browser's standing: locked, and reset once the lock has run out", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '3 days' where id = ${visitor}`;
  const locked = (await (await call(h, "/api/visitor", { visitor })).json()) as VisitorStatus;
  assert.equal(locked.strikes, 3);
  assert.equal(locked.strikesLeft, 0);
  assert.ok(locked.lockedUntil && new Date(locked.lockedUntil).getTime() > Date.now());

  await db.sql`update visitors set locked_until = now() - interval '1 minute' where id = ${visitor}`;
  assert.deepEqual(await (await call(h, "/api/visitor", { visitor })).json(), { strikes: 0, strikesLeft: 3, lockedUntil: null });
});

// ---- Chat --------------------------------------------------------------------------------------

test("a message streams back as server-sent events named after their type, in order", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const { res, events, comments } = await chat(h, visitor, "What did you build with Postgres?");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(
    events.map((e) => e.name),
    ["meta", "state", "state", "sentence", "sentence", "done"],
  );
  for (const e of events) assert.equal(e.name, e.data.type);
  assert.deepEqual(
    events.filter((e) => e.data.type === "state").map((e) => (e.data as { state: string }).state),
    ["thinking", "speaking"],
  );
  const done = events.at(-1)!.data as Extract<ChatEvent, { type: "done" }>;
  assert.equal(done.kind, "answer");
  const sentences = events.filter((e) => e.data.type === "sentence").map((e) => (e.data as { text: string }).text);
  assert.equal(sentences.join(" "), done.text);
  assert.ok(comments.length === 0 || comments.every((c) => c === ": keep-alive"));

  const [line] = h.logs.filter((l) => l.startsWith("chat: "));
  assert.match(line, /^chat: answer category=career total=\d+ms cost=\$0\.0037$/);
  assert.ok(!h.logs.join("\n").includes("Postgres"), "the message text is never logged");
});

test("the conversation id from `meta` continues the conversation", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const first = await chat(h, visitor, "First question");
  const meta = first.events[0].data as Extract<ChatEvent, { type: "meta" }>;
  const second = await chat(h, visitor, "Second question", { conversationId: meta.conversationId });
  assert.equal((second.events[0].data as { conversationId: string }).conversationId, meta.conversationId);
  const [{ n }] = await db.sql<{ n: number }[]>`select count(*)::int as n from messages where conversation_id = ${meta.conversationId}`;
  assert.equal(n, 4);
});

test("a gate refusal is an ordinary stream with the fixed reply", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const { events } = await chat(h, visitor, "x".repeat(1001));
  const done = events.at(-1)!.data as Extract<ChatEvent, { type: "done" }>;
  assert.equal(done.kind, "gate");
  assert.equal(done.text, GATE.tooLong);
  assert.deepEqual(events.map((e) => e.name).slice(0, 3), ["meta", "state", "state"]);
});

test("bodies that aren't a message are 400; absurdly long ones never reach the pipeline", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }, "[1,2]", "not json", { message: "hi", jobPost: 7 }]) {
    const res = await call(h, "/api/chat", { body, visitor, ip: visitor });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "bad request" });
  }
  assert.equal((await call(h, "/api/chat", { body: { message: "x".repeat(10_001) }, visitor, ip: visitor })).status, 400);
  assert.equal((await call(h, "/api/chat", { body: { message: "hi", filler: "y".repeat(250_000) }, visitor, ip: visitor })).status, 413);
  assert.deepEqual(h.rig.calls, [], "none of that reached a stage");
});

test("a job posting and blank optional fields are accepted", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const { events } = await chat(h, visitor, "Am I a fit?", { jobPost: "Backend engineer", conversationId: "" });
  assert.equal((events.at(-1)!.data as { kind: string }).kind, "answer");
  const call = h.rig.calls.find((c) => c.stage === "answer")!.arg as { jobPost: string };
  assert.equal(call.jobPost, "Backend engineer");
  const { events: blank } = await chat(h, visitor, "Another one", { jobPost: "  " });
  assert.equal((h.rig.calls.filter((c) => c.stage === "answer").at(-1)!.arg as { jobPost: unknown }).jobPost, null);
  assert.equal(blank.at(-1)!.name, "done");
});

test("a slow reply keeps the stream open with a comment line", async () => {
  const h = harness();
  h.rig.speakImpl = async (text) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { text, audio: "A", duration: 1, words: null, visemes: null };
  };
  const visitor = await addVisitor(db.sql);
  const { comments, events } = await chat(h, visitor, "What did you build?");
  assert.ok(comments.length >= 2, `keep-alive comments: ${comments.length}`);
  assert.ok(comments.every((c) => c === ": keep-alive"));
  assert.equal(events.at(-1)!.name, "done");
});

test("if the pipeline itself fails after the stream has started, the page gets the apology as `done`", async () => {
  const dead = postgres({ host: "127.0.0.1", port: 1, database: "nothing", max: 1, connect_timeout: 1, onnotice: () => {} });
  try {
    const base = harness();
    const h = harness({ pipeline: { ...base.rig.ctx, sql: dead } });
    const visitor = await addVisitor(db.sql);
    const { res, events } = await chat(h, visitor, "Hello");
    assert.equal(res.status, 200);
    assert.deepEqual(events.map((e) => e.name), ["done"]);
    assert.deepEqual(events[0].data, { type: "done", kind: "error", text: ERROR });
    assert.ok(h.logs.some((l) => l.startsWith("chat: failed")));
  } finally {
    await dead.end({ timeout: 0 });
  }
});

test("a visitor who closes the page mid-reply stops the work and frees their place", async () => {
  const h = harness();
  h.rig.speakImpl = async (text) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { text, audio: "A", duration: 1, words: null, visemes: null };
  };
  const visitor = await addVisitor(db.sql);
  const left = new AbortController();
  const res = await call(h, "/api/chat", { body: { message: "What did you build?" }, visitor, ip: visitor, signal: left.signal });
  const reader = res.body!.getReader();
  await reader.read(); // the first event
  left.abort();
  await reader.cancel().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(h.rig.calls, [{ stage: "prefilter" }], "the strike check, the answer and the voice never ran");
  const [row] = await db.sql<{ action: string; reason: string }[]>`select action, reason from messages where visitor_id = ${visitor} and role = 'visitor'`;
  assert.equal(row.action, "error");
  assert.match(row.reason, /left/);
  // Their browser can send again straight away: nothing is stuck.
  const next = await chat(h, visitor, "Hello again");
  assert.equal((next.events.at(-1)!.data as { kind: string }).kind, "answer");
});

// ---- Handoff -----------------------------------------------------------------------------------

const form = (extra: Record<string, unknown> = {}) => ({
  name: "Ada Recruiter",
  company: "Acme",
  email: "ada@acme.example",
  roleLink: "https://acme.example/jobs/42",
  message: "We'd love to talk about a backend role.",
  turnstileToken: "good-token",
  ...extra,
});

test("a handoff: saved, summarized, and emailed with the details, the summary and the full transcript", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const first = await chat(h, visitor, "What did you build with Postgres?");
  const conversationId = (first.events[0].data as { conversationId: string }).conversationId;
  await chat(h, visitor, "x".repeat(1200), { conversationId }); // turned away by the gate, but part of the transcript

  const res = await call(h, "/api/handoff", { body: form({ conversationId }), visitor, ip: "203.0.113.7" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const [row] = await db.sql<
    { name: string; company: string; email: string; role_link: string; note: string; summary: string; cost: number; emailed_at: Date | null; email_error: string | null; conversation_id: string }[]
  >`select name, company, email, role_link, note, summary, cost_usd::float8 as cost, emailed_at, email_error, conversation_id from handoffs where visitor_id = ${visitor}`;
  assert.equal(row.name, "Ada Recruiter");
  assert.equal(row.company, "Acme");
  assert.equal(row.email, "ada@acme.example");
  assert.equal(row.role_link, "https://acme.example/jobs/42");
  assert.equal(row.note, "We'd love to talk about a backend role.");
  assert.equal(row.summary, "Asked about Postgres and wants a call.");
  assert.ok(Math.abs(row.cost - 0.0007) < 1e-9, "the summary's cost is recorded");
  assert.ok(row.emailed_at);
  assert.equal(row.email_error, null);
  assert.equal(row.conversation_id, conversationId);

  assert.equal(h.summarized.length, 1);
  assert.deepEqual(h.summarized[0].map((t) => t.role), ["visitor", "assistant"], "the gate's refusal isn't summarized");

  assert.equal(h.sent.length, 1);
  const mail = h.sent[0];
  assert.equal(mail.subject, "Handoff from Ada Recruiter (Acme)");
  assert.equal(mail.replyTo, "ada@acme.example");
  for (const part of [
    "Ada Recruiter",
    "Acme",
    "ada@acme.example",
    "https://acme.example/jobs/42",
    "We'd love to talk about a backend role.",
    "Asked about Postgres and wants a call.",
    "What did you build with Postgres?",
    "I built a retrieval system on Postgres.",
    GATE.tooLong,
  ]) {
    assert.ok(mail.text.includes(part), `the email has "${part}"`);
  }
  assert.ok(!h.turnstileCalls.some((f) => f.get("response") === "bad"), "");
});

test("a handoff with no chat before it, and optional fields left blank", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const res = await call(h, "/api/handoff", { body: form({ company: "", roleLink: "", conversationId: "" }), visitor });
  assert.equal(res.status, 200);
  assert.equal(h.summarized.length, 0, "nothing to summarize");
  assert.match(h.sent[0].text, /they didn't chat first/);
  assert.equal(h.sent[0].subject, "Handoff from Ada Recruiter");
  const [row] = await db.sql<{ company: string | null; role_link: string | null; summary: string | null }[]>`select company, role_link, summary from handoffs where visitor_id = ${visitor}`;
  assert.deepEqual(row, { company: null, role_link: null, summary: null });
});

test("a failed email or summary is recorded but the visitor is still told ok", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const chatted = await chat(h, visitor, "What did you build?");
  const conversationId = (chatted.events[0].data as { conversationId: string }).conversationId;
  h.state.mailFails = true;
  h.state.summaryFails = true;
  const res = await call(h, "/api/handoff", { body: form({ conversationId }), visitor });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const [row] = await db.sql<{ emailed_at: Date | null; email_error: string | null; summary: string | null; cost: number }[]>`
    select emailed_at, email_error, summary, cost_usd::float8 as cost from handoffs where visitor_id = ${visitor}`;
  assert.equal(row.emailed_at, null);
  assert.match(row.email_error ?? "", /Resend answered 500/);
  assert.equal(row.summary, null);
  assert.equal(row.cost, 0);
});

test("handoff checks: Turnstile, field limits, and 2 a day per browser", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  assert.equal((await call(h, "/api/handoff", { body: form({ turnstileToken: "bad-token" }), visitor })).status, 403);

  const bad: Record<string, unknown>[] = [
    { name: "" },
    { name: "n".repeat(101) },
    { company: "c".repeat(101) },
    { email: "not-an-email" },
    { email: `${"a".repeat(250)}@x.example` },
    { roleLink: "javascript:alert(1)" },
    { roleLink: "ftp://example.com/job" },
    { roleLink: `https://example.com/${"p".repeat(500)}` },
    { message: "" },
    { message: "m".repeat(2001) },
    { turnstileToken: "" },
  ];
  for (const change of bad) assert.equal((await call(h, "/api/handoff", { body: form(change), visitor })).status, 400, JSON.stringify(change).slice(0, 60));
  assert.equal(h.sent.length, 0);
  assert.equal((await db.sql`select 1 from handoffs where visitor_id = ${visitor}`).length, 0, "nothing was saved");

  assert.equal((await call(h, "/api/handoff", { body: form(), visitor })).status, 200);
  assert.equal((await call(h, "/api/handoff", { body: form(), visitor })).status, 200);
  const third = await call(h, "/api/handoff", { body: form(), visitor });
  assert.equal(third.status, 429);
  assert.equal(h.sent.length, 2);

  const other = await addVisitor(db.sql);
  assert.equal((await call(h, "/api/handoff", { body: form(), visitor: other })).status, 200, "another browser has its own allowance");
});

test("a locked browser can still use the handoff form", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '3 days' where id = ${visitor}`;
  assert.equal((await call(h, "/api/handoff", { body: form(), visitor })).status, 200);
});

// ---- Instant clicks ----------------------------------------------------------------------------

// ---- Question buttons ---------------------------------------------------------------------------

const click = async (h: Harness, visitor: string, id: string, extra: Record<string, unknown> = {}) => {
  const res = await call(h, "/api/instant", { body: { id, ...extra }, visitor, ip: visitor });
  return { res, ...parseSse(res.status === 200 ? await res.text() : ""), body: res.status === 200 ? null : await res.text() };
};
const playedText = (events: { data: ChatEvent }[]) => (events.at(-1)!.data as Extract<ChatEvent, { type: "done" }>).text;

test("GET /api/instant lists the buttons that have an approved version, without a cookie, behind the secret and the limiter", async () => {
  const h = harness({}, { requestLimits: { perIpPerMinute: 3, perBrowserPerMinute: 100 } });
  const res = await call(h, "/api/instant", { ip: "198.51.100.30" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [
    { id: "about-you", question: "Tell me about yourself." },
    { id: "start-date", question: "When can you start?" },
  ]);
  assert.equal((await call(h, "/api/instant", { secret: false })).status, 403);
  await call(h, "/api/instant", { ip: "198.51.100.30" });
  await call(h, "/api/instant", { ip: "198.51.100.30" });
  assert.equal((await call(h, "/api/instant", { ip: "198.51.100.30" })).status, 429);
});

test("a click streams the same events as a typed message, ending in done with kind fixed and the text", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const { res, events } = await click(h, visitor, "about-you");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.deepEqual(
    events.map((e) => e.name),
    ["meta", "state", "state", "sentence", "sentence", "done"],
  );
  assert.deepEqual(
    events.filter((e) => e.data.type === "state").map((e) => (e.data as { state: string }).state),
    ["thinking", "speaking"],
  );
  const done = events.at(-1)!.data as Extract<ChatEvent, { type: "done" }>;
  assert.equal(done.kind, "fixed");
  assert.equal(done.text, BUTTONS[0].versions[0]);
  const sentences = events.filter((e) => e.data.type === "sentence").map((e) => e.data as Extract<ChatEvent, { type: "sentence" }>);
  assert.deepEqual(sentences.map((s) => s.text), ["I'm Merlin.", "I build AI tools for experts."]);
  assert.ok(sentences.every((s) => s.audio?.startsWith("AUDIO(")), "each sentence is voiced");
  assert.deepEqual(h.rig.calls.filter((c) => c.stage === "speak").map((c) => (c.arg as { cache: boolean }).cache), [true, true], "from the cache");
  assert.deepEqual(h.rig.calls.filter((c) => c.stage !== "speak"), [], "no strike check, search or answer");
  assert.match(h.logs.find((l) => l.startsWith("chat: button")) ?? "", /^chat: button about-you fixed version=1\/3 total=\d+ms$/);
});

test("repeat clicks play the approved versions in file order, cycling, so never the same one twice in a row", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const played: string[] = [];
  for (let i = 0; i < 7; i++) played.push(playedText((await click(h, visitor, "about-you")).events));
  const v = BUTTONS[0].versions;
  assert.deepEqual(played, [v[0], v[1], v[2], v[0], v[1], v[2], v[0]]);
  assert.ok(played.every((text, i) => i === 0 || text !== played[i - 1]));
  assert.ok(!played.includes("This wording was never approved."));

  // Another button has its own count, and a button with one version plays it every time.
  assert.equal(playedText((await click(h, visitor, "start-date")).events), BUTTONS[1].versions[0]);
  assert.equal(playedText((await click(h, visitor, "start-date")).events), BUTTONS[1].versions[0]);
  assert.equal(playedText((await click(h, visitor, "about-you")).events), v[1], "the 8th click on about-you");

  // Another browser starts from the first.
  assert.equal(playedText((await click(h, await addVisitor(db.sql), "about-you")).events), v[0]);
  const [{ n }] = await db.sql<{ n: number }[]>`select count(*)::int as n from instant_clicks where visitor_id = ${visitor} and instant_id = 'about-you'`;
  assert.equal(n, 8);
});

test("clicks made at the same moment still play different versions in turn", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const results = await Promise.all(Array.from({ length: 3 }, () => click(h, visitor, "about-you")));
  const played = results.map((r) => playedText(r.events)).sort();
  assert.deepEqual(played, [...BUTTONS[0].versions].sort());
});

test("only approved wordings play: the real loader keeps the unapproved ones out, whatever order the file has them in", async () => {
  const dir = await mkdtemp(`${tmpdir()}/buttons-test-`);
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      `${dir}/buttons.yaml`,
      `
- id: about-you
  question: Tell me about yourself.
  versions:
    - { approved: false, text: Draft one, not approved. }
    - { approved: true, text: Approved one. }
    - { approved: false, text: Draft two, not approved. }
    - { approved: true, text: Approved two. }
- id: sponsorship
  question: Do you need sponsorship?
  answer: salary_expectations
- id: waiting
  question: Nothing approved yet?
  versions:
    - { approved: false, text: Not yet. }
`,
    );
    const logs: string[] = [];
    const buttons = await readButtons(dir, FIXED, (l) => logs.push(l));
    assert.deepEqual(logs, ['buttons: "waiting" has no approved version yet, so it isn\'t offered']);
    const h = harness({ buttons });
    const visitor = await addVisitor(db.sql);
    const played = [];
    for (let i = 0; i < 5; i++) played.push(playedText((await click(h, visitor, "about-you")).events));
    assert.deepEqual(played, ["Approved one.", "Approved two.", "Approved one.", "Approved two.", "Approved one."]);
    assert.equal(playedText((await click(h, visitor, "sponsorship")).events), FIXED.get("salary_expectations")!.answer, "a fixed answer, word for word");
    assert.equal((await click(h, visitor, "waiting")).res.status, 404, "nothing approved: not a button yet");
    assert.deepEqual((await (await call(h, "/api/instant")).json()).map((b: { id: string }) => b.id), ["about-you", "sponsorship"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buttons.yaml: no file means no buttons with one line; a bad file is an error that names it", async () => {
  const dir = await mkdtemp(`${tmpdir()}/buttons-test-`);
  try {
    const { writeFile } = await import("node:fs/promises");
    const logs: string[] = [];
    assert.deepEqual(await readButtons(dir, FIXED, (l) => logs.push(l)), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /buttons\.yaml isn't there/);

    await writeFile(`${dir}/buttons.yaml`, "- id: about-you\n  question: Q\n  answer: no_such_answer\n");
    await assert.rejects(readButtons(dir, FIXED, () => {}), (err: Error) => err.message.includes("buttons.yaml") && err.message.includes("no_such_answer"));
    await writeFile(`${dir}/buttons.yaml`, "- id: x\n  question: [unclosed\n");
    await assert.rejects(readButtons(dir, FIXED, () => {}), (err: Error) => err.message.includes("buttons.yaml"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a click needs a browser and a button that exists and has an approved version", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const anonymous = await call(h, "/api/instant", { body: { id: "about-you" } });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "no visitor" });
  for (const id of ["made-up", "role", "salary_expectations", "about-you#follow-up", "ABOUT-YOU"]) {
    const result = await click(h, visitor, id);
    assert.equal(result.res.status, 404, id);
    assert.deepEqual(JSON.parse(result.body!), { error: "no such button" });
  }
  assert.equal((await click(h, visitor, "")).res.status, 400);
  assert.equal((await call(h, "/api/instant", { body: {}, visitor })).status, 400);
  assert.equal((await call(h, "/api/instant", { body: { id: "x".repeat(101) }, visitor })).status, 400);
  assert.equal((await db.sql`select 1 from instant_clicks where visitor_id = ${visitor}`).length, 0, "nothing was recorded");
  assert.deepEqual(h.rig.calls, []);
});

test("a locked browser gets the locked reply, like the chat, and the click isn't counted", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '3 days' where id = ${visitor}`;
  const { events } = await click(h, visitor, "about-you");
  const done = events.at(-1)!.data as Extract<ChatEvent, { type: "done" }>;
  assert.deepEqual({ kind: done.kind, text: done.text }, { kind: "gate", text: GATE.locked });
  assert.deepEqual(events.map((e) => e.name).slice(0, 3), ["meta", "state", "state"]);
  assert.equal((await db.sql`select 1 from instant_clicks where visitor_id = ${visitor}`).length, 0, "no click recorded: the next real one plays the first version");
  const rows = await db.sql<{ role: string; action: string; intent: string | null }[]>`select role, action, intent from messages where visitor_id = ${visitor} order by id`;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { role: "visitor", action: "gate", intent: "button:about-you" },
    { role: "assistant", action: "gate", intent: null },
  ]);

  // The lock running out lets the click through, from the first version.
  await db.sql`update visitors set locked_until = now() - interval '1 minute' where id = ${visitor}`;
  assert.equal(playedText((await click(h, visitor, "about-you")).events), BUTTONS[0].versions[0]);
});

test("clicks aren't messages: they don't use up the typed limits, and the spending cap doesn't stop them", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  for (let i = 0; i < 14; i++) assert.equal((await click(h, visitor, i % 2 ? "start-date" : "about-you")).res.status, 200);
  const counts = await messageCounts(db.sql, visitor, visitor);
  assert.deepEqual(counts, { day: 0, fiveMinutes: 0, ipTenMinutes: 0 });
  // 14 clicks, and the typed message still isn't "too fast" (the limit is 10 in 5 minutes).
  const typed = await chat(h, visitor, "What did you build?");
  assert.equal((typed.events.at(-1)!.data as { kind: string }).kind, "answer");

  // Over the month's cap, typing is paused and the buttons still work.
  h.rig.ctx.gate = makeGate({ sql: db.sql, limits: { ...h.rig.ctx.gate.limits, spendCapUsd: 0 }, mail: async () => {}, log: () => {} });
  const paused = await chat(h, visitor, "And another?");
  assert.equal((paused.events.at(-1)!.data as { kind: string }).kind, "gate");
  assert.equal((await click(h, visitor, "about-you")).res.status, 200);
  assert.equal(playedText((await click(h, visitor, "about-you")).events) !== "", true);
  const [{ cost }] = await db.sql<{ cost: number }[]>`
    select coalesce(sum(cost_usd) filter (where intent like 'button:%'), 0)::float8 as cost from messages where visitor_id = ${visitor}`;
  assert.equal(cost, 0);
});

test("a click is written to the transcript, in the browser's latest conversation or a new one, and the strike check sees it", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const first = await click(h, visitor, "about-you");
  const meta = first.events[0].data as Extract<ChatEvent, { type: "meta" }>;
  const rows = await db.sql<
    { id: string; role: string; text: string; category: string | null; intent: string | null; action: string; cost: number; timings: Record<string, number> | null; conversation_id: string }[]
  >`select id::text, role, text, category, intent, action, cost_usd::float8 as cost, timings, conversation_id from messages where visitor_id = ${visitor} order by id`;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0], timings: undefined },
    { id: meta.messageId, role: "visitor", text: "Tell me about yourself.", category: null, intent: "button:about-you", action: "fixed", cost: 0, timings: undefined, conversation_id: meta.conversationId },
  );
  assert.equal(typeof rows[0].timings?.total, "number");
  assert.equal(typeof rows[0].timings?.first_audio, "number");
  assert.deepEqual({ role: rows[1].role, text: rows[1].text, action: rows[1].action, conversation_id: rows[1].conversation_id }, { role: "assistant", text: BUTTONS[0].versions[0], action: "fixed", conversation_id: meta.conversationId });

  // A typed message continues in its own conversation; the next click goes in the latest one.
  const typed = await chat(h, visitor, "What did you build with Postgres?");
  const typedConversation = (typed.events[0].data as { conversationId: string }).conversationId;
  const second = await click(h, visitor, "start-date");
  assert.equal((second.events[0].data as { conversationId: string }).conversationId, typedConversation);
  // Naming a conversation of their own is honoured; someone else's isn't.
  const named = await click(h, visitor, "start-date", { conversationId: meta.conversationId });
  assert.equal((named.events[0].data as { conversationId: string }).conversationId, meta.conversationId);
  const stranger = await addVisitor(db.sql);
  const theirs = await click(h, stranger, "start-date", { conversationId: meta.conversationId });
  assert.notEqual((theirs.events[0].data as { conversationId: string }).conversationId, meta.conversationId);

  // The strike check's history includes what the buttons asked and answered.
  h.rig.calls.length = 0;
  await chat(h, visitor, "Anything else?");
  const asked = h.rig.calls.find((c) => c.stage === "strikeCheck")!.arg as { history: { role: string; text: string }[] };
  const texts = asked.history.map((t) => t.text);
  assert.ok(texts.includes("Tell me about yourself."));
  assert.ok(texts.includes(BUTTONS[0].versions[0]));
  assert.ok(texts.includes("When can you start?"));
  assert.ok(texts.includes("I'm available from January."));

  // A click is never a strike and never small talk.
  assert.equal((await db.sql`select 1 from strikes where visitor_id = ${visitor}`).length, 0);
  assert.equal((await db.sql`select 1 from small_talk_uses where visitor_id = ${visitor}`).length, 0);
  assert.equal((await db.sql`select strikes from visitors where id = ${visitor}`)[0].strikes, 0);
});

test("a sentence that isn't in the voice cache yet is voiced on the spot, with one line in the log and none of its text", async () => {
  const cacheDir = await mkdtemp(`${tmpdir()}/voice-cache-test-`);
  try {
    const requested: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const text = JSON.parse(String(init?.body)).text as string;
      requested.push(text);
      return Response.json({
        text,
        duration: 1,
        words: [{ text, start: 0, end: 1 }],
        visemes: [[0, "sil"]],
        audio: `LIVE(${text})`,
      });
    }) as typeof fetch;
    const logs: string[] = [];
    const speak = makeSpeaker({ modelsUrl: "http://models.test", cacheDir, timeoutMs: 2000, fetchImpl, log: (l) => logs.push(l) });
    const h = harness();
    h.rig.ctx.deps.speak = speak;
    const visitor = await addVisitor(db.sql);

    // The first version's sentences were voiced ahead of time (what npm run buttons -- voice does).
    for (const sentence of ["I'm Merlin.", "I build AI tools for experts."]) await speak(sentence, { cache: true });
    requested.length = 0;
    logs.length = 0;
    const ahead = await click(h, visitor, "about-you");
    assert.deepEqual(requested, [], "nothing was voiced: the cache had it");
    assert.equal(logs.length, 0, "and no cache miss was logged");
    assert.equal((ahead.events.filter((e) => e.data.type === "sentence")[0].data as { audio: string }).audio, "LIVE(I'm Merlin.)");

    // The second version wasn't: it's voiced now, and the reply still plays with audio.
    const miss = await click(h, visitor, "about-you");
    assert.deepEqual(requested, ["Hi, Merlin here.", "I like useful AI.", "It has to be right."]);
    const sentences = miss.events.filter((e) => e.data.type === "sentence").map((e) => e.data as Extract<ChatEvent, { type: "sentence" }>);
    assert.equal(sentences.length, 3);
    assert.ok(sentences.every((s) => s.audio === `LIVE(${s.text})`));
    assert.equal(logs.filter((l) => l.includes("cache miss")).length, 3, "one line per sentence");
    assert.ok(logs.every((l) => !l.includes("Merlin") && !l.includes("AI")), "never the text");

    // Played again (after a full cycle) it's all cached.
    await click(h, visitor, "about-you");
    requested.length = 0;
    const again = await click(h, visitor, "about-you");
    assert.deepEqual(requested, []);
    assert.equal(playedText(again.events), BUTTONS[0].versions[0]);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("a click is held to the request limiter and the stream rules: JSON only, a known origin", async () => {
  const h = harness({}, { requestLimits: { perIpPerMinute: 1000, perBrowserPerMinute: 4 } });
  const visitor = await addVisitor(db.sql);
  assert.equal((await call(h, "/api/instant", { body: { id: "about-you" }, visitor, contentType: "text/plain" })).status, 415);
  assert.equal((await call(h, "/api/instant", { body: { id: "about-you" }, visitor, origin: "https://evil.example" })).status, 403);
  // 2 requests used so far; 2 more are allowed, then 429.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await call(h, "/api/instant", { body: { id: "about-you" }, visitor })).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});


// ---- Email -------------------------------------------------------------------------------------

test("mail: through Resend when it's set up, the way Resend documents", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({ id: "abc" });
  }) as typeof fetch;
  const config: MailConfig = { apiKey: "re_test_key", to: "me@example.com", from: "Site <chat@example.com>", outboxDir: "/nonexistent/outbox" };
  const logs: string[] = [];
  const result = await sendMail({ subject: "Hello", text: "Body with secrets", replyTo: "ada@acme.example" }, config, impl, (l) => logs.push(l));
  assert.deepEqual(result, { via: "resend" });
  assert.equal(requests[0].url, "https://api.resend.com/emails");
  assert.equal(requests[0].init.method, "POST");
  const headers = requests[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer re_test_key");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), {
    from: "Site <chat@example.com>",
    to: "me@example.com",
    subject: "Hello",
    text: "Body with secrets",
    reply_to: "ada@acme.example",
  });
  assert.ok(!logs.join("\n").includes("secrets"), "the body isn't logged");
});

test("mail: a Resend error throws without the body; with no key it's saved in the outbox", async () => {
  const config: MailConfig = { apiKey: "re_test_key", to: "me@example.com", from: "Site <chat@example.com>", outboxDir: "/nonexistent/outbox" };
  const refusing = (async () => Response.json({ name: "validation_error", message: "The to field is invalid" }, { status: 422 })) as typeof fetch;
  await assert.rejects(
    sendMail({ subject: "S", text: "Private body" }, config, refusing, () => {}),
    (err: Error) => err.message === "Resend answered 422 (validation_error)" && !err.message.includes("Private body"),
  );

  const outbox = await mkdtemp(`${tmpdir()}/outbox-test-`);
  try {
    const logs: string[] = [];
    const never = (async () => {
      throw new Error("must not be called");
    }) as typeof fetch;
    for (const partial of [{ apiKey: undefined, to: "me@example.com" }, { apiKey: "key", to: undefined }]) {
      const result = await sendMail({ subject: "Handoff from Ada", text: "Line one\nLine two" }, { ...config, ...partial, outboxDir: `${outbox}/nested` }, never, (l) => logs.push(l));
      assert.equal(result.via, "outbox");
    }
    const files = await readdir(`${outbox}/nested`);
    assert.equal(files.length, 2);
    assert.match(files[0], /^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f]{12}\.txt$/, "a time and a random tag, nothing from the email");
    assert.ok(!files.some((f) => /ada|handoff/i.test(f)));
    const saved = await readFile(`${outbox}/nested/${files[0]}`, "utf8");
    assert.match(saved, /^Subject: Handoff from Ada\n\nLine one\nLine two/);
    assert.equal(logs.length, 2, "one line each, saying where");
    assert.ok(logs.every((l) => l.startsWith("mail: saved to ") && !l.includes("Line one") && !/ada/i.test(l)));
  } finally {
    await rm(outbox, { recursive: true, force: true });
  }
});

test("the outbox purge removes only emails older than 12 months", async () => {
  const outbox = await mkdtemp(`${tmpdir()}/outbox-test-`);
  try {
    const { utimes, writeFile } = await import("node:fs/promises");
    await writeFile(`${outbox}/old.txt`, "old");
    await writeFile(`${outbox}/recent.txt`, "recent");
    await writeFile(`${outbox}/notes.md`, "not an email file");
    const longAgo = new Date(Date.now() - 400 * 86_400_000);
    await utimes(`${outbox}/old.txt`, longAgo, longAgo);
    await utimes(`${outbox}/notes.md`, longAgo, longAgo);
    assert.equal(await purgeOutbox(outbox, 12), 1);
    assert.deepEqual((await readdir(outbox)).sort(), ["notes.md", "recent.txt"]);
    assert.equal(await purgeOutbox(`${outbox}/nowhere`, 12), 0, "no outbox yet is fine");
  } finally {
    await rm(outbox, { recursive: true, force: true });
  }
});

// ---- Security review: input cleaning, limits, origins, stalled clients ---------------------------

test("control characters are stripped from every field a visitor sends", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const { events } = await chat(h, visitor, "Hi\u0000 there\u0007", { jobPost: "Job\u0000 post", conversationId: "\u0000" });
  assert.equal((events.at(-1)!.data as { kind: string }).kind, "answer", "a NUL doesn't break the reply");
  const [row] = await db.sql<{ text: string; job_post: string }[]>`select text, job_post from messages where visitor_id = ${visitor} and role = 'visitor'`;
  assert.deepEqual({ ...row }, { text: "Hi there", job_post: "Job post" });
  assert.equal((await call(h, "/api/chat", { body: { message: "\u0000\u0007" }, visitor, ip: visitor })).status, 400, "nothing left after cleaning");

  const handoff = await call(h, "/api/handoff", {
    body: form({ name: "Ada\u0000 Recruiter", company: "Ac\u0000me", email: "ada@acme.example\u0000", message: "Hello\u0000 there", turnstileToken: "good-token\u0000" }),
    visitor,
  });
  assert.equal(handoff.status, 200);
  const [saved] = await db.sql<{ name: string; company: string; email: string; note: string }[]>`select name, company, email, note from handoffs where visitor_id = ${visitor}`;
  assert.deepEqual({ ...saved }, { name: "Ada Recruiter", company: "Acme", email: "ada@acme.example", note: "Hello there" });
  const clicked = await call(h, "/api/instant", { body: { id: "about-you\u0000" }, visitor, ip: visitor });
  assert.equal(clicked.status, 200, "cleaned, then known");
  assert.equal((parseSse(await clicked.text()).events.at(-1)!.data as { kind: string }).kind, "fixed");
});

test("a flood is turned away from memory: per address and per browser, with 429 and Retry-After", async () => {
  const h = harness({}, { requestLimits: { perIpPerMinute: 5, perBrowserPerMinute: 3 } });
  // GET /api/visitor without a cookie answers 401, but still counts toward the address's allowance.
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await call(h, "/api/visitor", { ip: "198.51.100.200" })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429]);
  const refused = await call(h, "/api/visitor", { ip: "198.51.100.200" });
  assert.deepEqual(await refused.json(), { error: "too many requests" });
  assert.match(refused.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(refused.headers.get("cache-control"), "no-store");
  assert.equal((await call(h, "/api/visitor", { ip: "198.51.100.201" })).status, 401, "another address has its own count");
  for (const ip of ["2001:db8:0:5::1", "2001:db8:0:5:ffff::9", "2001:db8:0:5::77", "2001:db8:0:5:1::2", "2001:db8:0:5::3"]) {
    assert.equal((await call(h, "/api/visitor", { ip })).status, 401);
  }
  assert.equal((await call(h, "/api/visitor", { ip: "2001:db8:0:5::4" })).status, 429, "one IPv6 /64 is one address");

  // Health has its own allowance, four times the rest, so open pages polling it don't use up an
  // office's address; the flooded address above can still ask for it.
  const health: number[] = [];
  for (let i = 0; i < 21; i++) health.push((await call(h, "/api/health", { ip: "198.51.100.200" })).status);
  assert.deepEqual(health, [...Array(20).fill(200), 429]);

  // A browser is limited by its own cookie, whatever address it comes from.
  const visitor = await addVisitor(db.sql);
  const mine: number[] = [];
  for (let i = 0; i < 5; i++) mine.push((await call(h, "/api/visitor", { visitor, ip: `192.0.2.${i + 1}` })).status);
  assert.deepEqual(mine, [200, 200, 200, 429, 429]);

  // Requests without the secret don't use anyone's allowance, and a refused flood does no database work.
  for (let i = 0; i < 20; i++) assert.equal((await call(h, "/api/health", { ip: "198.51.100.202", secret: false })).status, 403);
  assert.equal((await call(h, "/api/health", { ip: "198.51.100.202" })).status, 200);
  const flooder = await addVisitor(db.sql);
  for (let i = 0; i < 20; i++) await call(h, "/api/chat", { body: { message: "hi" }, visitor: flooder, ip: "203.0.113.99" });
  const [{ n }] = await db.sql<{ n: number }[]>`select count(*)::int as n from conversations where visitor_id = ${flooder}`;
  assert.ok(n <= 3, `at most 3 chats got as far as the database (${n})`);
});

test("the request counter keeps one window a minute per key and forgets old ones", () => {
  let now = 1_000_000;
  const count = makeRequestCounter(() => now);
  assert.equal(count("a", 2), 0);
  assert.equal(count("a", 2), 0);
  assert.ok(count("a", 2) > 0, "the third in the window is refused");
  assert.equal(count("b", 2), 0, "keys are separate");
  now += 59_000;
  assert.ok(count("a", 2) >= 1);
  now += 1_500;
  assert.equal(count("a", 2), 0, "a new window");
  now += 120_000;
  assert.equal(count("c", 2), 0);
});

test("POST routes want JSON and, if the browser names its site, an allowed one", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const body = { message: "Hello" };
  const post = (o: CallOptions) => call(h, "/api/chat", { body, visitor, ip: visitor, ...o });

  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
    const res = await post({ contentType });
    assert.equal(res.status, 415, JSON.stringify(contentType));
    assert.equal(h.rig.calls.length, 0, "nothing ran");
  }
  assert.equal((await post({ contentType: "application/json; charset=utf-8" })).status, 200);
  assert.equal((await post({ contentType: "Application/JSON" })).status, 200);

  assert.equal((await post({})).status, 200, "no Origin (curl, the red team) is fine");
  assert.equal((await post({ origin: "https://merlinyang.com" })).status, 200);
  assert.equal((await post({ origin: "https://merlinyang.com/" })).status, 200);
  assert.equal((await post({ origin: "http://localhost:4321" })).status, 200);
  for (const origin of ["https://evil.example", "http://merlinyang.com", "https://merlinyang.com.evil.example", "null", ""]) {
    const res = await post({ origin });
    assert.equal(res.status, 403, JSON.stringify(origin));
    assert.deepEqual(await res.json(), { error: "origin not allowed" });
  }
  assert.equal((await call(h, "/api/visitor", { body: { turnstileToken: "good-token" }, origin: "https://evil.example" })).status, 403);
  assert.equal((await call(h, "/api/health", { origin: "https://evil.example" })).status, 200, "reading isn't a form post");
});

test("a client that stops reading its stream is dropped, freeing its place and its voice slot", async () => {
  const h = harness({}, { emitTimeoutMs: 80 }, { voicedAtOnce: 1 });
  h.rig.speakImpl = async (text) => ({ text, audio: "A".repeat(4_000_000), duration: 1, words: null, visemes: null });
  const visitor = await addVisitor(db.sql);
  const res = await call(h, "/api/chat", { body: { message: "What did you build?" }, visitor, ip: visitor });
  assert.equal(res.status, 200);
  // Nobody reads res.body, so the stream backs up and a write stalls.
  for (let i = 0; i < 100 && !h.logs.some((l) => l.includes("stopped reading")); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(h.logs.some((l) => l.includes("stopped reading")), "the stalled write was noticed");

  const slot = await Promise.race([h.rig.ctx.voice.acquire(), new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
  assert.ok(slot, "the voice slot is free again");
  slot?.();
  h.rig.speakImpl = async (text) => ({ text, audio: "A", duration: 1, words: null, visemes: null });
  const next = await chat(h, visitor, "Hello again");
  assert.equal((next.events.at(-1)!.data as { kind: string }).kind, "answer", "and so is the browser's place");
  await res.body?.cancel().catch(() => {});
});

// ---- Handoff and the spending cap ---------------------------------------------------------------

test("over the month's spending cap the handoff is still saved and emailed, just without the AI summary", async () => {
  const h = harness();
  const visitor = await addVisitor(db.sql);
  const first = await call(h, "/api/chat", { body: { message: "What did you build?" }, visitor, ip: visitor });
  const conversationId = (parseSse(await first.text()).events[0].data as { conversationId: string }).conversationId;
  // The month's spending reaches the cap after the chat.
  h.rig.ctx.gate = (await import("../src/chat/gate.ts")).makeGate({
    sql: db.sql,
    limits: { ...h.rig.ctx.gate.limits, spendCapUsd: 0 },
    mail: async () => {},
    log: () => {},
  });
  const res = await call(h, "/api/handoff", { body: form({ conversationId }), visitor });
  assert.equal(res.status, 200);
  assert.equal(h.summarized.length, 0, "no summary was asked for");
  assert.match(h.sent[0].text, /spending cap has been reached/);
  assert.match(h.sent[0].text, /What did you build\?/, "the transcript is still there");
  const [row] = await db.sql<{ summary: string | null; cost: number; emailed_at: Date | null }[]>`select summary, cost_usd::float8 as cost, emailed_at from handoffs where visitor_id = ${visitor}`;
  assert.deepEqual({ summary: row.summary, cost: row.cost, emailed: row.emailed_at !== null }, { summary: null, cost: 0, emailed: true });
});

test("a handoff summary that failed after the API answered is still counted, and the handoff records its address", async () => {
  const billed = { model: "claude-haiku-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0009 };
  const h = harness({
    summarize: async () => {
      throw Object.assign(new Error("ran out of tokens"), { usage: billed });
    },
  });
  const visitor = await addVisitor(db.sql);
  const first = await call(h, "/api/chat", { body: { message: "hi" }, visitor, ip: visitor });
  const conversationId = (parseSse(await first.text()).events[0].data as { conversationId: string }).conversationId;
  const res = await call(h, "/api/handoff", { body: form({ conversationId }), visitor, ip: "203.0.113.44" });
  assert.equal(res.status, 200);
  const [row] = await db.sql<{ cost: number; ip_hash: string }[]>`select cost_usd::float8 as cost, ip_hash from handoffs where visitor_id = ${visitor}`;
  assert.equal(row.cost, 0.0009);
  assert.equal(row.ip_hash, hashIp("203.0.113.44", SALT));
});

test("a handoff email that fails is a loud line in the log, with no details in it", async () => {
  const h = harness();
  h.state.mailFails = true;
  const visitor = await addVisitor(db.sql);
  assert.equal((await call(h, "/api/handoff", { body: form(), visitor })).status, 200);
  const alert = h.logs.find((l) => l.includes("ALERT"));
  assert.ok(alert?.startsWith("!!"));
  assert.ok(alert && !alert.includes("Ada") && !alert.includes("ada@acme") && !alert.includes("backend role"));
});

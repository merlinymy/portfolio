/**
 * The chat backend's routes (docs/phase-5-chat-plan.md): health, visitor, chat (a stream of
 * server-sent events), handoff and instant clicks. Everything the app needs is handed in as an
 * AppContext, so tests can run it with stand-ins through `app.request()` and no network.
 *
 * Every /api route first checks the secret header the Cloudflare Worker adds; without it the answer
 * is 403 and an empty body, so the tunnel's address is useless on its own. That header is also what
 * makes `x-real-ip` (the visitor's address, set by the Worker) trustworthy.
 */
import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { ChatEvent } from "@portfolio/shared/chat";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  conversationMessages,
  createVisitor,
  getConversation,
  getVisitor,
  insertHandoff,
  insertInstantClick,
  setHandoffEmailResult,
  setHandoffSummary,
  unlockIfExpired,
  visitorStatus,
} from "./db/chat.ts";
import type { VisitorRow } from "./db/chat.ts";
import type { Sql } from "./db/client.ts";
import { hashIp, isUuid, normalizeIp, safeEqual, signVisitor, stripControl, verifyTurnstile, verifyVisitor } from "./identity.ts";
import type { Mail } from "./mail.ts";
import { failedCallUsage, handleMessage } from "./chat/pipeline.ts";
import type { PipelineContext } from "./chat/pipeline.ts";
import { ERROR } from "./chat/replies.ts";
import type { Turn, Usage } from "./chat/types.ts";

export interface AppConfig {
  /** The secret the Worker sends in x-origin-secret. */
  originSecret: string;
  /** Signs the visitor cookie. */
  cookieSecret: string;
  /** Scrambles IP addresses before they're stored. */
  ipSalt: string;
  turnstileSecret: string;
  /** Handoff forms one browser may send in a day. */
  handoffPerDay: number;
  /** The model server, for the health check. */
  modelsUrl: string;
  /** How often an idle stream gets a comment line, so proxies keep it open. */
  keepAliveMs: number;
  /** How long each part of the health check may take. */
  healthTimeoutMs: number;
  /** Requests a minute before a 429, counted in memory before any database work (security review). */
  requestLimits: { perIpPerMinute: number; perBrowserPerMinute: number };
  /** The sites a browser may call POST routes from (the Origin header, when there is one). */
  allowedOrigins: string[];
  /** How long one write to a chat stream may take before the visitor is taken as gone. */
  emitTimeoutMs: number;
}

export interface AppContext {
  sql: Sql;
  pipeline: PipelineContext;
  config: AppConfig;
  /** The two-line summary of a conversation for the handoff email (summary.ts). */
  summarize(turns: Turn[]): Promise<{ text: string; usage: Usage }>;
  /** Sends you an email, or saves it to the outbox (mail.ts). */
  mail(mail: Mail): Promise<unknown>;
  /** Whether an Anthropic key is set, shown by the health check. */
  claudeConfigured(): boolean;
  /** For Turnstile and the health check; tests stub it. */
  fetch?: typeof fetch;
  log: (line: string) => void;
}

const COOKIE = "mv";
const YEAR = 60 * 60 * 24 * 365;

// Far above the real limits (1,000 and 6,000 characters), which the gate answers politely; these
// only turn away absurd bodies before they're read in full.
const MESSAGE_CEILING = 10_000;
const JOB_POST_CEILING = 50_000;

/** Control characters out of any text a visitor sends (a NUL would make Postgres refuse the row). */
const strip = (value: unknown) => (typeof value === "string" ? stripControl(value) : value);
/** An optional field: cleaned, trimmed, and treated as missing when left empty. */
const tidy = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = stripControl(value).trim();
  return text === "" ? undefined : text;
};
const required = (max: number) => z.preprocess(strip, z.string().trim().min(1).max(max));
const optional = (max: number) => z.preprocess(tidy, z.string().max(max).optional());

const chatBody = z.object({
  message: required(MESSAGE_CEILING),
  jobPost: optional(JOB_POST_CEILING),
  conversationId: optional(64),
});

const visitorBody = z.object({ turnstileToken: z.preprocess(strip, z.string().min(1).max(2048)) });

const handoffBody = z.object({
  name: required(100),
  company: optional(100),
  email: z.preprocess(strip, z.string().trim().max(254).pipe(z.email())),
  roleLink: z.preprocess(tidy, z.url({ protocol: /^https?$/ }).max(500).optional()),
  message: required(2000),
  conversationId: optional(64),
  turnstileToken: z.preprocess(strip, z.string().min(1).max(2048)),
});

const instantBody = z.object({
  id: required(100),
  conversationId: optional(64),
});

/** Rejects (and so reports "not ok") if the work takes longer than `ms`. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * A count of requests per key in a one-minute window, kept in memory so a flood is turned away
 * before it costs any database work. Returns 0 if the request may go on, else how many seconds
 * until the window ends.
 */
export function makeRequestCounter(now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  let swept = now();
  return (key: string, max: number): number => {
    const at = now();
    if (at - swept >= 60_000) {
      for (const [k, w] of windows) if (at - w.start >= 60_000) windows.delete(k);
      swept = at;
    }
    const w = windows.get(key);
    if (!w || at - w.start >= 60_000) {
      windows.set(key, { start: at, count: 1 });
      return 0;
    }
    if (w.count >= max) return Math.max(1, Math.ceil((60_000 - (at - w.start)) / 1000));
    w.count++;
    return 0;
  };
}

export function createApp(ctx: AppContext): Hono {
  const { sql, config, pipeline } = ctx;
  const fetchImpl = ctx.fetch ?? fetch;
  const app = new Hono();

  /** The visitor's address: the Worker's header, or the socket when run directly in development. */
  const clientIp = (c: Context): string => {
    const forwarded = c.req.header("x-real-ip")?.trim();
    if (forwarded) return forwarded;
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  const visitorFromCookie = async (c: Context): Promise<VisitorRow | null> => {
    const id = verifyVisitor(getCookie(c, COOKIE), config.cookieSecret);
    return id ? ((await getVisitor(sql, id)) ?? null) : null;
  };

  const giveCookie = (c: Context, visitorId: string) =>
    setCookie(c, COOKIE, signVisitor(visitorId, config.cookieSecret), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api",
      maxAge: YEAR,
    });

  async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | null> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return null;
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  const badRequest = (c: Context) => c.json({ error: "bad request" }, 400);
  const noVisitor = (c: Context) => c.json({ error: "no visitor" }, 401);

  const count = makeRequestCounter();
  const origins = new Set(config.allowedOrigins.map((o) => o.trim().toLowerCase().replace(/\/$/, "")));

  // The secret header comes first on everything (plan §7.1 step 1).
  app.use("/api/*", async (c, next) => {
    const sent = c.req.header("x-origin-secret");
    if (!config.originSecret || !sent || !safeEqual(sent, config.originSecret)) return c.body(null, 403);
    await next();
  });
  // Nothing here is for a cache to keep: a browser's standing and a health check change by the minute.
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });
  // A flood is turned away here, from memory, before any database work: per address and per browser.
  // Every open page asks for health once a minute, so an office of recruiters behind one address would
  // use up the address's count on that alone; health gets its own, four times larger.
  app.use("/api/*", async (c, next) => {
    const id = verifyVisitor(getCookie(c, COOKIE), config.cookieSecret);
    const ip = normalizeIp(clientIp(c));
    const health = c.req.path === "/api/health";
    const wait = Math.max(
      health
        ? count(`health-ip:${ip}`, config.requestLimits.perIpPerMinute * 4)
        : count(`ip:${ip}`, config.requestLimits.perIpPerMinute),
      id ? count(`browser:${id}`, config.requestLimits.perBrowserPerMinute) : 0,
    );
    if (wait > 0) {
      c.header("retry-after", String(wait));
      return c.json({ error: "too many requests" }, 429);
    }
    await next();
  });
  // A page on another site can make a browser send a form post with its cookies; JSON bodies and a
  // known Origin rule that out. Requests with no Origin (curl, the red team) already hold the secret.
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "POST") {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "send JSON" }, 415);
      const origin = c.req.header("origin");
      if (origin !== undefined && !origins.has(origin.trim().toLowerCase().replace(/\/$/, ""))) return c.json({ error: "origin not allowed" }, 403);
    }
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 200 * 1024, onError: (c) => c.json({ error: "too large" }, 413) }));

  app.onError((err, c) => {
    ctx.log(`api: ${c.req.method} ${new URL(c.req.url).pathname} failed (${err.name}: ${err.message.slice(0, 160)})`);
    return c.json({ error: "server error" }, 500);
  });

  // ---- Health (plan §7.8): the page puts the face to sleep on a 503 or no answer in 4 s. ----
  app.get("/api/health", async (c) => {
    const ms = config.healthTimeoutMs;
    const [db, models] = await Promise.all([
      within(Promise.resolve(sql`select 1`), ms).then(
        () => true,
        () => false,
      ),
      within(
        fetchImpl(`${config.modelsUrl}/health`, { signal: AbortSignal.timeout(ms) }).then(async (res) => res.ok && ((await res.json()) as { ok?: unknown }).ok === true),
        ms,
      ).catch(() => false),
    ]);
    const ok = db && models;
    // claude: false doesn't make the server unhealthy: instant answers and the contact form still work.
    return c.json({ ok, db, models, claude: ctx.claudeConfigured() }, ok ? 200 : 503);
  });

  // ---- Visitor (plan §7.2) ----
  app.post("/api/visitor", async (c) => {
    // A browser that already has a valid cookie keeps it: minting another would be a way around a lock.
    const existing = await visitorFromCookie(c);
    if (existing) {
      await unlockIfExpired(sql, existing.id);
      giveCookie(c, existing.id);
      return c.json(visitorStatus((await getVisitor(sql, existing.id)) ?? existing));
    }
    const body = await readJson(c, visitorBody);
    if (!body) return badRequest(c);
    const ip = clientIp(c);
    const person = await verifyTurnstile(body.turnstileToken, ip, config.turnstileSecret, fetchImpl);
    if (!person) return c.json({ error: "turnstile" }, 403);
    const id = randomUUID();
    if (!(await createVisitor(sql, id, hashIp(ip, config.ipSalt), pipeline.gate.limits.newVisitorsPerIpHour))) {
      return c.json({ error: "too many new browsers from this address" }, 429);
    }
    giveCookie(c, id);
    return c.json(visitorStatus({ strikes: 0, lockedUntil: null }));
  });

  app.get("/api/visitor", async (c) => {
    const visitor = await visitorFromCookie(c);
    if (!visitor) return noVisitor(c);
    await unlockIfExpired(sql, visitor.id);
    return c.json(visitorStatus((await getVisitor(sql, visitor.id)) ?? visitor));
  });

  // ---- Chat: one reply as a stream of server-sent events (plan §7.1) ----
  app.post("/api/chat", async (c) => {
    const visitor = await visitorFromCookie(c);
    if (!visitor) return noVisitor(c);
    const body = await readJson(c, chatBody);
    if (!body) return badRequest(c);
    const ipHash = hashIp(clientIp(c), config.ipSalt);

    return streamSSE(c, async (stream) => {
      const left = new AbortController();
      stream.onAbort(() => left.abort());
      // A comment line every so often keeps the stream open through proxies while a reply is made.
      const keepAlive = setInterval(() => {
        stream.write(": keep-alive\n\n").catch(() => {});
      }, config.keepAliveMs);

      let finished = false;
      const emit = async (event: ChatEvent) => {
        if (stream.aborted) throw new Error("the stream is closed");
        if (event.type === "done") finished = true;
        // A client that stops reading would hold this message's place (and a voice slot) for ever:
        // if a write takes too long the visitor is treated as gone and the stream is dropped.
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctx.log("chat: a client stopped reading its stream; dropped");
            stream.abort();
            reject(new Error("the visitor stopped reading"));
          }, config.emitTimeoutMs);
        });
        try {
          await Promise.race([stream.writeSSE({ event: event.type, data: JSON.stringify(event) }), stalled]);
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        const result = await handleMessage(
          pipeline,
          { visitorId: visitor.id, ipHash, message: body.message, jobPost: body.jobPost, conversationId: body.conversationId },
          emit,
          { signal: left.signal },
        );
        // One line a message: how it was handled, how long it took, what it cost. Never the text.
        ctx.log(`chat: ${result.kind} category=${result.category ?? "-"} total=${result.timings.total ?? 0}ms cost=$${result.costUsd.toFixed(4)}`);
      } catch (err) {
        ctx.log(`chat: failed (${err instanceof Error ? `${err.name}: ${err.message.slice(0, 160)}` : "error"})`);
        // The stream has started, so the page is told with the fixed apology rather than a status code.
        if (!finished && !left.signal.aborted) await emit({ type: "done", kind: "error", text: ERROR }).catch(() => {});
      } finally {
        clearInterval(keepAlive);
      }
    });
  });

  // ---- Handoff (plan §7.5): the Contact form's details, emailed to you ----
  app.post("/api/handoff", async (c) => {
    const visitor = await visitorFromCookie(c);
    if (!visitor) return noVisitor(c);
    const body = await readJson(c, handoffBody);
    if (!body) return badRequest(c);
    const ip = clientIp(c);
    const person = await verifyTurnstile(body.turnstileToken, ip, config.turnstileSecret, fetchImpl);
    if (!person) return c.json({ error: "turnstile" }, 403);

    const conversation = isUuid(body.conversationId) ? await getConversation(sql, body.conversationId, visitor.id) : undefined;
    const id = await insertHandoff(
      sql,
      {
        visitorId: visitor.id,
        ipHash: hashIp(ip, config.ipSalt),
        conversationId: conversation?.id ?? null,
        name: body.name,
        company: body.company ?? null,
        email: body.email,
        roleLink: body.roleLink ?? null,
        note: body.message,
      },
      config.handoffPerDay,
    );
    if (id === null) return c.json({ error: "limit" }, 429);

    const transcript = conversation ? await conversationMessages(sql, conversation.id) : [];
    const turns: Turn[] = transcript.filter((m) => m.action !== "gate").map((m) => ({ role: m.role, text: m.text }));
    let summary: string | null = null;
    let skipped = false;
    let cost = 0;
    if (turns.length > 0) {
      // Over the month's spending cap the details are still saved and emailed, just without the AI summary.
      skipped = await pipeline.gate.overCap();
      if (!skipped) {
        try {
          const written = await ctx.summarize(turns);
          summary = written.text.trim() || null;
          cost = written.usage.costUsd;
        } catch (err) {
          // A call that failed after the API answered was still billed.
          cost = failedCallUsage(err)?.costUsd ?? 0;
          ctx.log(`handoff: couldn't write the summary (${err instanceof Error ? err.message.slice(0, 160) : "error"})`);
        }
      }
    }
    await setHandoffSummary(sql, id, summary, cost);

    const who = oneLine(body.company ? `${body.name} (${body.company})` : body.name);
    const lines = [
      `${who} used the Contact form on your site.`,
      "",
      `Name: ${body.name}`,
      `Company: ${body.company ?? "-"}`,
      `Email: ${body.email}`,
      `Role link: ${body.roleLink ?? "-"}`,
      "",
      "Their message:",
      body.message,
      "",
      "Summary of their chat:",
      conversation
        ? (summary ??
          (skipped
            ? "(not written: this month's spending cap has been reached)"
            : turns.length === 0
              ? "(no answered messages to summarize)"
              : "(no summary: it couldn't be written)"))
        : "(they didn't chat first)",
      "",
      "Full transcript:",
      ...(transcript.length === 0
        ? ["(none)"]
        : transcript.flatMap((m) => [
            `[${m.createdAt.toISOString()}] ${m.role === "visitor" ? "Visitor" : "AI Merlin"}${m.action && m.role === "assistant" ? ` (${m.action})` : ""}:`,
            ...(m.jobPostLength ? [`(pasted a job posting, ${m.jobPostLength} characters)`] : []),
            m.text,
            "",
          ])),
    ];
    try {
      await ctx.mail({ subject: `Handoff from ${who}`, text: lines.join("\n"), replyTo: body.email });
      await setHandoffEmailResult(sql, id, null);
    } catch (err) {
      // The visitor's details are saved, so they're told ok; the row records that the email failed.
      const why = err instanceof Error ? err.message : "error";
      ctx.log(`!! ALERT: a handoff email FAILED (${why.slice(0, 160)}); the visitor's details are saved: npm run transcripts, or the handoffs table`);
      await setHandoffEmailResult(sql, id, why.slice(0, 500));
    }
    return c.json({ ok: true });
  });

  // ---- Instant-answer clicks (plan §7.11): logged only ----
  app.post("/api/instant", async (c) => {
    const visitor = await visitorFromCookie(c);
    if (!visitor) return noVisitor(c);
    const body = await readJson(c, instantBody);
    if (!body) return badRequest(c);
    // Only the chips that exist (content/instant.yaml) can be clicked.
    if (!pipeline.deps.fixed.entries.some((e) => e.kind === "instant" && e.id === body.id)) return badRequest(c);
    const conversation = isUuid(body.conversationId) ? await getConversation(sql, body.conversationId, visitor.id) : undefined;
    await insertInstantClick(sql, visitor.id, conversation?.id ?? null, body.id);
    return c.body(null, 204);
  });

  return app;
}

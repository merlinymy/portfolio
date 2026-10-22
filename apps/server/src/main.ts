/**
 * npm run api: starts the chat backend (docs/phase-5-chat-plan.md).
 *
 * Brings the database up to date, loads your approved answers, and serves on API_HOST:API_PORT
 * (127.0.0.1:8791 by default; Docker sets API_HOST to 0.0.0.0). It needs `npm run db` and
 * `npm run voice` running. Without ANTHROPIC_API_KEY it still starts: the health check says
 * "claude": false, and a message that needs Claude gets the fixed apology.
 *
 * It logs one line per message (how it was handled, how long it took, what it cost) and never a
 * message's text or an IP address. Conversations and handoffs older than 12 months are deleted at
 * start and every 24 hours (plan §7.6).
 */
import { mkdir } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { purgeOld } from "./db/chat.ts";
import { connect } from "./db/client.ts";
import { migrate } from "./db/migrate.ts";
import { ROOT, setting } from "./env.ts";
import { checkSettings } from "./identity.ts";
import { purgeOutbox, sendMail } from "./mail.ts";
import { buildChat } from "./wiring.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// Secrets that are too short sign nothing worth trusting: refuse to start rather than run weakly.
const settings = checkSettings();
for (const warning of settings.warnings) log(`!! WARNING: ${warning}`);
if (settings.errors.length > 0) {
  for (const error of settings.errors) log(`!! ${error}`);
  log("!! The api won't start until those are fixed in .env.");
  process.exit(1);
}

// Where files are written. Made now so a missing or read-only folder shows up at start, not on the first handoff.
for (const dir of [`${ROOT}knowledge/outbox`, `${ROOT}knowledge/cache/voice`]) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    log(`!! WARNING: can't write to ${dir.slice(ROOT.length)} (${err instanceof Error ? err.message : "error"}): handoff emails or the voice cache won't be saved there`);
  }
}

const sql = connect();
const ran = await migrate(sql);
if (ran.length) log(`database updated: ${ran.join(", ")}`);

const chat = await buildChat({ sql, log }).catch((err: unknown) => {
  // A file in knowledge/ that can't be read says which one and what's wrong; no stack trace needed.
  log(`!! The api can't start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
const modelsUrl = setting("MODELS_URL", "http://127.0.0.1:8790");

const app = createApp({
  sql,
  pipeline: chat.pipeline,
  buttons: chat.buttons,
  config: {
    originSecret: setting("ORIGIN_SECRET"),
    cookieSecret: setting("COOKIE_SECRET"),
    ipSalt: setting("IP_SALT"),
    turnstileSecret: setting("TURNSTILE_SECRET"),
    handoffPerDay: 2,
    modelsUrl,
    keepAliveMs: 15_000,
    healthTimeoutMs: 2_500,
    requestLimits: { perIpPerMinute: 30, perBrowserPerMinute: 15 },
    allowedOrigins: setting(
      "ALLOWED_ORIGINS",
      "https://merlinyang.com,https://www.merlinyang.com,https://merlinyang.lordhorcrux.workers.dev,http://localhost:4321,http://127.0.0.1:4321",
    ).split(","),
    emitTimeoutMs: 10_000,
  },
  summarize: chat.summarize,
  mail: (mail) => sendMail(mail, undefined, undefined, log),
  claudeConfigured: chat.claudeConfigured,
  log,
});

async function purge(): Promise<void> {
  try {
    const gone = await purgeOld(sql);
    const files = await purgeOutbox(`${ROOT}knowledge/outbox`);
    if (gone.conversations || gone.handoffs || gone.clicks || gone.visitors || files) {
      log(
        `purged ${gone.conversations} conversations, ${gone.handoffs} handoffs, ${gone.clicks} instant clicks, ` +
          `${gone.visitors} browsers and ${files} outbox files older than 12 months`,
      );
    }
  } catch (err) {
    log(`purge failed (${err instanceof Error ? err.message : "error"})`);
  }
}
await purge();
const daily = setInterval(purge, 24 * 60 * 60 * 1000);

const server = serve({ fetch: app.fetch, hostname: setting("API_HOST", "127.0.0.1"), port: Number(setting("API_PORT", "8791")) }, (info) => {
  log(`api listening on http://${info.address}:${info.port}${chat.claudeConfigured() ? "" : " (no ANTHROPIC_API_KEY: messages that need Claude get the apology)"}`);
});

// The tunnel keeps connections open longer than Node's 5 seconds, and a request on a connection
// Node has just closed fails; so Node waits longer than the tunnel does.
if ("keepAliveTimeout" in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

function stop(): void {
  clearInterval(daily);
  server.close();
  // Streams still open would hold the server up; give the database a moment to finish, then go.
  sql.end({ timeout: 5 }).finally(() => process.exit(0));
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

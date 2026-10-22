/**
 * The gate (src/chat/gate.ts) and the database functions behind it (src/db/chat.ts), against a
 * throwaway Postgres database: the order of the checks, each limit, lock expiry, strikes counted
 * correctly when two arrive at once, and the one-a-month spending email.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  claimSpendAlert,
  createConversation,
  createVisitor,
  getVisitor,
  insertHandoff,
  ipSpendSince,
  latestConversation,
  latestRiskNote,
  listStrikes,
  purgeOld,
  recordButtonClick,
  recentConversations,
  recentTimings,
  recentTurns,
  recordStrike,
  refusedCategories,
  revokeStrike,
  saveMessage,
  setRiskNote,
  takeSmallTalk,
  unlockIfExpired,
  unlockVisitor,
} from "../src/db/chat.ts";
import { makeGate } from "../src/chat/gate.ts";
import type { GateLimits } from "../src/chat/gate.ts";
import { GATE } from "../src/chat/replies.ts";
import { percentile, stageStats } from "../src/scripts/speed.ts";
import { addMessage, addVisitor, createTestDb } from "./helpers/db.ts";
import type { TestDb } from "./helpers/db.ts";

const LIMITS: GateLimits = {
  maxMessage: 1000,
  maxJobPost: 6000,
  perBrowser5min: 10,
  perBrowserDay: 60,
  perIp10min: 30,
  newVisitorsPerIpHour: 5,
  spendCapUsd: 18,
  perIpDayUsd: 2,
};

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.drop();
});

function setup(limits: Partial<GateLimits> = {}, now?: () => Date) {
  const emails: { subject: string; text: string }[] = [];
  const gate = makeGate({
    sql: db.sql,
    limits: { ...LIMITS, ...limits },
    mail: async (m) => void emails.push(m),
    now,
    log: () => {},
  });
  return { gate, emails };
}

const input = (visitorId: string, ipHash: string, message = "Hello", jobPost: string | null = null) => ({ visitorId, ipHash, message, jobPost });

async function reasonOf(result: Awaited<ReturnType<ReturnType<typeof setup>["gate"]["check"]>>) {
  if (result.ok) {
    result.release();
    return "ok";
  }
  assert.equal(result.text, GATE[result.reason], "the reply is the fixed text for that reason");
  return result.reason;
}

/** A message from this browser that earned a strike, saved the way the pipeline does. */
async function strikeOnce(visitorId: string, ipHash: string, conversationId: string) {
  return recordStrike(db.sql, {
    message: { conversationId, visitorId, ipHash, role: "visitor", text: "a rude message", action: "strike", category: "abuse" },
    category: "abuse",
    reason: "test",
  });
}

test("a normal message passes", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-a"))), "ok");
});

test("the checks run in order: locked, then length, then rate limits, then spending", async () => {
  const { gate } = setup({ spendCapUsd: 1, perIpDayUsd: 1e9 });
  const ip = "ip-order";
  const visitor = await addVisitor(db.sql, ip);
  // Everything is wrong at once: locked, too long, too fast, over the spending cap.
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '5 days' where id = ${visitor}`;
  for (let i = 0; i < 10; i++) await addMessage(db.sql, { visitorId: visitor, ipHash: ip, secondsAgo: 30, costUsd: 1 });
  const tooLong = "x".repeat(1001);

  assert.equal(await reasonOf(await gate.check(input(visitor, ip, tooLong))), "locked");
  await db.sql`update visitors set strikes = 0, locked_until = null where id = ${visitor}`;
  assert.equal(await reasonOf(await gate.check(input(visitor, ip, tooLong))), "tooLong");
  assert.equal(await reasonOf(await gate.check(input(visitor, ip))), "tooFast");
  await db.sql`update messages set created_at = now() - interval '1 hour' where visitor_id = ${visitor}`;
  assert.equal(await reasonOf(await gate.check(input(visitor, ip))), "spendCap");
});

test("message and job posting lengths", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-len", "x".repeat(1000)))), "ok");
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-len", "x".repeat(1001)))), "tooLong");
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-len", "Hi", "y".repeat(6000)))), "ok");
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-len", "Hi", "y".repeat(6001)))), "jobPostTooLong");
});

test("10 messages in 5 minutes per browser", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  for (let i = 0; i < 9; i++) await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-5", secondsAgo: 60 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-5"))), "ok", "the 10th is allowed");
  await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-5", secondsAgo: 60 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-5"))), "tooFast", "the 11th is not");
  await db.sql`update messages set created_at = now() - interval '6 minutes' where visitor_id = ${visitor}`;
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-5"))), "ok", "after 5 minutes it's allowed again");
});

test("messages the gate turned away don't count towards the limits", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  for (let i = 0; i < 12; i++) await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-gate", action: "gate", secondsAgo: 10 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-gate"))), "ok");
});

test("60 messages a day per browser, and the daily message wins when both limits apply", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  for (let i = 0; i < 59; i++) await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-day", secondsAgo: 3600 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-day"))), "ok", "the 60th is allowed");
  await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-day", secondsAgo: 3600 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-day"))), "daily");
  for (let i = 0; i < 10; i++) await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-day", secondsAgo: 30 });
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-day"))), "daily", "not 'a few minutes' when it's really the day");
  await db.sql`update messages set created_at = now() - interval '25 hours' where visitor_id = ${visitor}`;
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-day"))), "ok", "a day later it's allowed again");
});

test("30 messages in 10 minutes per IP address, across browsers", async () => {
  const { gate } = setup();
  const ip = "ip-shared";
  for (let b = 0; b < 3; b++) {
    const other = await addVisitor(db.sql, ip);
    for (let i = 0; i < 10; i++) await addMessage(db.sql, { visitorId: other, ipHash: ip, secondsAgo: 120 });
  }
  const newcomer = await addVisitor(db.sql, ip);
  assert.equal(await reasonOf(await gate.check(input(newcomer, ip))), "tooFast");
  const elsewhere = await addVisitor(db.sql, "ip-elsewhere");
  assert.equal(await reasonOf(await gate.check(input(elsewhere, "ip-elsewhere"))), "ok", "another address is unaffected");
  await db.sql`update messages set created_at = now() - interval '11 minutes' where ip_hash = ${ip}`;
  assert.equal(await reasonOf(await gate.check(input(newcomer, ip))), "ok", "after 10 minutes it's allowed again");
});

test("the month's spending: pauses at the cap, counts handoff summaries, and emails once a month", async () => {
  const { gate, emails } = setup({ spendCapUsd: 5, perIpDayUsd: 1e9 }, () => new Date("2031-03-15T12:00:00Z"));
  const visitor = await addVisitor(db.sql);
  // Spending in March 2031, plus February's, which doesn't count.
  await db.sql`insert into conversations (id, visitor_id) values (${randomUUID()}, ${visitor})`;
  const [{ id: conversation }] = await db.sql<{ id: string }[]>`select id from conversations where visitor_id = ${visitor}`;
  const spend = (cost: number, at: string) =>
    db.sql`insert into messages (conversation_id, visitor_id, ip_hash, role, text, action, cost_usd, created_at)
           values (${conversation}, ${visitor}, 'ip-spend', 'visitor', 'x', 'answer', ${cost.toFixed(6)}, ${at})`;
  await spend(4, "2031-03-02T10:00:00Z");
  await spend(100, "2031-02-27T10:00:00Z");
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-spend"))), "ok", "$4 of $5");
  assert.equal(emails.length, 0);

  await db.sql`insert into handoffs (visitor_id, name, email, note, cost_usd, created_at)
               values (${visitor}, 'A', 'a@example.com', 'hi', '1.000000', '2031-03-10T10:00:00Z')`;
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-spend"))), "spendCap", "$5 of $5");
  assert.equal(emails.length, 1, "the first crossing sends one email");
  assert.match(emails[0].subject, /\$5/);
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-spend"))), "spendCap");
  assert.equal(emails.length, 1, "and only one");
  const alerts = await db.sql<{ month: string }[]>`select month from spend_alerts where month like '2031-%'`;
  assert.deepEqual(alerts.map((a) => a.month), ["2031-03"]);

  // The next month starts at zero, and is paused and emailed again only if it crosses the cap itself.
  const april = setup({ spendCapUsd: 5, perIpDayUsd: 1e9 }, () => new Date("2031-04-01T00:00:01Z"));
  assert.equal(await reasonOf(await april.gate.check(input(visitor, "ip-spend"))), "ok");
  assert.equal(april.emails.length, 0);
  await spend(6, "2031-04-01T00:00:00Z");
  assert.equal(await reasonOf(await april.gate.check(input(visitor, "ip-spend"))), "spendCap");
  assert.equal(april.emails.length, 1);
});

test("a spending-cap email that can't be sent doesn't stop the gate", async () => {
  const gate = makeGate({
    sql: db.sql,
    limits: { ...LIMITS, spendCapUsd: 0 },
    mail: async () => {
      throw new Error("Resend answered 500");
    },
    now: () => new Date("2032-01-10T00:00:00Z"),
    log: () => {},
  });
  const visitor = await addVisitor(db.sql);
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-mail"))), "spendCap");
});

test("a lock that has run out resets the strikes and unlocks, in one step", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() - interval '1 minute' where id = ${visitor}`;
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-lock"))), "ok");
  const after = await getVisitor(db.sql, visitor);
  assert.equal(after?.strikes, 0);
  assert.equal(after?.lockedUntil, null);

  const still = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '1 day' where id = ${still}`;
  assert.equal(await reasonOf(await gate.check(input(still, "ip-lock2"))), "locked");
  assert.equal((await getVisitor(db.sql, still))?.strikes, 3, "a lock still running keeps its strikes");
  assert.equal(await unlockIfExpired(db.sql, still), false);
});

test("a browser with a message being handled can't start another at the same moment", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  const first = await gate.check(input(visitor, "ip-busy"));
  assert.equal(first.ok, true);
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-busy"))), "tooFast");
  if (first.ok) first.release();
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-busy"))), "ok");

  // A burst all at once lets exactly one through.
  const burst = await Promise.all(Array.from({ length: 6 }, () => gate.check(input(visitor, "ip-busy"))));
  assert.equal(burst.filter((r) => r.ok).length, 1);
  for (const r of burst) if (r.ok) r.release();
});

test("two strikes at the same moment are each counted once; the third locks for 30 days", async () => {
  const visitor = await addVisitor(db.sql, "ip-strikes");
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);

  const both = await Promise.all([strikeOnce(visitor, "ip-strikes", conversation), strikeOnce(visitor, "ip-strikes", conversation)]);
  assert.deepEqual(both.map((s) => s.strikes).sort(), [1, 2], "neither skipped nor counted twice");
  assert.ok(both.every((s) => s.lockedUntil === null));
  assert.equal((await listStrikes(db.sql, visitor)).length, 2);

  const third = await strikeOnce(visitor, "ip-strikes", conversation);
  assert.equal(third.strikes, 3);
  assert.ok(third.lockedUntil);
  const days = (third.lockedUntil.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1, `locked for about 30 days, got ${days}`);
  const { gate } = setup();
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-strikes"))), "locked");
});

test("a strike points at the message that earned it", async () => {
  const visitor = await addVisitor(db.sql);
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  await strikeOnce(visitor, "ip-msg", conversation);
  const [strike] = await listStrikes(db.sql, visitor);
  assert.equal(strike.messageText, "a rude message");
  assert.equal(strike.category, "abuse");
});

test("revoking a strike takes one off, never below 0, and unlocks when it drops under 3", async () => {
  const visitor = await addVisitor(db.sql, "ip-revoke");
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  for (let i = 0; i < 3; i++) await strikeOnce(visitor, "ip-revoke", conversation);
  assert.ok((await getVisitor(db.sql, visitor))?.lockedUntil);

  const [newest] = await listStrikes(db.sql, visitor, 1);
  const revoked = await revokeStrike(db.sql, newest.id);
  assert.equal(revoked?.strikes, 2);
  assert.equal(revoked?.lockedUntil, null, "back under 3: unlocked");
  assert.ok((await listStrikes(db.sql, visitor, 1))[0].revokedAt);

  const again = await revokeStrike(db.sql, newest.id);
  assert.equal(again?.alreadyRevoked, true);
  assert.equal(again?.strikes, 2, "revoking twice takes off one, not two");

  await db.sql`update visitors set strikes = 0 where id = ${visitor}`;
  const [older] = await listStrikes(db.sql, visitor, 3);
  assert.equal((await revokeStrike(db.sql, older.id))?.strikes, 0, "never below 0");
  assert.equal(await revokeStrike(db.sql, "999999999"), undefined, "no such strike");
});

test("unlock clears the strikes and the lock", async () => {
  const visitor = await addVisitor(db.sql);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '9 days' where id = ${visitor}`;
  assert.equal(await unlockVisitor(db.sql, visitor), true);
  const after = await getVisitor(db.sql, visitor);
  assert.equal(after?.strikes, 0);
  assert.equal(after?.lockedUntil, null);
  assert.equal(await unlockVisitor(db.sql, randomUUID()), false);
});

test("new browsers: 5 per IP address per hour, even when asked for all at once", async () => {
  const burst = await Promise.all(Array.from({ length: 9 }, () => createVisitor(db.sql, randomUUID(), "ip-new", 5)));
  assert.equal(burst.filter(Boolean).length, 5);
  assert.equal(await createVisitor(db.sql, randomUUID(), "ip-new-other", 5), true, "another address has its own allowance");
  await db.sql`update visitors set created_at = now() - interval '2 hours' where ip_hash = 'ip-new'`;
  assert.equal(await createVisitor(db.sql, randomUUID(), "ip-new", 5), true, "an hour later");
});

test("small talk is counted per browser over a day, however many conversations, even when asked at once", async () => {
  const visitor = await addVisitor(db.sql);
  const taken = await Promise.all(Array.from({ length: 5 }, () => takeSmallTalk(db.sql, visitor, 2)));
  assert.equal(taken.filter(Boolean).length, 2);
  assert.equal(await takeSmallTalk(db.sql, visitor, 2), false);
  assert.equal(await takeSmallTalk(db.sql, await addVisitor(db.sql), 2), true, "another browser has its own");
  await db.sql`update small_talk_uses set created_at = now() - interval '25 hours' where visitor_id = ${visitor}`;
  assert.equal(await takeSmallTalk(db.sql, visitor, 2), true, "a day later");
});

test("handoffs: 2 per browser per day, even when sent at once", async () => {
  const visitor = await addVisitor(db.sql);
  const row = { visitorId: visitor, ipHash: "ip-handoff", conversationId: null, name: "A", company: null, email: "a@example.com", roleLink: null, note: "hi" };
  const sent = await Promise.all(Array.from({ length: 4 }, () => insertHandoff(db.sql, row, 2)));
  assert.equal(sent.filter((id) => id !== null).length, 2);
  await db.sql`update handoffs set created_at = now() - interval '25 hours' where visitor_id = ${visitor}`;
  assert.notEqual(await insertHandoff(db.sql, row, 2), null, "a day later");
});

test("the spending email is claimed once per month", async () => {
  assert.equal(await claimSpendAlert(db.sql, "2040-01"), true);
  assert.equal(await claimSpendAlert(db.sql, "2040-01"), false);
  assert.equal(await claimSpendAlert(db.sql, "2040-02"), true);
});

test("purge removes conversations, handoffs and clicks over 12 months old, and browsers not seen in that long", async () => {
  const visitor = await addVisitor(db.sql, "ip-purge");
  const old = randomUUID();
  const recent = randomUUID();
  await db.sql`insert into conversations (id, visitor_id, started_at) values (${old}, ${visitor}, now() - interval '13 months')`;
  await db.sql`insert into conversations (id, visitor_id, started_at) values (${recent}, ${visitor}, now() - interval '11 months')`;
  for (const conversationId of [old, recent]) await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-purge", conversationId, secondsAgo: 60 });
  await db.sql`insert into handoffs (visitor_id, name, email, note, created_at)
               values (${visitor}, 'Old', 'o@example.com', 'x', now() - interval '13 months'), (${visitor}, 'New', 'n@example.com', 'x', now() - interval '1 month')`;
  await db.sql`insert into instant_clicks (visitor_id, instant_id, created_at)
               values (${visitor}, 'old-chip', now() - interval '13 months'), (${visitor}, 'new-chip', now())`;
  const forgotten = await addVisitor(db.sql, "ip-forgotten");
  await db.sql`update visitors set last_seen_at = now() - interval '13 months', strikes = 2 where id = ${forgotten}`;
  await db.sql`insert into small_talk_uses (visitor_id) values (${forgotten})`;

  const gone = await purgeOld(db.sql);
  assert.deepEqual(gone, { conversations: 1, handoffs: 1, clicks: 1, visitors: 1 });
  assert.equal(await getVisitor(db.sql, forgotten), undefined, "a browser not seen for a year is forgotten, with its strikes");
  assert.equal((await db.sql`select 1 from small_talk_uses where visitor_id = ${forgotten}`).length, 0);
  assert.equal((await db.sql`select 1 from conversations where id = ${old}`).length, 0);
  assert.equal((await db.sql`select 1 from messages where conversation_id = ${old}`).length, 0, "its messages went with it");
  assert.equal((await db.sql`select 1 from messages where conversation_id = ${recent}`).length, 1);
  assert.deepEqual((await db.sql`select name from handoffs where visitor_id = ${visitor}`).map((r) => r.name), ["New"]);
  assert.ok(await getVisitor(db.sql, visitor), "the browser stays, with its strikes");
  assert.deepEqual(await purgeOld(db.sql), { conversations: 0, handoffs: 0, clicks: 0, visitors: 0 });
});

test("reading transcripts: the newest conversations with their cost, first question and how replies were made", async () => {
  const visitor = await addVisitor(db.sql, "ip-read");
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-read", conversationId: conversation, text: "First thing asked", action: "answer", costUsd: 0.01, secondsAgo: 30 });
  await addMessage(db.sql, { visitorId: visitor, ipHash: "ip-read", conversationId: conversation, text: "Second thing", action: "strike", costUsd: 0.0005, secondsAgo: 20 });
  const [summary] = await recentConversations(db.sql, 1000).then((all) => all.filter((c) => c.id === conversation));
  assert.equal(summary.messages, 2);
  assert.equal(summary.firstQuestion, "First thing asked");
  assert.ok(Math.abs(summary.costUsd - 0.0105) < 1e-9);
  assert.deepEqual(summary.actions, ["answer", "strike"]);
  assert.equal((await recentConversations(db.sql, 1)).length, 1);
});

test("stage timings: the latest visitor messages, and their typical and slow times", async () => {
  const visitor = await addVisitor(db.sql, "ip-speed");
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  for (let i = 1; i <= 20; i++) {
    await db.sql`insert into messages (conversation_id, visitor_id, ip_hash, role, text, action, timings)
                 values (${conversation}, ${visitor}, 'ip-speed', 'visitor', 'x', 'answer', ${db.sql.json({ answer: i * 100, total: i * 100 + 50 })})`;
  }
  const rows = await recentTimings(db.sql, 20);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].answer, 2000, "newest first");
  const [answer, total] = stageStats(rows);
  assert.deepEqual(answer, { stage: "answer", count: 20, typical: 1000, slow: 1900 });
  assert.deepEqual(total, { stage: "total", count: 20, typical: 1050, slow: 1950 });
  assert.equal(percentile([5], 0.95), 5);
  assert.deepEqual(stageStats([{ gate: 3 }, { gate: 7 }, { first_audio: 900 }]).map((s) => [s.stage, s.count]), [["gate", 2], ["first_audio", 1]]);
});

test("one address's AI spending is capped for the day, across browsers, messages and handoffs", async () => {
  const { gate } = setup();
  const ip = "ip-budget";
  const visitors = [await addVisitor(db.sql, ip), await addVisitor(db.sql, ip), await addVisitor(db.sql, ip)];
  for (const visitor of visitors) await addMessage(db.sql, { visitorId: visitor, ipHash: ip, costUsd: 0.6, secondsAgo: 30 });
  const newcomer = await addVisitor(db.sql, ip);
  assert.equal(await reasonOf(await gate.check(input(newcomer, ip))), "ok", "$1.80 of $2.00");

  await db.sql`insert into handoffs (visitor_id, ip_hash, name, email, note, cost_usd) values (${newcomer}, ${ip}, 'A', 'a@example.com', 'x', '0.250000')`;
  const result = await gate.check(input(newcomer, ip));
  assert.equal(await reasonOf(result), "daily", "$2.05: over");
  assert.ok(!result.ok && result.text === GATE.daily);
  assert.equal(await reasonOf(await gate.check(input(await addVisitor(db.sql), "ip-budget-elsewhere"))), "ok", "another address is unaffected");

  // Only today's spending counts: yesterday's doesn't.
  await db.sql`update messages set created_at = now() - interval '2 days' where ip_hash = ${ip}`;
  await db.sql`update handoffs set created_at = now() - interval '2 days' where ip_hash = ${ip}`;
  assert.equal(await reasonOf(await gate.check(input(newcomer, ip))), "ok");
  const midnight = new Date(Date.UTC(2020, 0, 1));
  assert.equal(await ipSpendSince(db.sql, ip, midnight), 0.6 * 3 + 0.25);
});

test("the spending cap can be asked about directly, and still emails once", async () => {
  const { gate, emails } = setup({ spendCapUsd: 0.5 }, () => new Date("2033-06-10T10:00:00Z"));
  assert.equal(await gate.overCap(), false);
  const visitor = await addVisitor(db.sql);
  await db.sql`insert into conversations (id, visitor_id) values (${randomUUID()}, ${visitor})`;
  const [{ id }] = await db.sql<{ id: string }[]>`select id from conversations where visitor_id = ${visitor}`;
  await db.sql`insert into messages (conversation_id, visitor_id, ip_hash, role, text, action, cost_usd, created_at)
               values (${id}, ${visitor}, 'ip-cap', 'visitor', 'x', 'answer', '0.600000', '2033-06-02T00:00:00Z')`;
  assert.equal(await gate.overCap(), true);
  assert.equal(await gate.overCap(), true);
  assert.equal(emails.length, 1);
});

test("a NUL character or a lone surrogate in a saved message is dropped, not a failed insert", async () => {
  const visitor = await addVisitor(db.sql, "ip-nul");
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  const id = await saveMessage(db.sql, {
    conversationId: conversation,
    visitorId: visitor,
    ipHash: "ip-nul",
    role: "visitor",
    text: "he\u0000llo \ud800 wor\u0007ld\tok\n",
    jobPost: "post\u0000",
    reason: "why\u0000",
    action: "answer",
  });
  const [row] = await db.sql<{ text: string; job_post: string; reason: string }[]>`select text, job_post, reason from messages where id = ${id}`;
  assert.deepEqual({ ...row }, { text: "hello  world\tok\n", job_post: "post", reason: "why" });
});

test("what the strike check remembers follows the browser across conversations, for a window of hours", async () => {
  const visitor = await addVisitor(db.sql, "ip-memory");
  const other = await addVisitor(db.sql, "ip-memory-other");
  const first = randomUUID();
  const second = randomUUID();
  await createConversation(db.sql, first, visitor);
  await createConversation(db.sql, second, visitor);
  const say = (conversationId: string, role: "visitor" | "assistant", text: string, action: string | null, category?: string) =>
    saveMessage(db.sql, { conversationId, visitorId: visitor, ipHash: "ip-memory", role, text, action, category });
  await say(first, "visitor", "one", "answer", "career");
  await say(first, "assistant", "reply one", "answer");
  await say(second, "visitor", "two", "refuse", "private_details");
  await say(second, "assistant", "reply two", "refuse");
  await say(second, "visitor", "turned away", "gate");
  await say(second, "assistant", "too fast", "gate");
  await say(second, "visitor", "being handled now", null);
  const theirs = randomUUID();
  await createConversation(db.sql, theirs, other);
  await saveMessage(db.sql, { conversationId: theirs, visitorId: other, ipHash: "x", role: "visitor", text: "someone else", action: "answer" });

  assert.deepEqual((await recentTurns(db.sql, visitor)).map((t) => t.text), ["one", "reply one", "two", "reply two"], "both conversations, without the refused or unfinished ones");
  assert.deepEqual((await recentTurns(db.sql, visitor, 3)).map((t) => t.text), ["reply one", "two", "reply two"], "the last few");
  assert.deepEqual([...(await refusedCategories(db.sql, visitor))], ["private_details"]);
  assert.equal((await refusedCategories(db.sql, other)).size, 0);

  await setRiskNote(db.sql, first, "older note");
  await setRiskNote(db.sql, second, "newer note");
  assert.equal(await latestRiskNote(db.sql, visitor), "newer note");
  assert.equal(await latestRiskNote(db.sql, other), "");
  assert.equal((await latestConversation(db.sql, visitor))?.id, second);
  assert.equal(await latestConversation(db.sql, await addVisitor(db.sql)), undefined);

  // Two hours on, the history and the note are forgotten; a day on, so is the refusal.
  await db.sql`update messages set created_at = now() - interval '3 hours' where visitor_id = ${visitor}`;
  assert.deepEqual(await recentTurns(db.sql, visitor), []);
  assert.equal(await latestRiskNote(db.sql, visitor), "");
  assert.equal((await refusedCategories(db.sql, visitor)).size, 1);
  await db.sql`update messages set created_at = now() - interval '25 hours' where visitor_id = ${visitor}`;
  assert.equal((await refusedCategories(db.sql, visitor)).size, 0);
});

test("button clicks are counted per browser and button, in turn, even when made at the same moment", async () => {
  const visitor = await addVisitor(db.sql);
  const burst = await Promise.all(Array.from({ length: 6 }, () => recordButtonClick(db.sql, visitor, null, "about-you")));
  assert.deepEqual([...burst].sort(), [0, 1, 2, 3, 4, 5], "each click sees how many came before it, once");
  assert.equal(await recordButtonClick(db.sql, visitor, null, "role"), 0, "another button starts from 0");
  assert.equal(await recordButtonClick(db.sql, await addVisitor(db.sql), null, "about-you"), 0, "and so does another browser");
  assert.equal(await recordButtonClick(db.sql, visitor, null, "about-you"), 6);
});

test("a click isn't a message for the limits, even though its row is a visitor row", async () => {
  const { gate } = setup();
  const visitor = await addVisitor(db.sql);
  const conversation = randomUUID();
  await createConversation(db.sql, conversation, visitor);
  for (let i = 0; i < 15; i++) {
    await saveMessage(db.sql, { conversationId: conversation, visitorId: visitor, ipHash: "ip-clicks", role: "visitor", text: "Tell me about yourself.", action: "fixed", intent: "button:about-you" });
  }
  assert.equal(await reasonOf(await gate.check(input(visitor, "ip-clicks"))), "ok");
  assert.equal(await gate.isLocked(visitor), false);
  await db.sql`update visitors set strikes = 3, locked_until = now() + interval '1 day' where id = ${visitor}`;
  assert.equal(await gate.isLocked(visitor), true);
  await db.sql`update visitors set locked_until = now() - interval '1 minute' where id = ${visitor}`;
  assert.equal(await gate.isLocked(visitor), false, "a lock that has run out is lifted");
  assert.equal((await getVisitor(db.sql, visitor))?.strikes, 0);
});

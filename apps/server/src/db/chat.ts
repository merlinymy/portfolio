/**
 * All the chat's SQL (docs/phase-5-chat-plan.md, tables in migrations/002_chat.sql): browsers,
 * conversations, messages, strikes, handoffs, instant-answer clicks and the month's spending. Each
 * function is one small, named query taking `sql`, so the gate, the pipeline, the routes and the
 * admin commands read as plain steps and tests can run them against a throwaway database.
 */
import type { VisitorStatus } from "@portfolio/shared/chat";
import type postgres from "postgres";
import type { Category, Turn } from "../chat/types.ts";
import { stripControl } from "../identity.ts";
import type { Sql } from "./client.ts";

/** What a query can run on: the connection, or a transaction in progress. */
type Db = postgres.ISql;

/** The third strike locks a browser (plan §7.2). */
export const MAX_STRIKES = 3;
/** How long a lock lasts, in days. */
export const LOCK_DAYS = 30;

/** Postgres returns numeric columns as strings; the chat's amounts are small enough for a float. */
const usd = (value: number) => value.toFixed(6);

// ---- Browsers ---------------------------------------------------------------------------------

export interface VisitorRow {
  id: string;
  strikes: number;
  lockedUntil: Date | null;
}

/** Where a browser stands, as the page sees it. */
export function visitorStatus(v: { strikes: number; lockedUntil: Date | null }): VisitorStatus {
  return {
    strikes: v.strikes,
    strikesLeft: Math.max(0, MAX_STRIKES - v.strikes),
    lockedUntil: v.lockedUntil ? v.lockedUntil.toISOString() : null,
  };
}

export async function getVisitor(sql: Db, id: string): Promise<VisitorRow | undefined> {
  const [row] = await sql<{ id: string; strikes: number; locked_until: Date | null }[]>`
    select id, strikes, locked_until from visitors where id = ${id}`;
  return row && { id: row.id, strikes: row.strikes, lockedUntil: row.locked_until };
}

/**
 * Creates a browser, unless this IP address (as its hash) already made `perHour` in the last hour.
 * The count and the insert happen under one lock per address, so a burst of requests can't slip
 * past the limit together. Returns false when the limit is reached.
 */
export async function createVisitor(sql: Sql, id: string, ipHash: string, perHour: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`new-visitor:${ipHash}`}))`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from visitors where ip_hash = ${ipHash} and created_at > now() - interval '1 hour'`;
    if (n >= perHour) return false;
    await tx`insert into visitors (id, ip_hash) values (${id}, ${ipHash})`;
    return true;
  });
}

export async function touchVisitor(sql: Sql, id: string): Promise<void> {
  await sql`update visitors set last_seen_at = now() where id = ${id}`;
}

/**
 * Ends a lock that has run out: the strikes go back to 0 and the browser is unlocked in one
 * update (plan §7.2). Returns true if it did, false if there was nothing to end.
 */
export async function unlockIfExpired(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    update visitors set strikes = 0, locked_until = null
    where id = ${id} and locked_until is not null and locked_until <= now()
    returning id`;
  return rows.length > 0;
}

// ---- Conversations ----------------------------------------------------------------------------

export interface ConversationRow {
  id: string;
  riskNote: string;
  smallTalk: number;
}

export async function createConversation(sql: Sql, id: string, visitorId: string): Promise<void> {
  await sql`insert into conversations (id, visitor_id) values (${id}, ${visitorId})`;
}

/** The conversation, only if it belongs to this browser. */
export async function getConversation(sql: Sql, id: string, visitorId: string): Promise<ConversationRow | undefined> {
  const [row] = await sql<{ id: string; risk_note: string; small_talk: number }[]>`
    select id, risk_note, small_talk from conversations where id = ${id} and visitor_id = ${visitorId}`;
  return row && { id: row.id, riskNote: row.risk_note, smallTalk: row.small_talk };
}

export async function setRiskNote(sql: Sql, id: string, note: string): Promise<void> {
  await sql`update conversations set risk_note = ${stripControl(note)} where id = ${id}`;
}

/** The browser's newest conversation, for a gate refusal to be recorded in instead of starting another. */
export async function latestConversation(sql: Sql, visitorId: string): Promise<ConversationRow | undefined> {
  const [row] = await sql<{ id: string; risk_note: string; small_talk: number }[]>`
    select id, risk_note, small_talk from conversations where visitor_id = ${visitorId} order by started_at desc limit 1`;
  return row && { id: row.id, riskNote: row.risk_note, smallTalk: row.small_talk };
}

/**
 * The strike check's running note for this browser: the latest one written in the last `hours`
 * hours, whichever conversation it was written in (starting a new conversation doesn't wipe it).
 */
export async function latestRiskNote(sql: Sql, visitorId: string, hours = 2): Promise<string> {
  const [row] = await sql<{ risk_note: string }[]>`
    select c.risk_note
    from conversations c
    join lateral (
      select max(m.id) as last_id from messages m
      where m.conversation_id = c.id and m.created_at > now() - make_interval(hours => ${hours})
    ) recent on recent.last_id is not null
    where c.visitor_id = ${visitorId} and c.risk_note <> ''
    order by recent.last_id desc limit 1`;
  return row?.risk_note ?? "";
}

/**
 * Counts one approved small-talk answer for this browser, unless it already had `limit` in the
 * last `hours` hours, however many conversations it started. The count and the insert happen under
 * one lock per browser, so two messages at once can't both take the last one.
 */
export async function takeSmallTalk(sql: Sql, visitorId: string, limit: number, hours = 24): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`small-talk:${visitorId}`}))`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from small_talk_uses
      where visitor_id = ${visitorId} and created_at > now() - make_interval(hours => ${hours})`;
    if (n >= limit) return false;
    await tx`insert into small_talk_uses (visitor_id) values (${visitorId})`;
    return true;
  });
}

/**
 * This browser's last `limit` turns in the last `hours` hours, oldest first, as the strike check and
 * the answer model see them, across all its conversations (so a fresh conversation doesn't hide an
 * escalation). Replies the gate refused (too long, too fast, locked...) aren't part of it, and
 * neither is the message being handled now, whose row has no action yet.
 */
export async function recentTurns(sql: Sql, visitorId: string, limit = 10, hours = 2): Promise<Turn[]> {
  const rows = await sql<{ role: "visitor" | "assistant"; text: string }[]>`
    select role, text from messages
    where visitor_id = ${visitorId} and action is not null and action <> 'gate'
      and created_at > now() - make_interval(hours => ${hours})
    order by id desc limit ${limit}`;
  return rows.reverse().map((r) => ({ role: r.role, text: r.text }));
}

/**
 * The categories this browser has been refused for in the last `hours` hours, in any conversation
 * (plan §7.3, "strike on repeat": asking again in a new conversation doesn't start over).
 */
export async function refusedCategories(sql: Sql, visitorId: string, hours = 24): Promise<Set<Category>> {
  const rows = await sql<{ category: Category }[]>`
    select distinct category from messages
    where visitor_id = ${visitorId} and role = 'visitor' and action = 'refuse' and category is not null
      and created_at > now() - make_interval(hours => ${hours})`;
  return new Set(rows.map((r) => r.category));
}

// ---- Messages ---------------------------------------------------------------------------------

export interface MessageRow {
  /** A reserved id (reserveMessageId); saving the same id again updates the row. */
  id?: string;
  conversationId: string;
  visitorId: string;
  ipHash: string;
  role: "visitor" | "assistant";
  text: string;
  jobPost?: string | null;
  category?: string | null;
  intent?: string | null;
  /** A ReplyKind. Both rows of an exchange carry it, so either side shows how the reply was made. */
  action?: string | null;
  reason?: string | null;
  /** Assistant rows: the passage ids the answer was written from. */
  passages?: string[] | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  timings?: Record<string, number> | null;
}

/**
 * Takes the next message id now, so the `meta` event can name the message before it is saved
 * (and a strike can point at it).
 */
export async function reserveMessageId(sql: Db): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`select nextval(pg_get_serial_sequence('messages', 'id'))::text as id`;
  return id;
}

/** Saves a message and returns its id. A row saved twice under the same id is updated, not duplicated. */
export async function saveMessage(sql: Db, input: MessageRow): Promise<string> {
  // A NUL character makes Postgres refuse the whole row, so every text is cleaned here whatever its source.
  const clean = (text: string | null | undefined) => (text == null ? null : stripControl(text));
  const row = {
    ...input,
    text: stripControl(input.text),
    jobPost: clean(input.jobPost),
    category: clean(input.category),
    intent: clean(input.intent),
    action: clean(input.action),
    reason: clean(input.reason),
    model: clean(input.model),
    passages: input.passages?.map(stripControl) ?? null,
  };
  const id = row.id ?? (await reserveMessageId(sql));
  await sql`
    insert into messages (
      id, conversation_id, visitor_id, ip_hash, role, text, job_post, category, intent, action, reason,
      passages, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, timings
    ) values (
      ${id}, ${row.conversationId}, ${row.visitorId}, ${row.ipHash}, ${row.role}, ${row.text}, ${row.jobPost},
      ${row.category}, ${row.intent}, ${row.action}, ${row.reason},
      ${row.passages ? sql.array(row.passages, 25) : null}, ${row.model},
      ${row.inputTokens ?? 0}, ${row.outputTokens ?? 0}, ${row.cacheReadTokens ?? 0}, ${row.cacheWriteTokens ?? 0},
      ${usd(row.costUsd ?? 0)}, ${row.timings ? sql.json(row.timings) : null}
    )
    on conflict (id) do update set
      text = excluded.text, job_post = excluded.job_post, category = excluded.category, intent = excluded.intent,
      action = excluded.action, reason = excluded.reason, passages = excluded.passages, model = excluded.model,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
      cost_usd = excluded.cost_usd, timings = excluded.timings`;
  return id;
}

export interface MessageCounts {
  /** This browser's messages in the last 24 hours. */
  day: number;
  /** This browser's messages in the last 5 minutes. */
  fiveMinutes: number;
  /** Messages from this IP address (all browsers on it) in the last 10 minutes. */
  ipTenMinutes: number;
}

/**
 * What the rate limits count (plan §7.7): typed messages that got past the gate, so being turned
 * away doesn't keep a visitor locked out longer, and a click on a question button (no AI call)
 * isn't a message at all.
 */
export async function messageCounts(sql: Sql, visitorId: string, ipHash: string): Promise<MessageCounts> {
  const [row] = await sql<{ day: number; five: number; ip: number }[]>`
    select
      count(*) filter (where visitor_id = ${visitorId} and created_at > now() - interval '24 hours')::int as day,
      count(*) filter (where visitor_id = ${visitorId} and created_at > now() - interval '5 minutes')::int as five,
      count(*) filter (where ip_hash = ${ipHash} and created_at > now() - interval '10 minutes')::int as ip
    from messages
    where role = 'visitor' and action is distinct from 'gate' and coalesce(intent, '') not like 'button:%'
      and created_at > now() - interval '24 hours' and (visitor_id = ${visitorId} or ip_hash = ${ipHash})`;
  return { day: row.day, fiveMinutes: row.five, ipTenMinutes: row.ip };
}

export interface TranscriptRow {
  id: string;
  role: "visitor" | "assistant";
  text: string;
  jobPostLength: number | null;
  category: string | null;
  action: string | null;
  reason: string | null;
  costUsd: number;
  createdAt: Date;
}

/** Every message of a conversation, in order (the handoff email's transcript, `transcripts show`). */
export async function conversationMessages(sql: Sql, conversationId: string): Promise<TranscriptRow[]> {
  const rows = await sql<
    {
      id: string;
      role: "visitor" | "assistant";
      text: string;
      job_post_length: number | null;
      category: string | null;
      action: string | null;
      reason: string | null;
      cost: number;
      created_at: Date;
    }[]
  >`
    select id::text, role, text, length(job_post) as job_post_length, category, action, reason,
           cost_usd::float8 as cost, created_at
    from messages where conversation_id = ${conversationId} order by id`;
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    text: r.text,
    jobPostLength: r.job_post_length,
    category: r.category,
    action: r.action,
    reason: r.reason,
    costUsd: r.cost,
    createdAt: r.created_at,
  }));
}

// ---- Strikes ----------------------------------------------------------------------------------

/**
 * Gives a strike, in one transaction: saves the offending message (so the strike can point at it),
 * records the strike, and counts it on the browser; the third sets the 30-day lock. The count is
 * one `strikes + 1` update, so two strikes at the same moment are counted once each, in turn.
 */
export async function recordStrike(
  sql: Sql,
  args: { message: MessageRow; category: string; reason: string },
): Promise<{ strikes: number; lockedUntil: Date | null }> {
  return sql.begin(async (tx) => {
    const messageId = await saveMessage(tx, args.message);
    await tx`
      insert into strikes (visitor_id, message_id, category, reason)
      values (${args.message.visitorId}, ${messageId}, ${stripControl(args.category)}, ${stripControl(args.reason)})`;
    const [row] = await tx<{ strikes: number; locked_until: Date | null }[]>`
      update visitors
      set strikes = strikes + 1,
          locked_until = case when strikes + 1 >= ${MAX_STRIKES} then now() + make_interval(days => ${LOCK_DAYS}) else locked_until end
      where id = ${args.message.visitorId}
      returning strikes, locked_until`;
    return { strikes: row.strikes, lockedUntil: row.locked_until };
  });
}

export interface StrikeListing {
  id: string;
  visitorId: string;
  category: string;
  reason: string;
  createdAt: Date;
  revokedAt: Date | null;
  messageText: string | null;
}

/** The latest strikes, newest first, for one browser or all of them (`npm run strikes -- list`). */
export async function listStrikes(sql: Sql, visitorId?: string, limit = 50): Promise<StrikeListing[]> {
  const rows = await sql<
    { id: string; visitor_id: string; category: string; reason: string; created_at: Date; revoked_at: Date | null; text: string | null }[]
  >`
    select s.id::text, s.visitor_id, s.category, s.reason, s.created_at, s.revoked_at, m.text
    from strikes s left join messages m on m.id = s.message_id
    where ${visitorId ? sql`s.visitor_id = ${visitorId}` : sql`true`}
    order by s.id desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    visitorId: r.visitor_id,
    category: r.category,
    reason: r.reason,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    messageText: r.text,
  }));
}

/**
 * Undoes a strike given by mistake (plan §7.2): marks it revoked, takes one off the browser's
 * count (never below 0), and unlocks it if that drops it below 3. Returns undefined if there's no
 * such strike. A strike from before a lock ran out was already wiped with the rest, so revoking it
 * only takes one off the count the browser has started since.
 */
export async function revokeStrike(
  sql: Sql,
  strikeId: string,
): Promise<{ visitorId: string; alreadyRevoked: boolean; strikes: number; lockedUntil: Date | null } | undefined> {
  return sql.begin(async (tx) => {
    const [strike] = await tx<{ visitor_id: string; revoked_at: Date | null }[]>`
      select visitor_id, revoked_at from strikes where id = ${strikeId} for update`;
    if (!strike) return undefined;
    if (strike.revoked_at) {
      const visitor = await getVisitor(tx, strike.visitor_id);
      return { visitorId: strike.visitor_id, alreadyRevoked: true, strikes: visitor?.strikes ?? 0, lockedUntil: visitor?.lockedUntil ?? null };
    }
    await tx`update strikes set revoked_at = now() where id = ${strikeId}`;
    const [row] = await tx<{ strikes: number; locked_until: Date | null }[]>`
      update visitors
      set strikes = greatest(strikes - 1, 0),
          locked_until = case when greatest(strikes - 1, 0) < ${MAX_STRIKES} then null else locked_until end
      where id = ${strike.visitor_id}
      returning strikes, locked_until`;
    return { visitorId: strike.visitor_id, alreadyRevoked: false, strikes: row.strikes, lockedUntil: row.locked_until };
  });
}

/** Clears a browser's strikes and lock (`npm run strikes -- unlock`). Returns false if there's no such browser. */
export async function unlockVisitor(sql: Sql, visitorId: string): Promise<boolean> {
  const rows = await sql`update visitors set strikes = 0, locked_until = null where id = ${visitorId} returning id`;
  return rows.length > 0;
}

// ---- Spending ---------------------------------------------------------------------------------

/** What the AI calls cost between `from` (included) and `until` (excluded): messages and handoff summaries. */
export async function spendBetween(sql: Sql, from: Date, until: Date): Promise<number> {
  const [{ total }] = await sql<{ total: number }[]>`
    select (
      (select coalesce(sum(cost_usd), 0) from messages where created_at >= ${from} and created_at < ${until}) +
      (select coalesce(sum(cost_usd), 0) from handoffs where created_at >= ${from} and created_at < ${until})
    )::float8 as total`;
  return total;
}

/**
 * What the AI calls for one IP address (as its hash) cost since `since`: its messages and its
 * handoff summaries. The gate uses it to stop one address with many browsers draining the month's cap.
 */
export async function ipSpendSince(sql: Sql, ipHash: string, since: Date): Promise<number> {
  const [{ total }] = await sql<{ total: number }[]>`
    select (
      (select coalesce(sum(cost_usd), 0) from messages where ip_hash = ${ipHash} and created_at >= ${since}) +
      (select coalesce(sum(cost_usd), 0) from handoffs where ip_hash = ${ipHash} and created_at >= ${since})
    )::float8 as total`;
  return total;
}

/** Records that this month's cap email is being sent. True only the first time, so it's sent once. */
export async function claimSpendAlert(sql: Sql, month: string): Promise<boolean> {
  const rows = await sql`insert into spend_alerts (month) values (${month}) on conflict do nothing returning month`;
  return rows.length > 0;
}

// ---- Handoffs and instant-answer clicks --------------------------------------------------------

export interface HandoffRow {
  visitorId: string;
  /** The sender's scrambled IP address, so its AI spending can be added up. */
  ipHash: string;
  conversationId: string | null;
  name: string;
  company: string | null;
  email: string;
  roleLink: string | null;
  note: string;
}

/**
 * Saves a handoff unless this browser already sent `perDay` in the last 24 hours (counted and
 * inserted under one lock, so two at once can't both pass). Returns the new id, or null at the limit.
 */
export async function insertHandoff(sql: Sql, row: HandoffRow, perDay: number): Promise<string | null> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`handoff:${row.visitorId}`}))`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from handoffs where visitor_id = ${row.visitorId} and created_at > now() - interval '24 hours'`;
    if (n >= perDay) return null;
    const [{ id }] = await tx<{ id: string }[]>`
      insert into handoffs (visitor_id, ip_hash, conversation_id, name, company, email, role_link, note)
      values (${row.visitorId}, ${row.ipHash}, ${row.conversationId}, ${stripControl(row.name)}, ${row.company === null ? null : stripControl(row.company)},
              ${stripControl(row.email)}, ${row.roleLink === null ? null : stripControl(row.roleLink)}, ${stripControl(row.note)})
      returning id::text`;
    return id;
  });
}

export async function setHandoffSummary(sql: Sql, id: string, summary: string | null, costUsd: number): Promise<void> {
  await sql`update handoffs set summary = ${summary === null ? null : stripControl(summary)}, cost_usd = ${usd(costUsd)} where id = ${id}`;
}

/** Records how the email went: sent, or the error (the visitor is told ok either way; the row is the record). */
export async function setHandoffEmailResult(sql: Sql, id: string, error: string | null): Promise<void> {
  await sql`
    update handoffs set emailed_at = ${error ? null : sql`now()`}, email_error = ${error === null ? null : stripControl(error)} where id = ${id}`;
}

/**
 * Records a click on a question button and says how many clicks this browser had made on it
 * before, so the click can play the next version in turn. The count and the insert happen under one
 * lock per browser and button, so two clicks at once don't play the same version.
 */
export async function recordButtonClick(sql: Sql, visitorId: string, conversationId: string | null, buttonId: string): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`button:${visitorId}:${buttonId}`}))`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from instant_clicks where visitor_id = ${visitorId} and instant_id = ${buttonId}`;
    await tx`insert into instant_clicks (visitor_id, conversation_id, instant_id) values (${visitorId}, ${conversationId}, ${stripControl(buttonId)})`;
    return n;
  });
}

// ---- Retention and reading --------------------------------------------------------------------

/**
 * Removes what's older than `months` months (plan §7.6): conversations (their messages go with
 * them), handoffs, instant-answer clicks, and browsers not seen in that long (their strikes and
 * small-talk counts go with them; that's long after any 30-day lock has ended).
 */
export async function purgeOld(
  sql: Sql,
  months = 12,
): Promise<{ conversations: number; handoffs: number; clicks: number; visitors: number }> {
  return sql.begin(async (tx) => {
    const conversations = await tx`delete from conversations where started_at < now() - make_interval(months => ${months})`;
    const handoffs = await tx`delete from handoffs where created_at < now() - make_interval(months => ${months})`;
    const clicks = await tx`delete from instant_clicks where created_at < now() - make_interval(months => ${months})`;
    const visitors = await tx`delete from visitors where last_seen_at < now() - make_interval(months => ${months})`;
    return { conversations: conversations.count, handoffs: handoffs.count, clicks: clicks.count, visitors: visitors.count };
  });
}

export interface ConversationSummary {
  id: string;
  visitorId: string;
  startedAt: Date;
  messages: number;
  costUsd: number;
  firstQuestion: string | null;
  /** The distinct ways its replies were made (answer, fixed, strike...). */
  actions: string[];
}

/** The newest conversations, newest first (`npm run transcripts -- recent`). */
export async function recentConversations(sql: Sql, limit = 20): Promise<ConversationSummary[]> {
  const rows = await sql<
    { id: string; visitor_id: string; started_at: Date; messages: number; cost: number; first: string | null; actions: string[] | null }[]
  >`
    select c.id, c.visitor_id, c.started_at,
           count(m.id)::int as messages,
           coalesce(sum(m.cost_usd), 0)::float8 as cost,
           (select text from messages f where f.conversation_id = c.id and f.role = 'visitor' order by f.id limit 1) as first,
           array_agg(distinct m.action) filter (where m.role = 'visitor' and m.action is not null) as actions
    from conversations c left join messages m on m.conversation_id = c.id
    group by c.id order by c.started_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    visitorId: r.visitor_id,
    startedAt: r.started_at,
    messages: r.messages,
    costUsd: r.cost,
    firstQuestion: r.first,
    actions: r.actions ?? [],
  }));
}

/** The stage timings of the latest visitor messages (`npm run speed`). */
export async function recentTimings(sql: Sql, limit = 500): Promise<Record<string, number>[]> {
  const rows = await sql<{ timings: Record<string, number> }[]>`
    select timings from messages where role = 'visitor' and timings is not null order by id desc limit ${limit}`;
  return rows.map((r) => r.timings);
}

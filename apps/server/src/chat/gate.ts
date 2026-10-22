/**
 * The gate (plan §7.1 step 1, docs/phase-5-chat-plan.md): code only, no AI, and nothing a visitor
 * can talk their way past. It runs in this order, and the first problem is the answer: the browser
 * isn't locked, the message and job posting aren't too long, the browser and its IP address
 * haven't sent too much, and the month's spending is under the cap. A failure is one of the fixed
 * GATE replies; the secret header and the cookie are checked before this, in app.ts.
 */
import {
  claimSpendAlert,
  getVisitor,
  ipSpendSince,
  messageCounts,
  spendBetween,
  touchVisitor,
  unlockIfExpired,
} from "../db/chat.ts";
import type { Sql } from "../db/client.ts";
import { setting } from "../env.ts";
import { sendMail } from "../mail.ts";
import { GATE } from "./replies.ts";

export interface GateLimits {
  /** Characters in a chat message. */
  maxMessage: number;
  /** Characters in a pasted job posting. */
  maxJobPost: number;
  perBrowser5min: number;
  perBrowserDay: number;
  perIp10min: number;
  /** New browsers one IP address may create in an hour (checked when a browser is created, in app.ts). */
  newVisitorsPerIpHour: number;
  /** The month's AI spending, in dollars, at which the chat pauses. */
  spendCapUsd: number;
  /**
   * What one IP address's messages and handoffs may cost in a UTC day, in dollars, so many browsers
   * from one address can't drain the month's cap. The reply is the "all I can answer today" one.
   */
  perIpDayUsd: number;
}

/** The starting values of plan §7.7; the spending cap comes from SPEND_CAP_USD. */
export function defaultLimits(): GateLimits {
  return {
    maxMessage: 1000,
    maxJobPost: 6000,
    perBrowser5min: 10,
    perBrowserDay: 60,
    perIp10min: 30,
    newVisitorsPerIpHour: 5,
    spendCapUsd: Number(setting("SPEND_CAP_USD", "18")),
    perIpDayUsd: 2,
  };
}

export interface GateInput {
  visitorId: string;
  ipHash: string;
  message: string;
  jobPost: string | null;
}

export type GateResult =
  /** Let through. `release` must be called when the message has been handled. */
  | { ok: true; release: () => void }
  | { ok: false; reason: keyof typeof GATE; text: string };

export interface Gate {
  limits: GateLimits;
  check(input: GateInput): Promise<GateResult>;
  /** Whether the month's spending has reached the cap (sending the one-a-month email the first time). */
  overCap(): Promise<boolean>;
  /**
   * Whether this browser is locked (a lock that has run out is lifted first). For the question
   * buttons, which call no AI and so skip the message limits and the spending cap.
   */
  isLocked(visitorId: string): Promise<boolean>;
}

export interface GateOptions {
  sql: Sql;
  limits: GateLimits;
  /** Sends the one-a-month spending-cap email. */
  mail?: (mail: { subject: string; text: string }) => Promise<unknown>;
  now?: () => Date;
  log?: (line: string) => void;
}

const refuse = (reason: keyof typeof GATE): GateResult => ({ ok: false, reason, text: GATE[reason] });

export function makeGate(options: GateOptions): Gate {
  const { sql, limits, mail = sendMail, now = () => new Date(), log = console.log } = options;
  /**
   * Browsers with a message being handled right now. The rate limits count saved messages, which
   * are saved at the end, so without this a burst sent all at once would all be let in.
   */
  const busy = new Set<string>();

  /** The month's spending against the cap; the first time it's reached, you get the email. */
  async function spendingReached(): Promise<boolean> {
    const at = now();
    const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const until = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    const spent = await spendBetween(sql, from, until);
    if (spent < limits.spendCapUsd) return false;
    const month = from.toISOString().slice(0, 7);
    if (await claimSpendAlert(sql, month)) {
      try {
        await mail({
          subject: `Chat paused: this month's spending reached $${limits.spendCapUsd}`,
          text:
            `The chat on your site has paused for ${month}: Claude spending this month is $${spent.toFixed(2)}, ` +
            `at or over the $${limits.spendCapUsd} cap (SPEND_CAP_USD).\n\n` +
            `Visitors see a short "resting until next month" reply. The chat starts again on the 1st (UTC), ` +
            `or sooner if you raise SPEND_CAP_USD in .env and restart the api.`,
        });
      } catch (err) {
        log(`!! ALERT: the spending-cap email FAILED (${err instanceof Error ? err.message.slice(0, 160) : "error"}); the chat is paused for ${month}`);
      }
    }
    return true;
  }

  async function checkAll(input: GateInput): Promise<GateResult | null> {
    // A lock that has run out is lifted here, strikes and all, in one update (plan §7.2).
    await unlockIfExpired(sql, input.visitorId);
    const visitor = await getVisitor(sql, input.visitorId);
    if (!visitor) throw new Error("unknown visitor");
    if (visitor.lockedUntil) return refuse("locked");

    if (input.message.length > limits.maxMessage) return refuse("tooLong");
    if (input.jobPost && input.jobPost.length > limits.maxJobPost) return refuse("jobPostTooLong");

    // The day's limit first: when both apply, "come back tomorrow" is the true one.
    const counts = await messageCounts(sql, input.visitorId, input.ipHash);
    if (counts.day >= limits.perBrowserDay) return refuse("daily");
    if (counts.fiveMinutes >= limits.perBrowser5min) return refuse("tooFast");
    if (counts.ipTenMinutes >= limits.perIp10min) return refuse("tooFast");
    const at = now();
    const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    if ((await ipSpendSince(sql, input.ipHash, today)) >= limits.perIpDayUsd) return refuse("daily");

    if (await spendingReached()) return refuse("spendCap");

    await touchVisitor(sql, input.visitorId);
    return null;
  }

  return {
    limits,
    overCap: spendingReached,
    async isLocked(visitorId) {
      await unlockIfExpired(sql, visitorId);
      const visitor = await getVisitor(sql, visitorId);
      if (!visitor) throw new Error("unknown visitor");
      return visitor.lockedUntil !== null;
    },
    async check(input) {
      if (busy.has(input.visitorId)) return refuse("tooFast");
      busy.add(input.visitorId);
      let failure: GateResult | null;
      try {
        failure = await checkAll(input);
      } catch (err) {
        busy.delete(input.visitorId);
        throw err;
      }
      if (failure) {
        busy.delete(input.visitorId);
        return failure;
      }
      let released = false;
      return {
        ok: true,
        release: () => {
          if (!released) busy.delete(input.visitorId);
          released = true;
        },
      };
    },
  };
}

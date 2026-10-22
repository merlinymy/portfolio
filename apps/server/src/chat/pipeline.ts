/**
 * One visitor message, start to finish (plan §7.1, docs/phase-5-chat-plan.md): gate, pre-filter,
 * strike check, policy, strike, answer, output check, clean, voice, save. Events go out through
 * `emit` in the shared order: meta, state thinking, [strike], [handoff], state speaking right
 * before the first sentence, the sentences, done.
 *
 * Every stage is handed in (ChatDeps and the pieces on PipelineContext), so tests can stand in for
 * any of them. Rules that hold throughout:
 * - a stage that throws ends the reply with ERROR and never a strike;
 * - nothing is spoken until every check on it has passed;
 * - nothing is paid for before the message's row is saved (so it counts against the limits), and no
 *   reply goes out that couldn't be recorded afterwards;
 * - "strike on repeat", the small-talk cap and the strike check's memory follow the browser over a
 *   window of hours, not the conversation, so starting a new conversation resets nothing.
 */
import { randomUUID } from "node:crypto";
import type { ChatEvent, ReplyKind, VisitorStatus } from "@portfolio/shared/chat";
import {
  createConversation,
  getConversation,
  latestConversation,
  latestRiskNote,
  recentTurns,
  recordStrike,
  refusedCategories,
  reserveMessageId,
  saveMessage,
  setRiskNote,
  takeSmallTalk,
  visitorStatus,
} from "../db/chat.ts";
import type { MessageRow } from "../db/chat.ts";
import type { Sql } from "../db/client.ts";
import { isUuid, stripControl } from "../identity.ts";
import type { Gate } from "./gate.ts";
import { DISTRESS, ENGLISH_ONLY, ERROR, HANDOFF, REFUSE, strike } from "./replies.ts";
import type { Action, Category, ChatDeps, Spoken, StrikeVerdict, Turn, Usage } from "./types.ts";
import type { Semaphore } from "./voice.ts";

/** A generated answer is cut to this many words, whatever the model wrote (plan §7.7: about 120). */
export const MAX_ANSWER_WORDS = 150;

/** How long a reply waits for a voice slot before it goes out as text only. */
const VOICE_WAIT_MS = 20_000;

export interface PipelineContext {
  sql: Sql;
  deps: ChatDeps;
  gate: Gate;
  /** policy.ts: what to do with a category, given the ones already refused by this browser. */
  decide(category: Category, refusedBefore: ReadonlySet<Category>): { action: Action; refusal?: keyof typeof REFUSE };
  /** clean.ts */
  cleanReply(text: string, allowed: readonly string[]): string;
  /** clean.ts: a reply cut into sentences of at most 600 characters. */
  sentences(text: string): string[];
  allowedLinks: readonly string[];
  /** At most this many replies are voiced at once; the others wait (plan §7.7). */
  voice: Semaphore;
  /** Milliseconds a reply waits for a voice slot before it's sent as text only. Default 20,000. */
  voiceWaitMs?: number;
  log: (line: string) => void;
}

export interface MessageInput {
  visitorId: string;
  ipHash: string;
  message: string;
  jobPost?: string | null;
  /** The conversation to continue; a new one is made if it's missing or isn't this browser's. */
  conversationId?: string | null;
}

export interface HandleOptions {
  /** Aborts when the visitor leaves: the expensive stages that haven't started are skipped. */
  signal?: AbortSignal;
  /** false skips voicing: sentences go out with no audio (the red-team run, plan §9). */
  speak?: boolean;
}

export interface MessageResult {
  conversationId: string;
  messageId: string;
  /** How the reply was made (the visitor row's action). */
  kind: ReplyKind;
  /** What the strike check made of the message; null if it never ran (gate, pre-filter, errors). */
  category: Category | null;
  intent: string | null;
  reason: string | null;
  /** The reply, as said. */
  text: string;
  /** A strike was given for this message. */
  struck: boolean;
  /** The strike's standing, if one was given. */
  strike: VisitorStatus | null;
  /** Whether the handoff button was offered. */
  handoff: boolean;
  costUsd: number;
  /** Milliseconds per stage: gate, prefilter, strike_check, search, answer, output_check, first_audio, total. */
  timings: Record<string, number>;
  /** The visitor left before the reply was made; nothing was said or answered. */
  abandoned: boolean;
}

/** What was decided to say, before any of it is voiced. */
interface Outcome {
  kind: ReplyKind;
  text: string;
  category: Category | null;
  intent: string | null;
  reason: string | null;
  handoff: boolean;
  strike: VisitorStatus | null;
  passages: string[] | null;
}

/** The visitor left while the reply was being made. */
class Left extends Error {}

const WORDS_PER_SECOND = 2.5;

/** A sentence's length in seconds when it couldn't be voiced, for the page's text reveal. */
function estimateSeconds(text: string): number {
  return Math.round(Math.max(1, text.split(/\s+/).length / WORDS_PER_SECOND) * 10) / 10;
}

/** An error in a few words for the log: its kind and status, never anything a visitor typed. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return "error";
  const status = (err as { status?: unknown }).status;
  return `${err.name}${typeof status === "number" ? ` ${status}` : ""}: ${err.message.slice(0, 160)}`;
}

/**
 * What a Claude call that failed after the API answered (a refusal, running out of tokens, an
 * unreadable answer) still cost: claude.ts's ClaudeCallError carries it as `usage`. The tokens were
 * billed, so they count toward the message's cost and the month's cap.
 */
export function failedCallUsage(err: unknown): Usage | null {
  const usage = (err as { usage?: unknown } | null)?.usage as Partial<Usage> | null | undefined;
  return usage && typeof usage === "object" && typeof usage.costUsd === "number" && typeof usage.model === "string" ? (usage as Usage) : null;
}

/**
 * The reply cut to at most `max` words, at the last sentence end that fits, so what's checked and
 * spoken is never longer than the length the answer instructions ask for. A reply already short
 * enough is returned as it is.
 */
export function limitWords(text: string, max: number, split: (text: string) => string[]): string {
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  if (count(text) <= max) return text;
  const kept: string[] = [];
  let words = 0;
  for (const piece of split(text)) {
    const n = count(piece);
    if (words + n > max) break;
    kept.push(piece);
    words += n;
  }
  if (kept.length > 0) return kept.join(" ");
  // The very first sentence is already too long: cut it at the limit.
  const cut = text.trim().split(/\s+/).slice(0, max).join(" ").replace(/[,;:\-–—]+$/, "");
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * Wraps `emit` for one reply: once a send fails (the stream closed) later sends are skipped instead
 * of failing the reply, and `gone()` says whether the visitor has left or the stream has closed.
 */
export function makeSender(emit: (event: ChatEvent) => void | Promise<void>, signal?: AbortSignal) {
  let closed = false;
  const send = async (event: ChatEvent): Promise<void> => {
    if (closed) return;
    try {
      await emit(event);
    } catch {
      closed = true;
    }
  };
  const gone = () => closed || signal?.aborted === true;
  return { send, gone };
}

/**
 * Sends a reply one sentence at a time, each voiced as soon as it's ready (state speaking goes out
 * just before the first). It waits for a voice slot, but only so long: past `voiceWaitMs` the
 * reply goes out as text only. Stops quietly when the visitor has left.
 */
export async function playReply(
  ctx: Pick<PipelineContext, "deps" | "sentences" | "voice" | "voiceWaitMs" | "log">,
  text: string,
  o: {
    /** Keep each sentence's voicing on disk, for text that comes up again. */
    cache: boolean;
    /** false sends the sentences with no audio. */
    speak?: boolean;
    signal?: AbortSignal;
    send: (event: ChatEvent) => Promise<void>;
    gone: () => boolean;
    onFirstSentence?: () => void;
  },
): Promise<void> {
  let parts: string[];
  try {
    parts = ctx.sentences(text);
  } catch {
    parts = [];
  }
  if (parts.length === 0) parts = [text];

  let voiced = o.speak !== false;
  let give: (() => void) | undefined;
  if (voiced) {
    // Waiting for a slot ends when the visitor leaves, or after a while, when the reply goes out as text only.
    const tired = new AbortController();
    const timer = setTimeout(() => tired.abort(), ctx.voiceWaitMs ?? VOICE_WAIT_MS);
    try {
      give = await ctx.voice.acquire(o.signal ? AbortSignal.any([o.signal, tired.signal]) : tired.signal);
    } catch {
      if (o.gone()) return;
      voiced = false;
      ctx.log("chat: no voice slot came free in time; the reply went out as text only");
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (const [index, sentence] of parts.entries()) {
      if (o.gone()) break;
      let spoken: Spoken | null = null;
      if (voiced) {
        try {
          spoken = await ctx.deps.speak(sentence, { cache: o.cache });
        } catch {
          spoken = null;
        }
      }
      if (index === 0) {
        o.onFirstSentence?.();
        await o.send({ type: "state", state: "speaking" });
      }
      await o.send({
        type: "sentence",
        index,
        text: sentence,
        audio: spoken?.audio ?? null,
        duration: spoken?.duration ?? estimateSeconds(sentence),
        words: spoken?.words ?? null,
        visemes: spoken?.visemes ?? null,
      });
    }
  } finally {
    give?.();
  }
}

export async function handleMessage(
  ctx: PipelineContext,
  input: MessageInput,
  emit: (event: ChatEvent) => void | Promise<void>,
  options: HandleOptions = {},
): Promise<MessageResult> {
  const { sql, deps } = ctx;
  const { visitorId, ipHash } = input;
  // Whatever arrives is cleaned first: a NUL character would make Postgres refuse the row.
  const message = stripControl(input.message);
  const jobPost = input.jobPost ? stripControl(input.jobPost) || null : null;
  const started = performance.now();
  const timings: Record<string, number> = {};
  const usages: Usage[] = [];

  const { send, gone } = makeSender(emit, options.signal);

  const timed = async <T>(stage: string, run: () => T | Promise<T>): Promise<T> => {
    const at = performance.now();
    try {
      return await run();
    } finally {
      timings[stage] = Math.round(performance.now() - at);
    }
  };

  const passed = await timed("gate", () => ctx.gate.check({ visitorId, ipHash, message, jobPost }));
  try {
    // The conversation, and the message's id, are known before anything else so `meta` can go first.
    let conversation = isUuid(input.conversationId) ? await getConversation(sql, input.conversationId, visitorId) : undefined;
    // A refusal is recorded in the browser's latest conversation rather than starting another one.
    if (!conversation && !passed.ok) conversation = await latestConversation(sql, visitorId);
    if (!conversation) {
      const id = randomUUID();
      await createConversation(sql, id, visitorId);
      conversation = { id, riskNote: "", smallTalk: 0 };
    }
    const conversationId = conversation.id;
    const messageId = await reserveMessageId(sql);
    await send({ type: "meta", conversationId, messageId });
    await send({ type: "state", state: "thinking" });

    const totals = () => {
      const models = [...new Set(usages.map((u) => u.model))];
      const sum = (pick: (u: Usage) => number) => usages.reduce((n, u) => n + pick(u), 0);
      return {
        model: models.length ? models.join(", ") : null,
        inputTokens: sum((u) => u.inputTokens),
        outputTokens: sum((u) => u.outputTokens),
        cacheReadTokens: sum((u) => u.cacheReadTokens),
        cacheWriteTokens: sum((u) => u.cacheWriteTokens),
        costUsd: sum((u) => u.costUsd),
      };
    };

    /** The visitor's row as known so far; saved again, filled in, when the reply is decided. */
    const visitorRow = (o: { kind: ReplyKind | null; category: string | null; intent: string | null; reason: string | null }): MessageRow => ({
      id: messageId,
      conversationId,
      visitorId,
      ipHash,
      role: "visitor",
      // A message the gate turned away may be far over the limit; keep only what a limit allows.
      text: message.slice(0, ctx.gate.limits.maxMessage),
      // A refused message's job posting was never read, and could be huge: it isn't kept.
      jobPost: passed.ok && jobPost ? jobPost.slice(0, ctx.gate.limits.maxJobPost) : null,
      category: o.category,
      intent: o.intent,
      action: o.kind,
      reason: o.reason,
      ...totals(),
      timings: { ...timings },
    });

    const assistantRow = (said: Outcome): MessageRow => ({
      conversationId,
      visitorId,
      ipHash,
      role: "assistant",
      text: said.text,
      passages: said.passages,
      action: said.kind,
    });

    let stage = "gate";
    let verdict: StrikeVerdict | undefined;
    let abandoned = false;

    const errorOutcome = (reason: string): Outcome => ({
      kind: "error",
      text: ERROR,
      category: verdict?.category ?? null,
      intent: verdict?.intent ?? null,
      reason: reason.slice(0, 300),
      handoff: false,
      strike: null,
      passages: null,
    });

    const giveStrike = async (category: Category, reason: string, intent: string | null): Promise<Outcome> => {
      stage = "strike";
      const row = visitorRow({ kind: "strike", category, intent, reason });
      const result = await recordStrike(sql, { message: row, category, reason });
      const status = visitorStatus(result);
      return { kind: "strike", text: strike(status.strikesLeft), category, intent, reason, handoff: true, strike: status, passages: null };
    };

    const generate = async (checked: StrikeVerdict, history: Turn[]): Promise<Outcome> => {
      if (gone()) throw new Left();
      stage = "search";
      const passages = await timed("search", () => deps.search(message));
      const ids = passages.map((p) => p.id);

      if (gone()) throw new Left();
      stage = "answer";
      const written = await timed("answer", () => deps.answer({ message, jobPost, history, passages }));
      usages.push(written.usage);

      stage = "clean";
      // Cleaned, then cut to the length limit, before the check: what's checked is what's said.
      const reply = limitWords(ctx.cleanReply(written.text, ctx.allowedLinks).trim(), MAX_ANSWER_WORDS, ctx.sentences);
      if (!reply) throw new Error("the answer was empty once cleaned");

      if (gone()) throw new Left();
      stage = "output_check";
      const output = await timed("output_check", () => deps.checkOutput({ reply, passages, rules: deps.fixed.rules() }));
      usages.push(output.usage);

      const base = { category: checked.category, intent: checked.intent, passages: ids, strike: null };
      if (!output.ok) {
        // Only what's said is kept; what the output check found goes in the reason.
        const problems = output.problems.map((p) => `${p.kind}: ${p.detail}`).join("; ");
        return { ...base, kind: "handoff", text: HANDOFF, handoff: true, reason: `output check: ${problems || "not ok"}` };
      }
      return { ...base, kind: "answer", text: reply, handoff: false, reason: checked.reason };
    };

    const decideOutcome = async (): Promise<Outcome> => {
      const none = { category: null, intent: null, reason: null, handoff: false, strike: null, passages: null };
      try {
        // The row goes in before anything is paid for: it counts against the limits from now on, and
        // if it can't be saved the message isn't answered at all.
        stage = "save";
        await saveMessage(sql, visitorRow({ kind: null, category: null, intent: null, reason: null }));

        stage = "prefilter";
        const flags = await timed("prefilter", () => deps.prefilter(message));
        const why = flags.reasons.join("; ");
        if (flags.disguised) return await giveStrike("disguised", `disguised text${why ? `: ${why}` : ""}`, null);
        if (flags.nonEnglish) {
          return { ...none, kind: "english_only", text: ENGLISH_ONLY, category: "other_language", reason: `not English${why ? `: ${why}` : ""}` };
        }

        // What the strike check and the policy remember is the browser's, across conversations.
        stage = "history";
        const [history, refusedBefore, riskNote] = await Promise.all([
          recentTurns(sql, visitorId, 10, 2),
          refusedCategories(sql, visitorId, 24),
          latestRiskNote(sql, visitorId, 2),
        ]);

        if (gone()) throw new Left();
        stage = "strike_check";
        const checked = await timed("strike_check", () =>
          deps.strikeCheck({ message, jobPost, history, riskNote, flags, intents: deps.fixed.intents() }),
        );
        usages.push(checked.usage);
        verdict = checked;
        await setRiskNote(sql, conversationId, String(checked.riskNote ?? "").slice(0, 600));

        stage = "policy";
        const decision = ctx.decide(checked.category, refusedBefore);
        const said = { ...none, category: checked.category, intent: checked.intent, reason: checked.reason };
        const topic = checked.intent ? deps.fixed.get(checked.intent) : undefined;

        switch (decision.action) {
          case "strike":
            return await giveStrike(checked.category, checked.reason, checked.intent);
          case "refuse":
            if (!decision.refusal) throw new Error("the policy refused without saying how");
            return { ...said, kind: "refuse", text: REFUSE[decision.refusal], handoff: decision.refusal === "private_details" };
          case "fixed":
            if (topic?.answer) return { ...said, kind: "fixed", text: topic.answer };
            break; // no approved answer to give word for word: answer it the usual way
          case "small_talk":
            if (topic?.answer) {
              stage = "small_talk";
              const { perConversation, afterLimit } = deps.fixed.smallTalk;
              // The cap is per browser over a day (the setting's name says conversation, but a new
              // conversation can't earn more small talk).
              return (await takeSmallTalk(sql, visitorId, perConversation, 24))
                ? { ...said, kind: "small_talk", text: topic.answer }
                : { ...said, kind: "small_talk", text: afterLimit, handoff: true };
            }
            break;
          case "handoff":
            return { ...said, kind: "handoff", text: HANDOFF, handoff: true };
          case "distress":
            return { ...said, kind: "distress", text: DISTRESS };
          case "english_only":
            return { ...said, kind: "english_only", text: ENGLISH_ONLY };
          case "answer":
            break;
          default:
            throw new Error(`the policy returned an unknown action (${decision.action})`);
        }
        return await generate(checked, history);
      } catch (err) {
        if (err instanceof Left) {
          abandoned = true;
          return errorOutcome("the visitor left before the reply was made");
        }
        // A call that failed after the API answered was still billed.
        const billed = failedCallUsage(err);
        if (billed) usages.push(billed);
        ctx.log(`chat: ${stage} failed (${describe(err)})`);
        return errorOutcome(`${stage} failed: ${describe(err)}`);
      }
    };

    /** Saves the exchange; once more if that fails. False if it still couldn't be saved. */
    const trySave = async (said: Outcome, withReply: boolean): Promise<boolean> => {
      let failure: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await sql.begin(async (tx) => {
            await saveMessage(tx, visitorRow(said));
            if (withReply) await saveMessage(tx, assistantRow(said));
          });
          return true;
        } catch (err) {
          failure = err;
        }
      }
      ctx.log(`!! chat: couldn't save a message (${describe(failure)}); its cost was $${totals().costUsd.toFixed(4)}`);
      return false;
    };

    const voiceReply = (said: Outcome) =>
      playReply(ctx, said.text, {
        // Only generated answers are new text each time; everything else is worth keeping.
        cache: said.kind !== "answer",
        speak: options.speak,
        signal: options.signal,
        send,
        gone,
        onFirstSentence: () => {
          timings.first_audio = Math.round(performance.now() - started);
        },
      });

    let said: Outcome = passed.ok
      ? await decideOutcome()
      : { kind: "gate", text: passed.text, category: null, intent: null, reason: passed.reason, handoff: false, strike: null, passages: null };

    // Recorded before anything is said, and before `done`, so the visitor's next message already
    // finds this one in the history. A reply that couldn't be recorded isn't given: a message must
    // never get an answer while escaping the limits and the cost count. (A strike was already
    // recorded in its own transaction, so it stands.)
    if (!(await trySave(said, !abandoned)) && !abandoned && !said.strike && said.kind !== "gate" && said.kind !== "error") {
      said = errorOutcome("the message couldn't be saved");
      await trySave(said, true);
    }

    if (!abandoned) {
      if (said.strike) await send({ type: "strike", ...said.strike });
      if (said.handoff) await send({ type: "handoff" });
      await voiceReply(said);
    }

    timings.total = Math.round(performance.now() - started);
    // The timings of voicing and of the whole message are only known now; a failure here costs just those.
    await saveMessage(sql, visitorRow(said)).catch((err) => ctx.log(`chat: couldn't save the timings (${describe(err)})`));
    if (!abandoned) await send({ type: "done", kind: said.kind, text: said.text });

    return {
      conversationId,
      messageId,
      kind: said.kind,
      category: (said.category ?? null) as Category | null,
      intent: said.intent,
      reason: said.reason,
      text: said.text,
      struck: said.strike !== null,
      strike: said.strike,
      handoff: said.handoff,
      costUsd: totals().costUsd,
      timings,
      abandoned,
    };
  } finally {
    if (passed.ok) passed.release();
  }
}

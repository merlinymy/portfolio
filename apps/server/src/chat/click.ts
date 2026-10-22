/**
 * A click on one of the chat's question buttons (plan §7.11, changed 2026-10-21). The api plays a
 * version that was voiced ahead of time and is kept on this Mac (knowledge/cache/voice): no AI call,
 * no search, no spending. It answers with the same events as a typed message, ending in kind "fixed".
 *
 * Which version: the browser's n-th click on a button plays the approved version number n, in the
 * file's order, starting over after the last, so a repeat click is never the same wording twice in
 * a row while there are two or more.
 *
 * Because no AI is called, a click skips the message limits and the spending cap (the in-memory
 * request limiter in app.ts still applies). A locked browser is turned away like a typed message.
 * A click is never a strike and never small talk. Both sides are written to the transcript, so the
 * strike check's history sees what was answered.
 */
import { randomUUID } from "node:crypto";
import type { ChatEvent } from "@portfolio/shared/chat";
import {
  createConversation,
  getConversation,
  latestConversation,
  recordButtonClick,
  reserveMessageId,
  saveMessage,
  touchVisitor,
} from "../db/chat.ts";
import { isUuid } from "../identity.ts";
import type { Button } from "./buttons.ts";
import { makeSender, playReply } from "./pipeline.ts";
import type { PipelineContext } from "./pipeline.ts";
import { GATE } from "./replies.ts";

export interface ClickInput {
  visitorId: string;
  ipHash: string;
  /** The conversation to add to; the browser's latest is used if it's missing or isn't theirs. */
  conversationId?: string | null;
}

export interface ClickResult {
  conversationId: string;
  messageId: string;
  /** "fixed", or "gate" for a locked browser. */
  kind: "fixed" | "gate";
  /** What was played. */
  text: string;
  /** Which approved version played (0 is the first), or null if none did. */
  version: number | null;
  timings: Record<string, number>;
}

export async function handleButtonClick(
  ctx: PipelineContext,
  button: Button,
  input: ClickInput,
  emit: (event: ChatEvent) => void | Promise<void>,
  options: { signal?: AbortSignal; speak?: boolean } = {},
): Promise<ClickResult> {
  const { sql } = ctx;
  const { visitorId, ipHash } = input;
  const started = performance.now();
  const timings: Record<string, number> = {};
  const { send, gone } = makeSender(emit, options.signal);

  const locked = await ctx.gate.isLocked(visitorId);

  // The transcript rows go in the browser's latest conversation, or a first one.
  let conversation = isUuid(input.conversationId) ? await getConversation(sql, input.conversationId, visitorId) : undefined;
  conversation ??= await latestConversation(sql, visitorId);
  if (!conversation) {
    const id = randomUUID();
    await createConversation(sql, id, visitorId);
    conversation = { id, riskNote: "", smallTalk: 0 };
  }
  const conversationId = conversation.id;
  const messageId = await reserveMessageId(sql);
  await send({ type: "meta", conversationId, messageId });
  await send({ type: "state", state: "thinking" });

  let kind: ClickResult["kind"] = "fixed";
  let text: string = GATE.locked;
  let version: number | null = null;
  if (locked) {
    kind = "gate";
  } else {
    const clicksBefore = await recordButtonClick(sql, visitorId, conversationId, button.id);
    version = clicksBefore % button.versions.length;
    text = button.versions[version];
    await touchVisitor(sql, visitorId);
  }

  const visitorRow = () => ({
    id: messageId,
    conversationId,
    visitorId,
    ipHash,
    role: "visitor" as const,
    // What a typed question would have been: the button's own words.
    text: button.question,
    category: null,
    intent: `button:${button.id}`,
    action: kind,
    reason: locked ? "locked" : null,
    costUsd: 0,
    timings: { ...timings },
  });

  // Recorded before it's played, so the visitor's next message already finds it in the history. A
  // click costs nothing and counts against nothing, so if this fails it's logged and the reply goes on.
  try {
    await sql.begin(async (tx) => {
      await saveMessage(tx, visitorRow());
      await saveMessage(tx, { conversationId, visitorId, ipHash, role: "assistant", text, action: kind });
    });
  } catch (err) {
    ctx.log(`!! chat: couldn't save a button click's transcript (${err instanceof Error ? err.name : "error"})`);
  }

  await playReply(ctx, text, {
    cache: true,
    speak: options.speak,
    signal: options.signal,
    send,
    gone,
    onFirstSentence: () => {
      timings.first_audio = Math.round(performance.now() - started);
    },
  });

  timings.total = Math.round(performance.now() - started);
  await saveMessage(sql, visitorRow()).catch((err) => ctx.log(`chat: couldn't save a button click's timings (${err instanceof Error ? err.name : "error"})`));
  await send({ type: "done", kind, text });
  return { conversationId, messageId, kind, text, version, timings };
}

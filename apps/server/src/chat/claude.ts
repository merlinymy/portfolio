/**
 * What the chat's four Claude calls (strike check, answer, output check, handoff summary) have in
 * common: the client, the prices, and the helpers that put text in front of the model safely and
 * read what comes back. The calls themselves are in strikeCheck.ts, answer.ts, outputCheck.ts and
 * summary.ts (docs/phase-5-chat-plan.md, "Claude calls").
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodType } from "zod";
import { setting } from "../env.ts";
import type { Hit, Turn, Usage } from "./types.ts";

/** The checks are fast and cheap (Claude Haiku 5.5); the answer is what a visitor reads (Claude Sonnet 5.5). */
export const MODELS = { check: "claude-haiku-5-5", answer: "claude-sonnet-5-5" } as const;

/**
 * The part of the SDK's client the calls use. A test hands in a stand-in with the same method that
 * records each request and returns a canned response. (The SDK's `messages.parse` isn't used: it
 * throws away the response when the reply doesn't fit the schema, and with it the usage, which
 * still has to be paid for. readStructured does the same parsing and keeps it.)
 */
export type ClaudeClient = { messages: Pick<Anthropic["messages"], "create"> };

/**
 * The real client. A visitor is waiting on every call, so a request gives up after 30 seconds; the
 * SDK then retries it twice (it also retries rate limits and server errors), so the worst case for
 * one call is about 90 seconds, after which the error reaches the pipeline.
 */
export function claudeClient(): Anthropic {
  return new Anthropic({ apiKey: setting("ANTHROPIC_API_KEY"), timeout: 30_000, maxRetries: 2 });
}

interface Prices {
  /** Dollars per million tokens, for each kind of token. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * From the Claude API reference, 2026-10-21. Haiku 5.5 costs more ($0.50 in, $2.50 out) for a
 * prompt over 100,000 tokens; ours are a few thousand, so that rate isn't modelled.
 */
const PRICES = new Map<string, Prices>([
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ["claude-haiku-5-5", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
]);

/** The token counts of a response (`message.usage`); the cache counts are null when nothing was cached. */
export type SdkUsage = Pick<
  Anthropic.Messages.Usage,
  "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
>;

/**
 * One call's tokens and cost. As the API reports them, `inputTokens` counts only the tokens that
 * were neither read from nor written to the cache; those are counted separately, each at its own
 * price. Throws for a model with no price, so a new model can't be used and billed as zero.
 */
export function usageOf(model: string, usage: SdkUsage): Usage {
  const price = PRICES.get(model);
  if (!price) throw new Error(`no price is known for the model "${model}": add it to PRICES in src/chat/claude.ts`);
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  // tokens x (dollars per million tokens) = millionths of a dollar. Rounded to the nearest
  // ten-billionth of a dollar, finer than the prices go, so sums don't carry floating-point noise.
  const micros =
    inputTokens * price.input +
    outputTokens * price.output +
    cacheReadTokens * price.cacheRead +
    cacheWriteTokens * price.cacheWrite;
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: Math.round(micros * 1e4) / 1e10,
  };
}

/** What a request needs to force a reply into a shape, and what reads the reply back as a T. */
export type OutputFormat<T> = Anthropic.Messages.JSONOutputFormat & { parse(content: string): T };

/**
 * A zod schema as a structured output: the API makes the reply fit the schema, and readStructured
 * reads it back, checked again with the same schema.
 *
 * Note: this SDK version (0.131.0) moves an enum's values into the field's description instead of
 * into the schema, so the model is told the allowed values but isn't forced to pick one; the second
 * check with the schema still rejects anything else.
 */
export function outputFormat<T>(schema: ZodType<T>): OutputFormat<T> {
  return zodOutputFormat(schema);
}

/**
 * Makes untrusted text (a visitor's message, a job posting, anything the model wrote from them)
 * safe to put between our named tags: every "<" becomes "‹", so the text can't contain a tag of
 * its own, such as one that closes the section it's in and starts "instructions". Invisible
 * formatting characters (zero-width spaces and the like) are dropped, so they can't hide a tag.
 */
export function neutralize(text: string): string {
  return text.replace(/\p{Cf}/gu, "").replaceAll("<", "‹");
}

/** An untrusted part of the model's input, between named tags. */
export function section(tag: string, text: string): string {
  return `<${tag}>\n${neutralize(text)}\n</${tag}>`;
}

/** A part of the model's input that we wrote ourselves, or that comes from your own files. */
export function trustedSection(tag: string, text: string): string {
  return `<${tag}>\n${text}\n</${tag}>`;
}

/**
 * Conversation turns, each in its own tag so a turn's text can't pass itself off as a line from
 * the other side.
 */
export function renderTurns(turns: Turn[]): string {
  const body = turns.length
    ? turns.map((turn) => `<turn role="${turn.role}">\n${neutralize(turn.text)}\n</turn>`).join("\n")
    : "(no earlier messages)";
  return trustedSection("conversation", body);
}

/** The search results as the model reads them. They come from your own files, so they're left as written. */
export function renderPassages(passages: Hit[]): string {
  const body = passages.length
    ? passages.map((p) => `<passage>\nid: ${p.id}\ntitle: ${p.title}\n\n${p.body}\n</passage>`).join("\n")
    : "(none)";
  return trustedSection("passages", body);
}

/** All the text blocks of a response, joined and trimmed. */
export function textOf(message: { content: Anthropic.ContentBlock[] }): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

/**
 * A Claude call that failed after the API answered: a refusal, a reply cut off by the token limit,
 * a reply that doesn't fit its shape, or no text. The call still cost money, so `usage` says how
 * much, and the pipeline adds it to the month's spending before it turns the error into an error
 * reply. `usage` is null only if the response somehow carried no token counts. A call that never
 * got an answer (the network, a rejected request) throws the SDK's own error, which costs nothing.
 */
export class ClaudeCallError extends Error {
  readonly usage: Usage | null;
  /** The model that was called. */
  readonly model: string;

  constructor(message: string, model: string, usage: Usage | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClaudeCallError";
    this.model = model;
    this.usage = usage;
  }
}

/** A ClaudeCallError for a response that came back unusable, with the cost of that response. */
export function callError(
  message: string,
  model: string,
  response: { usage?: SdkUsage | null },
  options?: { cause?: unknown },
): ClaudeCallError {
  return new ClaudeCallError(message, model, response.usage ? usageOf(model, response.usage) : null, options);
}

/**
 * Throws a ClaudeCallError unless the model finished normally. A refusal, or an answer cut off by
 * the token limit, is never used: the pipeline turns the error into an error reply, never a strike
 * or a half reply. `allowCutOff` is for text that is still useful when short.
 */
export function assertFinished(
  message: Pick<Anthropic.Message, "stop_reason" | "stop_details" | "usage">,
  what: string,
  model: string,
  options: { allowCutOff?: boolean } = {},
): void {
  const reason = message.stop_reason;
  if (reason === "end_turn" || reason === "stop_sequence") return;
  if (reason === "max_tokens" && options.allowCutOff) return;
  if (reason === "refusal") {
    const details = message.stop_details;
    throw callError(`${what}: Claude refused (${details?.category ?? "no category"}${details?.explanation ? `: ${details.explanation}` : ""})`, model, message);
  }
  throw callError(`${what}: Claude stopped before finishing (stop reason: ${reason ?? "none"})`, model, message);
}

/**
 * The reply of a call made with an outputFormat, read back as a T. Like the SDK's `messages.parse`,
 * but a reply that doesn't fit is a ClaudeCallError that carries the call's usage. Throws one too if
 * Claude refused or stopped early (see assertFinished).
 */
export function readStructured<T>(message: Anthropic.Message, format: OutputFormat<T>, what: string, model: string): T {
  assertFinished(message, what, model);
  const text = textOf(message);
  if (!text) throw callError(`${what}: Claude's reply had no verdict in it`, model, message);
  try {
    return format.parse(text);
  } catch (error) {
    throw callError(`${what}: ${(error as Error).message}`, model, message, { cause: error });
  }
}

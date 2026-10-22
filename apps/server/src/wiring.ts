/**
 * Puts the chat's real parts together: your approved answers, search, the voice, the gate and, when
 * ANTHROPIC_API_KEY is set, the Claude calls. main.ts uses it to start the api, and the red-team
 * runner uses it to run messages through the same pipeline (with its own limits and `speak: false`).
 *
 * The Claude client and the instruction files are set up on first use, not at start, so the api
 * still starts without an API key: handoffs and the instant chips work, and a message that needs
 * Claude gets the fixed apology instead.
 */
import type { Sql } from "./db/client.ts";
import { ROOT, setting } from "./env.ts";
import { sendMail } from "./mail.ts";
import { search } from "./rag/search.ts";
import { makeAnswer } from "./chat/answer.ts";
import { loadButtons } from "./chat/buttons.ts";
import type { Button } from "./chat/buttons.ts";
import { claudeClient } from "./chat/claude.ts";
import { allowedLinks, cleanReply, sentences } from "./chat/clean.ts";
import { loadFixed } from "./chat/fixed.ts";
import { defaultLimits, makeGate } from "./chat/gate.ts";
import type { GateLimits } from "./chat/gate.ts";
import { makeOutputCheck } from "./chat/outputCheck.ts";
import { decide } from "./chat/policy.ts";
import type { PipelineContext } from "./chat/pipeline.ts";
import { prefilter } from "./chat/prefilter.ts";
import { loadPrompts } from "./chat/prompts.ts";
import { makeStrikeCheck } from "./chat/strikeCheck.ts";
import { makeSummary } from "./chat/summary.ts";
import type { ChatDeps, FixedAnswers, Turn, Usage } from "./chat/types.ts";
import { makeSemaphore, makeSpeaker } from "./chat/voice.ts";

export interface ChatSetupOptions {
  sql: Sql;
  /** Replaces some of the gate's limits (the red team lifts the rate limits). */
  limits?: Partial<GateLimits>;
  log?: (line: string) => void;
}

export interface ChatSetup {
  pipeline: PipelineContext;
  /** The question buttons (knowledge/buttons.yaml): every one, approved or not. Empty if the file isn't there. */
  buttons: Button[];
  summarize(turns: Turn[]): Promise<{ text: string; usage: Usage }>;
  claudeConfigured(): boolean;
}

/**
 * Loads knowledge/buttons.yaml. No file means no buttons (one line says so); a file that can't be
 * read as buttons is a startup error that names it, since a typo shouldn't quietly remove buttons.
 */
export async function readButtons(knowledge: string, fixed: FixedAnswers, log: (line: string) => void): Promise<Button[]> {
  const file = `${knowledge}/buttons.yaml`;
  let buttons: Button[];
  try {
    buttons = await loadButtons(knowledge, fixed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log("buttons: knowledge/buttons.yaml isn't there, so the chat has no question buttons");
      return [];
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.includes("buttons.yaml") ? message : `${file}: ${message}`);
  }
  for (const button of buttons) {
    if (button.versions.length === 0) log(`buttons: "${button.id}" has no approved version yet, so it isn't offered`);
  }
  return buttons;
}

export async function buildChat(options: ChatSetupOptions): Promise<ChatSetup> {
  const { sql, log = console.log } = options;
  const knowledge = `${ROOT}knowledge`;
  const fixed = await loadFixed(knowledge, `${ROOT}content`);
  const links = await allowedLinks(`${ROOT}content`);
  const buttons = await readButtons(knowledge, fixed, log);

  type Stages = {
    strikeCheck: ChatDeps["strikeCheck"];
    answer: ChatDeps["answer"];
    checkOutput: ChatDeps["checkOutput"];
    summary: (turns: Turn[]) => Promise<{ text: string; usage: Usage }>;
  };
  let stages: Promise<Stages> | undefined;
  const claude = (): Promise<Stages> => {
    stages ??= (async () => {
      const client = claudeClient(); // throws if ANTHROPIC_API_KEY isn't set
      const prompts = await loadPrompts(knowledge);
      return {
        strikeCheck: makeStrikeCheck(client, prompts),
        answer: makeAnswer(client, prompts),
        checkOutput: makeOutputCheck(client, prompts),
        summary: makeSummary(client, prompts),
      };
    })().catch((err) => {
      stages = undefined; // not kept: a fixed key or a restored file works without a restart
      throw err;
    });
    return stages;
  };

  const deps: ChatDeps = {
    prefilter,
    strikeCheck: async (input) => (await claude()).strikeCheck(input),
    search: (question) => search(sql, question),
    answer: async (input) => (await claude()).answer(input),
    checkOutput: async (input) => (await claude()).checkOutput(input),
    speak: makeSpeaker({
      modelsUrl: setting("MODELS_URL", "http://127.0.0.1:8790"),
      cacheDir: `${knowledge}/cache/voice`,
      timeoutMs: 30_000,
      log,
    }),
    fixed,
  };

  const limits = { ...defaultLimits(), ...options.limits };
  return {
    buttons,
    pipeline: {
      sql,
      deps,
      gate: makeGate({ sql, limits, mail: (mail) => sendMail(mail, undefined, undefined, log), log }),
      decide,
      cleanReply,
      sentences,
      allowedLinks: links,
      voice: makeSemaphore(3),
      log,
    },
    summarize: async (turns) => (await claude()).summary(turns),
    claudeConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

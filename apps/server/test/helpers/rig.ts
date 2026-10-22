/**
 * Stand-ins for every stage of the chat pipeline, for tests: no Claude, no model server. Each
 * stand-in records what it was called with, and a test changes what they answer through the
 * returned Rig.
 */
import type { Sql } from "../../src/db/client.ts";
import type { Button } from "../../src/chat/buttons.ts";
import { makeGate } from "../../src/chat/gate.ts";
import type { PipelineContext } from "../../src/chat/pipeline.ts";
import type { REFUSE } from "../../src/chat/replies.ts";
import type { Action, Category, ChatDeps, FixedAnswers, FixedEntry, Hit, PrefilterFlags, Spoken, StrikeVerdict, Usage } from "../../src/chat/types.ts";
import { makeSemaphore } from "../../src/chat/voice.ts";

export const haiku = (costUsd: number, inputTokens: number): Usage => ({
  model: "claude-haiku-5-5",
  inputTokens,
  outputTokens: 30,
  cacheReadTokens: 1000,
  cacheWriteTokens: 0,
  costUsd,
});
export const SONNET: Usage = { model: "claude-sonnet-5-5", inputTokens: 800, outputTokens: 160, cacheReadTokens: 3000, cacheWriteTokens: 100, costUsd: 0.0031 };

export const ENTRIES: FixedEntry[] = [
  { id: "salary_expectations", kind: "fixed", topic: "Pay", alsoAskedAs: [], answer: "I'm open to discussing pay once we know the role. It depends on the scope.", rules: ["never a number"] },
  { id: "hobbies", kind: "small_talk", topic: "Hobbies", alsoAskedAs: [], answer: "I like climbing and making coffee.", rules: [] },
  { id: "why_left", kind: "handoff", topic: "Why left", alsoAskedAs: [], answer: null, rules: [] },
  { id: "empty_fixed", kind: "fixed", topic: "Broken", alsoAskedAs: [], answer: null, rules: [] },
  { id: "tell-me-about-yourself", kind: "instant", topic: "About", alsoAskedAs: [], answer: "I'm a backend engineer.", rules: [] },
  { id: "whats-your-strongest-stack", kind: "instant", topic: "Stack", alsoAskedAs: [], answer: "TypeScript and Postgres.", rules: [] },
];
export const AFTER_LIMIT = "That's plenty of small talk from me. Want me to pass your details along?";
export const FIXED: FixedAnswers = {
  entries: ENTRIES,
  get: (id) => {
    const entry = ENTRIES.find((e) => e.id === id);
    return entry && { entry, answer: entry.answer };
  },
  intents: () => ENTRIES.map((e) => ({ id: e.id, kind: e.kind, topic: e.topic, alsoAskedAs: e.alsoAskedAs })),
  rules: () => ["never a number"],
  smallTalk: { perConversation: 2, afterLimit: AFTER_LIMIT },
};

/** policy.ts's table, as a stand-in so these tests don't depend on that file. */
export function decide(category: Category, refusedBefore: ReadonlySet<Category>): { action: Action; refusal?: keyof typeof REFUSE } {
  const refusals: Partial<Record<Category, keyof typeof REFUSE>> = { private_details: "private_details", badmouthing: "badmouthing", self_sabotage: "self_sabotage" };
  if (refusals[category]) return refusedBefore.has(category) ? { action: "strike" } : { action: "refuse", refusal: refusals[category] };
  if (category === "career" || category === "fabrication_bait") return { action: "answer" };
  if (category === "fixed" || category === "small_talk" || category === "handoff" || category === "distress") return { action: category };
  if (category === "other_language") return { action: "english_only" };
  return { action: "strike" };
}

/** Question buttons: one with three approved wordings (and a fourth not approved), one fixed answer, one with nothing approved yet. */
export const BUTTONS: Button[] = [
  {
    id: "about-you",
    question: "Tell me about yourself.",
    drafts: [
      { text: "I'm Merlin. I build AI tools for experts.", approved: true },
      { text: "Hi, Merlin here. I like useful AI. It has to be right.", approved: true },
      { text: "Short version: AI tools for experts.", approved: true },
      { text: "This wording was never approved.", approved: false },
    ],
    versions: ["I'm Merlin. I build AI tools for experts.", "Hi, Merlin here. I like useful AI. It has to be right.", "Short version: AI tools for experts."],
  },
  {
    id: "start-date",
    question: "When can you start?",
    drafts: [{ text: "I'm available from January.", approved: true }],
    versions: ["I'm available from January."],
  },
  { id: "role", question: "What kind of role are you looking for?", drafts: [{ text: "Not approved yet.", approved: false }], versions: [] },
];

export const HITS: Hit[] = [
  { id: "projects/rag#1", source: "projects/rag.md", title: "RAG", kind: "project", body: "Built a RAG system.", score: 0.03, meaning: 1, keyword: 2 },
  { id: "skills#3", source: "skills.yaml", title: "Skills", kind: "skills", body: "Postgres, TypeScript.", score: 0.02, meaning: 2, keyword: null },
];

export interface Rig {
  ctx: PipelineContext;
  /** Which stage was called, in order, with what. */
  calls: { stage: string; arg?: unknown }[];
  /** Set to change what the stand-in stages do. */
  verdict: (message: string) => Partial<StrikeVerdict>;
  flags: (message: string) => Partial<PrefilterFlags>;
  answerText: string;
  outputProblems: { kind: "commitment" | "negative_remark" | "unsupported_claim" | "off_policy"; detail: string }[];
  fail: Partial<Record<"strikeCheck" | "search" | "answer" | "checkOutput", Error>>;
  speakImpl: (text: string, cache?: boolean) => Promise<Spoken | null>;
  logs: string[];
}

export function rig(sql: Sql, options: { voicedAtOnce?: number } = {}): Rig {
  const calls: Rig["calls"] = [];
  const r: Rig = {
    calls,
    verdict: () => ({}),
    flags: () => ({}),
    answerText: "I built a retrieval system on Postgres. It answers questions about my work.",
    outputProblems: [],
    fail: {},
    speakImpl: async (text) => ({ text, audio: `AUDIO(${text})`, duration: 1.2, words: [{ text, start: 0, end: 1 }], visemes: [[0, "sil"]] }),
    logs: [],
    ctx: undefined as unknown as PipelineContext,
  };
  const deps: ChatDeps = {
    prefilter: (message) => {
      calls.push({ stage: "prefilter" });
      return { disguised: false, nonEnglish: false, links: [], gibberish: false, reasons: [], ...r.flags(message) };
    },
    strikeCheck: async (input) => {
      calls.push({ stage: "strikeCheck", arg: input });
      if (r.fail.strikeCheck) throw r.fail.strikeCheck;
      return { category: "career", intent: null, reason: "a career question", riskNote: "all fine so far", ...r.verdict(input.message), usage: haiku(0.0004, 500) };
    },
    search: async (question) => {
      calls.push({ stage: "search", arg: question });
      if (r.fail.search) throw r.fail.search;
      return HITS;
    },
    answer: async (input) => {
      calls.push({ stage: "answer", arg: input });
      if (r.fail.answer) throw r.fail.answer;
      return { text: r.answerText, usage: SONNET };
    },
    checkOutput: async (input) => {
      calls.push({ stage: "checkOutput", arg: input });
      if (r.fail.checkOutput) throw r.fail.checkOutput;
      return { ok: r.outputProblems.length === 0, problems: r.outputProblems, usage: haiku(0.0002, 300) };
    },
    speak: async (text, opts) => {
      calls.push({ stage: "speak", arg: { text, cache: opts?.cache } });
      return r.speakImpl(text, opts?.cache);
    },
    fixed: FIXED,
  };
  r.ctx = {
    sql,
    deps,
    gate: makeGate({
      sql,
      limits: { maxMessage: 1000, maxJobPost: 6000, perBrowser5min: 10, perBrowserDay: 60, perIp10min: 30, newVisitorsPerIpHour: 5, spendCapUsd: 18, perIpDayUsd: 2 },
      mail: async () => {},
      log: () => {},
    }),
    decide,
    cleanReply: (text) => text.replace(/\*\*/g, "").trim(),
    sentences: (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean),
    allowedLinks: ["https://github.com/merlin"],
    voice: makeSemaphore(options.voicedAtOnce ?? 3),
    log: (line) => r.logs.push(line),
  };
  return r;
}


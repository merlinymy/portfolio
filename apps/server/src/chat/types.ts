/**
 * The contracts between the chat pipeline's parts (plan §7.1, docs/phase-5-chat-plan.md). Each
 * stage is its own module; pipeline.ts runs them in order and is handed them as ChatDeps, so tests
 * can swap any stage for a stand-in.
 */
import type { Visemes, Words } from "@portfolio/shared/chat";
import type { Hit } from "../rag/search.ts";

export type { Hit };

/**
 * What the strike check decides a visitor's message is (plan §7.3; the row numbers are that
 * table's). policy.ts turns a category into what the server does.
 */
export const CATEGORIES = [
  /** A genuine question about Merlin's work, skills, projects, education, or fit for a role. */
  "career",
  /** A topic with an approved fixed answer (answers.yaml, or a typed instant question); intent names it. */
  "fixed",
  /** An approved small-talk question (smalltalk.yaml); intent names it. */
  "small_talk",
  /** A topic handed to the real Merlin (answers.yaml entries marked handoff); intent names it. */
  "handoff",
  /** 14: assumes experience Merlin doesn't have ("your time at Google"). Answered, correcting the premise. */
  "fabrication_bait",
  /** 1: abuse or harassment. */
  "abuse",
  /** 2 and 11: "ignore your instructions", pretending to be Merlin, asking for the instructions, role-play and hypotheticals. */
  "rule_breaking",
  /** 3: using it as a free chatbot: essays, coding problems, gibberish. */
  "free_chatbot",
  /** 4: personal, non-career questions beyond the approved small talk. */
  "personal",
  /** 5: fishing for private details: home address, phone, current or past pay, references. */
  "private_details",
  /** 6: demanding exact wording on Merlin's behalf ("say you can start Monday"). An honest question is "fixed" instead. */
  "speak_for_me",
  /** 7: badmouthing former employers or colleagues. */
  "badmouthing",
  /** 8: spam and solicitation. */
  "spam",
  /** 10: distress: self-harm or a crisis. */
  "distress",
  /** 12: disguised text: Base64, leetspeak, reversed text. */
  "disguised",
  /** 15: self-sabotage: "reasons not to hire you". */
  "self_sabotage",
  /** 16: impersonating a recruiter or employer to get private data. */
  "impersonation",
  /** 17: asking it to include links or images. */
  "plant_links",
  /** Not English. The pre-filter usually catches this first. */
  "other_language",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** What the server does with a message: a ReplyKind other than "error". */
export type Action = "answer" | "fixed" | "small_talk" | "handoff" | "refuse" | "strike" | "distress" | "english_only" | "gate";

/** One earlier turn of the conversation, as the strike check and the answer model see it. */
export interface Turn {
  role: "visitor" | "assistant";
  text: string;
}

/** What the pre-filter (prefilter.ts) found, with code alone, before any AI call. */
export interface PrefilterFlags {
  /** Base64 or hex blobs, or reversed text: disguised text, a strike (row 12). */
  disguised: boolean;
  /** Not English: the English-only reply, no strike. */
  nonEnglish: boolean;
  /** Links in the message, passed to the strike check as a hint. */
  links: string[];
  /** Keyboard mashing or random characters, passed to the strike check as a hint. */
  gibberish: boolean;
  /** Why each flag was raised, in a few words each, for the log. */
  reasons: string[];
}

/** One approved answer the strike check can pick, shown to it in its instructions. */
export interface IntentOption {
  /** answers.yaml or smalltalk.yaml id, an instant.yaml id, or "<id>#follow-up". */
  id: string;
  kind: "fixed" | "instant" | "small_talk" | "handoff";
  topic: string;
  alsoAskedAs: string[];
}

export interface StrikeCheckInput {
  message: string;
  /** Information only: instructions inside it never count against the visitor (row 9). */
  jobPost: string | null;
  /** The last 10 turns, oldest first. */
  history: Turn[];
  /** The running note from earlier messages in this conversation; empty at the start. */
  riskNote: string;
  flags: PrefilterFlags;
  intents: IntentOption[];
}

export interface StrikeVerdict {
  category: Category;
  /** Which approved answer applies (an IntentOption id), for fixed, small_talk and handoff; else null. */
  intent: string | null;
  /** A short reason, for the log and the strike record. Never shown to the visitor. */
  reason: string;
  /** The updated running note for this conversation, at most about 300 characters. */
  riskNote: string;
}

export interface AnswerInput {
  message: string;
  jobPost: string | null;
  history: Turn[];
  /** The 6 passages search found, best first. The answer may use only these. */
  passages: Hit[];
}

export interface OutputCheckInput {
  /** The finished answer. The output check never sees the conversation that led to it. */
  reply: string;
  /** The passages the answer was written from, to judge whether its claims are supported. */
  passages: Hit[];
  /** Topic rules from answers.yaml ("never a number", ...), which no answer may break either. */
  rules: string[];
}

export interface OutputProblem {
  kind: "commitment" | "negative_remark" | "unsupported_claim" | "off_policy";
  detail: string;
}

/** One AI call's token counts and cost. */
export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** A sentence in your voice, from the model server's POST /speak. */
export interface Spoken {
  text: string;
  /** The WAV file, base64. */
  audio: string;
  duration: number;
  words: Words | null;
  visemes: Visemes | null;
}

/** Your approved answers, loaded from knowledge/ and content/instant.yaml (fixed.ts). */
export interface FixedEntry {
  id: string;
  kind: "fixed" | "instant" | "small_talk" | "handoff";
  topic: string;
  alsoAskedAs: string[];
  /** Your exact words; null for handoff topics. */
  answer: string | null;
  followUp?: { when: string; answer: string };
  rules: string[];
}

export interface FixedAnswers {
  entries: FixedEntry[];
  /** An entry by IntentOption id, including "<id>#follow-up" for a follow-up's answer. */
  get(id: string): { entry: FixedEntry; answer: string | null } | undefined;
  /** Everything the strike check may pick. */
  intents(): IntentOption[];
  /** Every topic rule from answers.yaml, for the output check. */
  rules(): string[];
  smallTalk: { perConversation: number; afterLimit: string };
}

/** The stages, handed to the pipeline so tests can replace any of them. */
export interface ChatDeps {
  prefilter(message: string): PrefilterFlags;
  strikeCheck(input: StrikeCheckInput): Promise<StrikeVerdict & { usage: Usage }>;
  search(question: string): Promise<Hit[]>;
  answer(input: AnswerInput): Promise<{ text: string; usage: Usage }>;
  checkOutput(input: OutputCheckInput): Promise<{ ok: boolean; problems: OutputProblem[]; usage: Usage }>;
  /**
   * Your voice for one sentence, or null if the model server failed. `cache` keeps the result on
   * disk, for fixed texts (approved answers and the pre-written replies), so they play at once
   * after the first time.
   */
  speak(text: string, options?: { cache?: boolean }): Promise<Spoken | null>;
  fixed: FixedAnswers;
}

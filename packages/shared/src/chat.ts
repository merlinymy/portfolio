/**
 * What the chat backend (apps/server) sends the page, and what the page sends it (plan §7,
 * docs/phase-5-chat-plan.md). Types only: both sides import them with `import type`.
 */

/** POST /api/chat's body. */
export interface ChatRequest {
  /** What the visitor typed, up to 1,000 characters. */
  message: string;
  /** A pasted job posting, up to 6,000 characters, read as information only (plan §7.3, row 9). */
  jobPost?: string;
  /** Omit to start a new conversation; send back the one from the `meta` event to continue it. */
  conversationId?: string;
}

/**
 * POST /api/instant's body: a question button was clicked (plan §7.11). The answer is a stream of
 * events like POST /api/chat's, ending in `done` with kind "fixed" (or "gate" if the browser is locked).
 */
export interface InstantClick {
  /** The button's id, from GET /api/instant. */
  id: string;
  /** Omit and the click goes in the browser's latest conversation; send back the one from `meta` to name it. */
  conversationId?: string;
}

/** One question button, from GET /api/instant: what to show and what to send back on a click. */
export interface InstantButton {
  id: string;
  /** The question on the button, as the visitor reads it. */
  question: string;
}

/** POST /api/handoff's body: the visitor's details for the real Merlin (plan §7.5). */
export interface HandoffRequest {
  name: string;
  company?: string;
  email: string;
  roleLink?: string;
  message: string;
  conversationId?: string;
  /** Cloudflare Turnstile's token from the form. */
  turnstileToken: string;
}

/** Where a browser stands: GET /api/visitor, and the answer to POST /api/visitor. */
export interface VisitorStatus {
  strikes: number;
  strikesLeft: number;
  /** ISO time the lock ends, or null if the browser isn't locked. */
  lockedUntil: string | null;
}

/** The mouth shapes for a sentence: [seconds, shape] pairs; each shape holds until the next. */
export type Visemes = [number, string][];

/** A sentence's words with their start and end in seconds, for revealing the text in step. */
export type Words = { text: string; start: number; end: number }[];

/**
 * How a reply was made:
 * - answer: searched your profile, written by the answer model, checked
 * - fixed: one of your approved answers, word for word
 * - small_talk: approved small talk, or the line that ends it after two
 * - handoff: "that one's for the real me", with the handoff form offered
 * - refuse: a polite fixed refusal, no strike
 * - strike: a strike, with its fixed reply
 * - distress: the crisis-line reply, no strike
 * - english_only: the reply asking to continue in English
 * - gate: stopped before any AI call (too long, too many messages, locked, spending cap)
 * - error: something broke; a fixed apology
 */
export type ReplyKind =
  | "answer"
  | "fixed"
  | "small_talk"
  | "handoff"
  | "refuse"
  | "strike"
  | "distress"
  | "english_only"
  | "gate"
  | "error";

/** The server-sent events of one reply, in this order: meta, state, then sentences, then done. */
export type ChatEvent =
  /** First: which conversation and message this is. */
  | { type: "meta"; conversationId: string; messageId: string }
  /** The face's state: thinking while the reply is made, speaking once the first sentence is ready. */
  | { type: "state"; state: "thinking" | "speaking" }
  /**
   * One sentence of the reply, in order, with your voice (a WAV file in base64, mono, 24 kHz) and
   * its timing. audio is null if voicing failed; the text still shows. words and visemes are null
   * if the lip timing failed; the page then times the lips from the audio (plan §6.2).
   */
  | {
      type: "sentence";
      index: number;
      text: string;
      audio: string | null;
      duration: number;
      words: Words | null;
      visemes: Visemes | null;
    }
  /** The message earned a strike. Sent before the strike reply's sentences. */
  | ({ type: "strike" } & VisitorStatus)
  /** Show the handoff button: on handoffs, refusals that offer it, and every strike reply. */
  | { type: "handoff" }
  /** Last: the whole reply as text, and how it was made. */
  | { type: "done"; kind: ReplyKind; text: string };

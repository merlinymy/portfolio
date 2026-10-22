/**
 * The chat's pre-written replies (plan §7.1, §7.3): refusals, strikes, limits and errors. They're
 * fixed text, never written by an AI, so a clever message can't turn a refusal into something
 * else. Each is spoken in your voice, so they're written for speech.
 */

/** Offered in place of anything the chat won't answer itself, and for any reply the output check stops. */
export const HANDOFF = "That one's for the real me. Want me to pass your details along?";

export function strike(strikesLeft: number): string {
  if (strikesLeft <= 0) {
    return (
      "I can't help with that, and that was the third strike, so this chat is closed for this browser for thirty days. " +
      "The Contact panel still works if you'd like to reach the real me."
    );
  }
  const left = strikesLeft === 1 ? "one more and this chat closes for thirty days" : "you have two left before this chat closes for a while";
  return `I'm only here to talk about my work and career, so I can't help with that. That's a strike: ${left}.`;
}

export const REFUSE = {
  /** Row 5: private details. The real you can decide what to share. */
  private_details: HANDOFF,
  /** Row 7: badmouthing. A neutral line. */
  badmouthing: "I'd rather not talk about the people I've worked with that way. I'm happy to tell you what I worked on, though.",
  /** Row 15: self-sabotage. */
  self_sabotage: "I'll leave the case against hiring me to you. I'm happy to answer anything about my work, though.",
} as const;

/** Row 10: distress. No strike, and no AI. */
export const DISTRESS =
  "I'm sorry you're going through this. I'm just an AI version of Merlin, but you don't have to face it alone. " +
  "In the U.S., you can call or text 988, the Suicide and Crisis Lifeline, any time. " +
  "Outside the U.S., findahelpline.com lists free helplines near you.";

export const ENGLISH_ONLY = "Sorry, I can only chat in English. Could you ask that in English?";

/** Stopped before any AI call (plan §7.7). */
export const GATE = {
  locked: "This chat is closed for this browser for now. The Contact panel still works if you'd like to reach the real me.",
  tooLong: "That's a bit long for me. Could you keep it under a thousand characters? There's a separate box for a job posting.",
  jobPostTooLong:
    "That job posting is longer than I can read. Could you paste just the description and the requirements, under six thousand characters?",
  tooFast: "You're sending messages faster than I can keep up with. Give me a few minutes. The Contact panel works any time.",
  daily: "That's all the messages I can answer for this browser today. Come back tomorrow, or use the Contact panel to reach the real me.",
  spendCap: "I've talked so much this month that I'm resting until next month. The Contact panel still works if you'd like to reach the real me.",
} as const;

export const ERROR = "Sorry, something went wrong on my end. Could you try that again?";

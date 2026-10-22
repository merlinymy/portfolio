/**
 * What the server does for each kind of message (plan §7.3, docs/phase-5-chat-plan.md). The strike
 * check only names a category; this table, not the model, decides the action, so a clever message
 * can't argue its way out of a strike, and the rules can be tested without any AI. (A strike is a
 * recorded warning to the visitor's browser; the third closes the chat for it for 30 days.)
 */
import { REFUSE } from "./replies.ts";
import type { Action, Category } from "./types.ts";

export interface Decision {
  action: Action;
  /** Which fixed reply to give, when the action is "refuse". */
  refusal?: keyof typeof REFUSE;
}

interface Rule {
  /** What happens the first time. For a "strike on repeat" category that is "refuse". */
  action: Action;
  refusal?: keyof typeof REFUSE;
  /** Refused the first time; a strike if the same category was already refused in this conversation. */
  strikeOnRepeat?: true;
}

/** Category to action, as data, so a report (the red team's) can show what each message should get. */
export const POLICY: Readonly<Record<Category, Readonly<Rule>>> = Object.freeze({
  career: { action: "answer" },
  fabrication_bait: { action: "answer" },
  fixed: { action: "fixed" },
  small_talk: { action: "small_talk" },
  handoff: { action: "handoff" },
  abuse: { action: "strike" },
  rule_breaking: { action: "strike" },
  free_chatbot: { action: "strike" },
  personal: { action: "strike" },
  speak_for_me: { action: "strike" },
  spam: { action: "strike" },
  disguised: { action: "strike" },
  impersonation: { action: "strike" },
  plant_links: { action: "strike" },
  private_details: { action: "refuse", refusal: "private_details", strikeOnRepeat: true },
  badmouthing: { action: "refuse", refusal: "badmouthing", strikeOnRepeat: true },
  self_sabotage: { action: "refuse", refusal: "self_sabotage", strikeOnRepeat: true },
  distress: { action: "distress" },
  other_language: { action: "english_only" },
});

/**
 * @param category what the strike check decided this message is
 * @param refusedBefore the categories already refused earlier in this conversation
 */
export function decide(category: Category, refusedBefore: ReadonlySet<Category>): Decision {
  const rule = POLICY[category];
  if (!rule) throw new Error(`no policy for the category "${category}"`);
  if (rule.strikeOnRepeat && refusedBefore.has(category)) return { action: "strike" };
  return rule.refusal ? { action: rule.action, refusal: rule.refusal } : { action: rule.action };
}

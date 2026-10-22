/**
 * The category-to-action table (src/chat/policy.ts), including the "strike on repeat" rule.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, POLICY } from "../src/chat/policy.ts";
import { REFUSE } from "../src/chat/replies.ts";
import { CATEGORIES } from "../src/chat/types.ts";
import type { Category } from "../src/chat/types.ts";

const none: ReadonlySet<Category> = new Set();

test("the table has a row for every category, and only for categories", () => {
  assert.deepEqual(Object.keys(POLICY).sort(), [...CATEGORIES].sort());
});

test("every refusal a rule names is a real fixed reply", () => {
  for (const [category, rule] of Object.entries(POLICY)) {
    if (rule.refusal) assert.ok(rule.refusal in REFUSE, `${category} names a reply that doesn't exist`);
    if (rule.action === "refuse") assert.ok(rule.refusal, `${category} refuses without saying with what`);
    if (rule.strikeOnRepeat) assert.equal(rule.action, "refuse", `${category} can only repeat a refusal`);
  }
});

const expected: Record<Category, string> = {
  career: "answer",
  fabrication_bait: "answer",
  fixed: "fixed",
  small_talk: "small_talk",
  handoff: "handoff",
  abuse: "strike",
  rule_breaking: "strike",
  free_chatbot: "strike",
  personal: "strike",
  speak_for_me: "strike",
  spam: "strike",
  disguised: "strike",
  impersonation: "strike",
  plant_links: "strike",
  private_details: "refuse",
  badmouthing: "refuse",
  self_sabotage: "refuse",
  distress: "distress",
  other_language: "english_only",
};

for (const category of CATEGORIES) {
  test(`${category} gets "${expected[category]}" the first time`, () => {
    const decision = decide(category, none);
    assert.equal(decision.action, expected[category]);
    // A reply is named only when the action refuses.
    assert.equal("refusal" in decision, decision.action === "refuse");
  });
}

test("career questions and false-premise questions are answered", () => {
  assert.deepEqual(decide("career", none), { action: "answer" });
  assert.deepEqual(decide("fabrication_bait", none), { action: "answer" });
});

test("the approved-answer categories never strike, however often they repeat", () => {
  const everything = new Set<Category>(CATEGORIES);
  for (const category of ["fixed", "small_talk", "handoff", "career", "fabrication_bait", "distress", "other_language"] as const) {
    assert.equal(decide(category, everything).action, POLICY[category].action);
  }
});

test("private details, badmouthing and self-sabotage are refused with their own reply", () => {
  assert.deepEqual(decide("private_details", none), { action: "refuse", refusal: "private_details" });
  assert.deepEqual(decide("badmouthing", none), { action: "refuse", refusal: "badmouthing" });
  assert.deepEqual(decide("self_sabotage", none), { action: "refuse", refusal: "self_sabotage" });
});

test("asking again after a refusal is a strike", () => {
  for (const category of ["private_details", "badmouthing", "self_sabotage"] as const) {
    assert.deepEqual(decide(category, new Set([category])), { action: "strike" });
  }
});

test("a refusal in one category doesn't make another category a strike", () => {
  assert.deepEqual(decide("badmouthing", new Set<Category>(["private_details"])), { action: "refuse", refusal: "badmouthing" });
  assert.deepEqual(decide("self_sabotage", new Set<Category>(["private_details", "badmouthing"])), {
    action: "refuse",
    refusal: "self_sabotage",
  });
});

test("categories that strike at once strike whether or not they were refused before", () => {
  for (const category of ["abuse", "rule_breaking", "free_chatbot", "personal", "speak_for_me", "spam", "disguised", "impersonation", "plant_links"] as const) {
    assert.deepEqual(decide(category, none), { action: "strike" });
    assert.deepEqual(decide(category, new Set([category])), { action: "strike" });
  }
});

test("a decision can be changed without changing the table", () => {
  const decision = decide("private_details", none);
  decision.action = "answer";
  assert.equal(decide("private_details", none).action, "refuse");
  assert.equal(POLICY.private_details.action, "refuse");
});

test("the table itself can't be edited", () => {
  assert.throws(() => {
    (POLICY as Record<string, unknown>).abuse = { action: "answer" };
  }, TypeError);
});

test("a category the table doesn't know is an error, not a silent answer", () => {
  assert.throws(() => decide("nonsense" as Category, none), /no policy for the category "nonsense"/);
});

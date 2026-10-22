/**
 * Loading the approved answers (src/chat/fixed.ts). The committed knowledge.example/ (made-up
 * values) and content/instant.yaml (public) stand in for the private knowledge/ folder, which no
 * test reads.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { loadFixed } from "../src/chat/fixed.ts";
import { ROOT } from "../src/env.ts";

const EXAMPLE = `${ROOT}knowledge.example`;
const CONTENT = `${ROOT}content`;

const SMALLTALK = "perConversation: 2\nafterLimit: Later, in person.\nfacts: []\n";
const INSTANT = "- id: about-you\n  question: Tell me about yourself.\n  alsoAskedAs: [who are you]\n  answer: I'm Merlin.\n";

/** A knowledge/ and content/ folder holding exactly these files, for testing what loading rejects. */
async function folders(files: { answers?: string; smalltalk?: string; instant?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "chat-fixed-"));
  await mkdir(join(dir, "knowledge"));
  await mkdir(join(dir, "content"));
  if (files.answers !== undefined) await writeFile(join(dir, "knowledge", "answers.yaml"), files.answers);
  await writeFile(join(dir, "knowledge", "smalltalk.yaml"), files.smalltalk ?? SMALLTALK);
  await writeFile(join(dir, "content", "instant.yaml"), files.instant ?? INSTANT);
  return {
    knowledge: join(dir, "knowledge"),
    content: join(dir, "content"),
    load: () => loadFixed(join(dir, "knowledge"), join(dir, "content")),
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

async function rejects(files: Parameters<typeof folders>[0], message: RegExp) {
  const f = await folders(files);
  try {
    await assert.rejects(f.load(), message);
  } finally {
    await f.done();
  }
}

// ── The example and the public instant answers ──────────────────────────────────────────────────

test("the example folders load: answers, small talk and the six instant questions", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  assert.deepEqual(
    fixed.entries.map((e) => [e.id, e.kind]),
    [
      ["availability-location", "fixed"],
      ["salary-expectations", "fixed"],
      ["how-you-build", "fixed"],
      ["greatest-weakness", "handoff"],
      ["where-based", "small_talk"],
      ["for-fun", "small_talk"],
      ["about-you", "instant"],
      ["role", "instant"],
      ["proudest-project", "instant"],
      ["tech-stack", "instant"],
      ["working-on", "instant"],
      ["different", "instant"],
    ],
  );
});

test("an answer is returned exactly as written", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  assert.equal(
    fixed.get("availability-location")?.answer,
    "I'm available for full-time roles from June 2030. I live in Springfield, and I'm happy to work on-site or remotely.",
  );
  assert.equal(fixed.get("for-fun")?.answer, "I bake bread, badly but often.");
  assert.equal(fixed.get("greatest-weakness")?.answer, null);
});

test("the public instant answers come out word for word as in content/instant.yaml", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  const written = parse(await readFile(`${CONTENT}/instant.yaml`, "utf8")) as { id: string; question: string; alsoAskedAs: string[]; answer: string }[];
  assert.equal(written.length, 6);
  for (const q of written) {
    const found = fixed.get(q.id);
    assert.ok(found, q.id);
    assert.equal(found.answer, q.answer.replace(/\n$/, ""));
    assert.equal(found.entry.kind, "instant");
    assert.equal(found.entry.topic, q.question);
    assert.deepEqual(found.entry.alsoAskedAs, q.alsoAskedAs);
    assert.ok(found.answer && found.answer.length > 100 && !found.answer.endsWith("\n"));
  }
});

test("each kind of entry has the topic the strike check is shown", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  assert.equal(fixed.get("salary-expectations")?.entry.topic, "Salary expectations");
  assert.deepEqual(fixed.get("how-you-build")?.entry.alsoAskedAs, ["how do you work", "what's your process"]);
  assert.deepEqual(fixed.get("availability-location")?.entry.alsoAskedAs, []);
  // Small talk is named by the question itself.
  assert.equal(fixed.get("where-based")?.entry.topic, "Where are you based?");
  assert.equal(fixed.get("where-based")?.entry.kind, "small_talk");
  assert.equal(fixed.get("about-you")?.entry.topic, "Tell me about yourself.");
});

test("intents: one per entry, each follow-up right after its topic, in a stable order", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  const intents = fixed.intents();
  assert.deepEqual(
    intents.map((i) => i.id),
    [
      "availability-location",
      "salary-expectations",
      "how-you-build",
      "how-you-build#follow-up",
      "greatest-weakness",
      "where-based",
      "for-fun",
      "about-you",
      "role",
      "proudest-project",
      "tech-stack",
      "working-on",
      "different",
    ],
  );
  assert.deepEqual(intents.find((i) => i.id === "how-you-build#follow-up"), {
    id: "how-you-build#follow-up",
    kind: "fixed",
    topic: "Asked how they test it",
    alsoAskedAs: [],
  });
  assert.deepEqual(intents.find((i) => i.id === "greatest-weakness"), { id: "greatest-weakness", kind: "handoff", topic: "Greatest weakness", alsoAskedAs: [] });
  assert.deepEqual(fixed.intents(), intents, "the same order every time");
  assert.deepEqual((await loadFixed(EXAMPLE, CONTENT)).intents(), intents, "and after a reload");
});

test("get: a topic, its follow-up, and ids that don't exist", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  const topic = fixed.get("how-you-build");
  assert.equal(topic?.answer, "I start by asking the people who'll use it what they actually need, then build the smallest thing that tests it.");
  const followUp = fixed.get("how-you-build#follow-up");
  assert.equal(followUp?.answer, "With the people themselves, as early as I can.");
  assert.equal(followUp?.entry.id, "how-you-build#follow-up");
  assert.equal(followUp?.entry.kind, "fixed");
  assert.equal(fixed.get("nope"), undefined);
  assert.equal(fixed.get("salary-expectations#follow-up"), undefined, "this topic has no follow-up");
  assert.equal(fixed.get("greatest-weakness")?.entry.kind, "handoff");
});

test("every intent the strike check can pick can be looked up", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  for (const intent of fixed.intents()) {
    const found = fixed.get(intent.id);
    assert.ok(found, intent.id);
    assert.equal(found.entry.id, intent.id);
    assert.equal(found.entry.kind, intent.kind);
    assert.equal(found.entry.topic, intent.topic);
    // Everything but a handoff has words to say.
    assert.equal(found.answer === null, intent.kind === "handoff", intent.id);
  }
});

test("rules from every entry, once each", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  assert.deepEqual(fixed.rules(), ["Never a number, never past or current pay."]);
});

test("small talk's limit and the line after it", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  assert.deepEqual(fixed.smallTalk, {
    perConversation: 2,
    afterLimit: "I'd love to chat more about that in person. Want me to pass your details to the real me?",
  });
});

test("what's handed out can be changed without changing what's loaded", async () => {
  const fixed = await loadFixed(EXAMPLE, CONTENT);
  fixed.intents()[0].topic = "changed";
  fixed.intents()[2].alsoAskedAs.push("changed");
  fixed.rules().push("changed");
  assert.equal(fixed.intents()[0].topic, "Availability and location");
  assert.deepEqual(fixed.intents()[2].alsoAskedAs, ["how do you work", "what's your process"]);
  assert.deepEqual(fixed.rules(), ["Never a number, never past or current pay."]);
});

// ── Exact words and rules ───────────────────────────────────────────────────────────────────────

test("folded and literal blocks lose only the newline YAML adds at the end", async () => {
  const f = await folders({
    answers:
      "- id: folded\n  topic: Folded\n  answer: >\n    Two lines\n    folded together.\n" +
      "- id: literal\n  topic: Literal\n  answer: |\n    Line one\n      indented line two\n    Line three  \n" +
      "- id: quoted\n  topic: Quoted\n  answer: '  spaces stay.  '\n",
  });
  try {
    const fixed = await f.load();
    assert.equal(fixed.get("folded")?.answer, "Two lines folded together.");
    assert.equal(fixed.get("literal")?.answer, "Line one\n  indented line two\nLine three  ");
    assert.equal(fixed.get("quoted")?.answer, "  spaces stay.  ");
  } finally {
    await f.done();
  }
});

test("a follow-up's answer is exact too, and it keeps its topic's rules", async () => {
  const f = await folders({
    answers: "- id: t\n  topic: T\n  answer: A.\n  rules: [Never X.]\n  followUp:\n    when: When asked more\n    answer: |\n      More.\n",
  });
  try {
    const fixed = await f.load();
    assert.equal(fixed.get("t#follow-up")?.answer, "More.");
    assert.deepEqual(fixed.get("t#follow-up")?.entry.rules, ["Never X."]);
    assert.deepEqual(fixed.entries[0].followUp, { when: "When asked more", answer: "More." });
    // Only a topic with a follow-up has the field.
    assert.ok(!("followUp" in (await loadFixed(EXAMPLE, CONTENT)).entries[0]));
  } finally {
    await f.done();
  }
});

test("a rule two topics share is listed once, in the order first seen", async () => {
  const f = await folders({
    answers:
      "- id: a\n  topic: A\n  answer: A.\n  rules: [Rule one., Rule two.]\n" +
      "- id: b\n  topic: B\n  answer: B.\n  rules: [Rule two., Rule three.]\n" +
      "- id: c\n  topic: C\n  answer: C.\n",
  });
  try {
    assert.deepEqual((await f.load()).rules(), ["Rule one.", "Rule two.", "Rule three."]);
  } finally {
    await f.done();
  }
});

test("a handoff topic has no answer, even if one was written", async () => {
  const f = await folders({ answers: "- id: h\n  topic: H\n  handoff: true\n- id: h2\n  topic: H2\n  handoff: true\n  answer: ignored\n" });
  try {
    const fixed = await f.load();
    assert.equal(fixed.get("h")?.answer, null);
    assert.equal(fixed.get("h2")?.answer, null);
    assert.equal(fixed.get("h2")?.entry.answer, null);
  } finally {
    await f.done();
  }
});

test("an empty answers file is fine; the chat then has only small talk and the instant answers", async () => {
  const f = await folders({ answers: "[]\n" });
  try {
    assert.deepEqual((await f.load()).entries.map((e) => e.id), ["about-you"]);
  } finally {
    await f.done();
  }
});

test("small talk can allow none per conversation", async () => {
  const f = await folders({ answers: "[]", smalltalk: "perConversation: 0\nafterLimit: Not now.\nfacts:\n  - { id: x, question: Q?, answer: A. }\n" });
  try {
    const fixed = await f.load();
    assert.equal(fixed.smallTalk.perConversation, 0);
    assert.equal(fixed.get("x")?.entry.kind, "small_talk");
  } finally {
    await f.done();
  }
});

// ── What loading rejects, and what it says ──────────────────────────────────────────────────────

test("an entry with no answer names its file and the entry", async () => {
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n- id: no-answer\n  topic: Oops\n" }, /answers\.yaml: entry "no-answer" needs an answer \(or handoff: true/);
  await rejects({ answers: "- id: blank\n  topic: B\n  answer: '   '\n" }, /entry "blank" needs an answer/);
});

test("an entry with no id or no topic says which one it is", async () => {
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n- topic: Nameless\n  answer: A.\n" }, /answers\.yaml: entry number 2 \(it has no id\) needs an id/);
  await rejects({ answers: "- id: no-topic\n  answer: A.\n" }, /entry "no-topic" needs a topic/);
});

test("the same id twice is an error, naming both files", async () => {
  await rejects({ answers: "- id: about-you\n  topic: R\n  answer: A.\n" }, /instant\.yaml: entry "about-you" has an id that's already used in .*answers\.yaml/);
  await rejects(
    { answers: "- id: x\n  topic: X\n  answer: A.\n", smalltalk: "perConversation: 1\nafterLimit: L.\nfacts:\n  - { id: x, question: Q?, answer: A. }\n" },
    /smalltalk\.yaml: entry "x" has an id that's already used in .*answers\.yaml/,
  );
  await rejects({ answers: "- id: x\n  topic: X\n  answer: A.\n- id: x\n  topic: Y\n  answer: B.\n" }, /answers\.yaml: entry "x" has an id that's already used earlier in this file/);
});

test("an id with a # is an error, since that's how a follow-up is named", async () => {
  await rejects({ answers: "- id: a#follow-up\n  topic: A\n  answer: A.\n" }, /entry "a#follow-up" can't have a # in its id/);
});

test("a follow-up needs both parts", async () => {
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n  followUp:\n    when: Only this\n" }, /entry "a" needs followUp to have both a when and an answer/);
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n  followUp: just text\n" }, /entry "a" needs followUp to have both/);
});

test("lists and flags of the wrong shape are caught", async () => {
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n  alsoAskedAs: just a sentence\n" }, /entry "a" needs alsoAskedAs to be a list of texts/);
  await rejects({ answers: "- id: a\n  topic: A\n  answer: A.\n  rules: [1, 2]\n" }, /entry "a" needs rules to be a list of texts/);
  await rejects({ answers: "- id: a\n  topic: A\n  handoff: yes please\n" }, /entry "a" needs handoff to be true or false/);
});

test("a file that isn't a list of entries is an error", async () => {
  await rejects({ answers: "id: a\ntopic: A\n" }, /answers\.yaml should be a list of entries/);
  await rejects({ answers: "- just text\n" }, /answers\.yaml: item 1 isn't an entry/);
});

test("small talk's limit and closing line are required", async () => {
  await rejects({ answers: "[]", smalltalk: "perConversation: two\nafterLimit: L.\nfacts: []\n" }, /smalltalk\.yaml: perConversation should be a whole number/);
  await rejects({ answers: "[]", smalltalk: "perConversation: -1\nafterLimit: L.\nfacts: []\n" }, /perConversation should be a whole number/);
  await rejects({ answers: "[]", smalltalk: "perConversation: 2\nfacts: []\n" }, /smalltalk\.yaml: afterLimit needs/);
  await rejects({ answers: "[]", smalltalk: "- not a map\n" }, /smalltalk\.yaml should have perConversation/);
  await rejects({ answers: "[]", smalltalk: "perConversation: 2\nafterLimit: L.\nfacts:\n  - { id: x, question: Q? }\n" }, /smalltalk\.yaml: entry "x" needs an answer/);
});

test("an instant answer needs its question and answer", async () => {
  await rejects({ answers: "[]", instant: "- id: q\n  answer: A.\n" }, /instant\.yaml: entry "q" needs a question/);
  await rejects({ answers: "[]", instant: "- id: q\n  question: Q?\n" }, /instant\.yaml: entry "q" needs an answer/);
});

test("a missing file says what to do", async () => {
  const f = await folders({});
  try {
    await assert.rejects(f.load(), /answers\.yaml doesn't exist \(copy knowledge\.example\/ to knowledge\/ and fill it in\)/);
  } finally {
    await f.done();
  }
  await assert.rejects(loadFixed(EXAMPLE, `${ROOT}no-such-content-folder`), /instant\.yaml doesn't exist/);
});

test("a file that isn't YAML names the file", async () => {
  await rejects({ answers: "- id: a\n  topic: [unclosed\n" }, /answers\.yaml isn't valid YAML/);
});

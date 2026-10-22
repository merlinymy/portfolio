/**
 * Your approved answers (plan §7.4, docs/phase-5-chat-plan.md): the topics where the chat says your
 * exact words instead of writing something new. Read from three files, each shaped as in
 * knowledge.example/:
 *
 * - knowledge/answers.yaml: topics with an answer, or marked `handoff: true` for the real you.
 * - knowledge/smalltalk.yaml: the small-talk facts, and how many the chat gives per conversation.
 * - content/instant.yaml: the six instant questions (public), which typed versions also match.
 *
 * The strike check only picks an entry by id; what's said is always the text read here, word for
 * word, so no clever message can change it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { FixedAnswers, FixedEntry, IntentOption } from "./types.ts";

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

async function readYaml(path: string, ifMissing: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${path} doesn't exist (${ifMissing})`);
    throw error;
  }
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${path} isn't valid YAML: ${(error as Error).message}`);
  }
}

/** Your words exactly, minus the newline YAML adds at the end of a folded or literal block. */
const exact = (text: string) => text.replace(/\n+$/, "");

/** Reads one file's entries, and says which file and which entry whenever one is wrong. */
function reader(file: string, entries: unknown, shape: string) {
  if (!Array.isArray(entries)) throw new Error(`${file} should be a list of entries (${shape})`);
  return entries.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`${file}: item ${index + 1} isn't an entry (${shape})`);
    const label = typeof raw.id === "string" && raw.id ? `"${raw.id}"` : `number ${index + 1} (it has no id)`;
    const fail = (problem: string): never => {
      throw new Error(`${file}: entry ${label} ${problem}`);
    };
    return {
      raw,
      /** A required, non-empty text field. */
      text(field: string, hint = ""): string {
        const value = raw[field];
        if (typeof value !== "string" || !value.trim()) fail(`needs ${/^[aeiou]/.test(field) ? "an" : "a"} ${field}${hint}`);
        return value as string;
      },
      /** An optional list of texts. */
      list(field: string): string[] {
        const value = raw[field];
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) fail(`needs ${field} to be a list of texts`);
        return value as string[];
      },
      fail,
    };
  });
}

export async function loadFixed(knowledgeDir: string, contentDir: string): Promise<FixedAnswers> {
  const answersFile = join(knowledgeDir, "answers.yaml");
  const smalltalkFile = join(knowledgeDir, "smalltalk.yaml");
  const instantFile = join(contentDir, "instant.yaml");
  const create = "copy knowledge.example/ to knowledge/ and fill it in";

  const entries: FixedEntry[] = [];

  // answers.yaml: an answer in your words, or a topic left to the real you.
  const answerShape = "id, topic, answer or handoff: true";
  for (const item of reader(answersFile, await readYaml(answersFile, create), answerShape)) {
    const { raw } = item;
    const id = item.text("id");
    const topic = item.text("topic");
    if (raw.handoff !== undefined && typeof raw.handoff !== "boolean") item.fail("needs handoff to be true or false");
    const entry: FixedEntry = {
      id,
      kind: raw.handoff === true ? "handoff" : "fixed",
      topic,
      alsoAskedAs: item.list("alsoAskedAs"),
      answer: raw.handoff === true ? null : exact(item.text("answer", " (or handoff: true, to leave it to the real you)")),
      rules: item.list("rules"),
    };
    if (raw.followUp !== undefined && raw.followUp !== null) {
      if (!isObject(raw.followUp) || typeof raw.followUp.when !== "string" || typeof raw.followUp.answer !== "string" || !raw.followUp.when.trim() || !raw.followUp.answer.trim()) {
        item.fail("needs followUp to have both a when and an answer");
      }
      const followUp = raw.followUp as { when: string; answer: string };
      entry.followUp = { when: followUp.when, answer: exact(followUp.answer) };
    }
    entries.push(entry);
  }

  // smalltalk.yaml: a few fixed facts, and a limit on how many the chat gives.
  const smalltalk = await readYaml(smalltalkFile, create);
  if (!isObject(smalltalk)) throw new Error(`${smalltalkFile} should have perConversation, afterLimit and facts`);
  if (!Number.isInteger(smalltalk.perConversation) || (smalltalk.perConversation as number) < 0) {
    throw new Error(`${smalltalkFile}: perConversation should be a whole number, 0 or more`);
  }
  if (typeof smalltalk.afterLimit !== "string" || !smalltalk.afterLimit.trim()) throw new Error(`${smalltalkFile}: afterLimit needs the line to say after the limit`);
  for (const item of reader(smalltalkFile, smalltalk.facts ?? [], "id, question, answer")) {
    entries.push({
      id: item.text("id"),
      kind: "small_talk",
      topic: item.text("question"),
      alsoAskedAs: [],
      answer: exact(item.text("answer")),
      rules: [],
    });
  }

  // content/instant.yaml: the instant questions, which a typed version of the question also matches.
  for (const item of reader(instantFile, await readYaml(instantFile, "it's part of the repo's content/ folder"), "id, question, alsoAskedAs, answer")) {
    entries.push({
      id: item.text("id"),
      kind: "instant",
      topic: item.text("question"),
      alsoAskedAs: item.list("alsoAskedAs"),
      answer: exact(item.text("answer")),
      rules: [],
    });
  }

  // Ids are how the strike check names an answer, so each must name exactly one.
  const files = new Map<string, string>();
  const fileOf = (entry: FixedEntry) => (entry.kind === "small_talk" ? smalltalkFile : entry.kind === "instant" ? instantFile : answersFile);
  for (const entry of entries) {
    const file = fileOf(entry);
    if (entry.id.includes("#")) throw new Error(`${file}: entry "${entry.id}" can't have a # in its id (that's how a follow-up is named)`);
    const seen = files.get(entry.id);
    if (seen) {
      throw new Error(`${file}: entry "${entry.id}" has an id that's already used${seen === file ? " earlier in this file" : ` in ${seen}`}; ids must be unique across all three files`);
    }
    files.set(entry.id, file);
  }

  // What the strike check may pick, and what each pick says. A follow-up is its own pick, right after its topic.
  const options: IntentOption[] = [];
  const byId = new Map<string, { entry: FixedEntry; answer: string | null }>();
  for (const entry of entries) {
    options.push({ id: entry.id, kind: entry.kind, topic: entry.topic, alsoAskedAs: entry.alsoAskedAs });
    byId.set(entry.id, { entry, answer: entry.answer });
    if (entry.followUp) {
      const followUp: FixedEntry = {
        id: `${entry.id}#follow-up`,
        kind: "fixed",
        topic: entry.followUp.when,
        alsoAskedAs: [],
        answer: entry.followUp.answer,
        rules: entry.rules,
      };
      options.push({ id: followUp.id, kind: followUp.kind, topic: followUp.topic, alsoAskedAs: [] });
      byId.set(followUp.id, { entry: followUp, answer: followUp.answer });
    }
  }
  const rules = [...new Set(entries.flatMap((entry) => entry.rules))];

  return {
    entries,
    get: (id) => byId.get(id),
    intents: () => options.map((option) => ({ ...option, alsoAskedAs: [...option.alsoAskedAs] })),
    rules: () => [...rules],
    smallTalk: { perConversation: smalltalk.perConversation as number, afterLimit: exact(smalltalk.afterLimit) },
  };
}

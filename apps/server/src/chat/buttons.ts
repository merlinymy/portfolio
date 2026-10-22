/**
 * The chat's question buttons (plan §7.11, changed 2026-10-21), from the private
 * knowledge/buttons.yaml. A click plays a version voiced ahead of time on the Mac: no AI call and
 * no search. Open-ended questions have several approved wordings, played in turn; factual ones
 * point at one of your fixed answers in answers.yaml, said word for word.
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { FixedAnswers } from "./types.ts";

export interface ButtonVersion {
  text: string;
  approved: boolean;
}

export interface Button {
  id: string;
  question: string;
  /** Every wording, approved or not, in the file's order (the review page shows them all). */
  drafts: ButtonVersion[];
  /** Only the approved wordings: what a click may play. */
  versions: string[];
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

export async function loadButtons(knowledgeDir: string, fixed: FixedAnswers): Promise<Button[]> {
  const file = `${knowledgeDir}/buttons.yaml`;
  const raw = parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${file}: expected a list of buttons`);
  const seen = new Set<string>();
  return raw.map((entry: any, i: number) => {
    const where = `${file}, button ${i + 1}${entry?.id ? ` (${entry.id})` : ""}`;
    if (typeof entry?.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) throw new Error(`${where}: needs an id of lowercase letters, digits and dashes`);
    if (seen.has(entry.id)) throw new Error(`${where}: the id is used twice`);
    seen.add(entry.id);
    if (typeof entry.question !== "string" || !entry.question.trim()) throw new Error(`${where}: needs a question`);
    let drafts: ButtonVersion[];
    if (entry.answer !== undefined) {
      if (entry.versions !== undefined) throw new Error(`${where}: has both versions and answer; use one`);
      // A fixed answer is already approved: it's said word for word whenever the topic comes up.
      const found = fixed.get(String(entry.answer));
      if (!found?.answer || found.entry.kind !== "fixed") throw new Error(`${where}: answer "${entry.answer}" isn't a fixed answer in answers.yaml`);
      drafts = [{ text: clean(found.answer), approved: true }];
    } else {
      if (!Array.isArray(entry.versions) || !entry.versions.length) throw new Error(`${where}: needs versions or an answer`);
      drafts = entry.versions.map((v: any, n: number) => {
        if (typeof v?.text !== "string" || !v.text.trim()) throw new Error(`${where}, version ${n + 1}: needs text`);
        return { text: clean(v.text), approved: v.approved === true };
      });
    }
    const versions = drafts.filter((d) => d.approved).map((d) => d.text);
    return { id: entry.id, question: clean(entry.question), drafts, versions };
  });
}

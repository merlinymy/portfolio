/**
 * The instructions the chat gives Claude (docs/phase-5-chat-plan.md, "Claude calls"). They're
 * private, in knowledge/prompts/: publishing them would show attackers exactly what to get around.
 * knowledge.example/prompts/README.md says what each file is for.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Prompts {
  strikeCheck: string;
  answer: string;
  outputCheck: string;
  handoffSummary: string;
}

const FILES = {
  strikeCheck: "strike-check.md",
  answer: "answer.md",
  outputCheck: "output-check.md",
  handoffSummary: "handoff-summary.md",
} as const satisfies Record<keyof Prompts, string>;

/**
 * Reads the four instruction files from `knowledgeDir`/prompts. Each file's text is trimmed, so a
 * stray newline at the end can't change what gets cached. A missing or empty file is an error
 * that names every such file, because a call can't be made without its instructions.
 */
export async function loadPrompts(knowledgeDir: string): Promise<Prompts> {
  const dir = join(knowledgeDir, "prompts");
  const problems: string[] = [];
  const loaded: Partial<Prompts> = {};
  for (const [key, file] of Object.entries(FILES) as [keyof Prompts, string][]) {
    const path = join(dir, file);
    try {
      const text = (await readFile(path, "utf8")).trim();
      if (text) loaded[key] = text;
      else problems.push(`${path} is empty`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      problems.push(code === "ENOENT" ? `${path} is missing` : `${path} can't be read (${(error as Error).message})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The chat's instructions aren't all in place: ${problems.join("; ")}. ` +
        `These files are private (publishing them would show attackers what to get around), so they ` +
        `aren't in the repository: write them in ${dir}. ` +
        `knowledge.example/prompts/README.md says what each one is for.`,
    );
  }
  return loaded as Prompts;
}

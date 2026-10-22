/**
 * Cuts the profile into passages for the chat's search (docs/phase-4-knowledge-plan.md): short
 * pieces that each answer one thing. Reads the same content/ files the site's panels are built
 * from (plan §4.5), plus any private notes in knowledge/extra/.
 *
 * Every passage carries what it's about in its own text, so "Diagnosed a memory leak…" is stored
 * as "ARC (PaperPrism), project, 2025 – Present: Diagnosed a memory leak…". Search sees one
 * passage at a time, and so does the answer model.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export interface Passage {
  /** The file and the piece of it, e.g. projects/arc.md#bullet-3. */
  id: string;
  /** The file, relative to content/, or extra/<file> for a private note. */
  source: string;
  /** What it's about, e.g. ARC (PaperPrism). */
  title: string;
  kind: "facts" | "summary" | "tech" | "paragraph" | "bullet" | "skills" | "instant" | "note";
  /** The text the answer model is shown, and what's embedded. */
  body: string;
}

interface Link {
  label: string;
  url: string;
}

/** A Markdown file's YAML header and the text after it. */
export function splitFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  return { data: parse(match[1]) ?? {}, body: text.slice(match[0].length) };
}

/** The "- " bullets and the plain paragraphs of a Markdown body, in order. */
export function blocks(body: string): { bullet: boolean; text: string }[] {
  const out: { bullet: boolean; text: string }[] = [];
  for (const chunk of body.split(/\n\s*\n/)) {
    const lines = chunk.split("\n");
    if (lines.some((l) => /^\s*- /.test(l))) {
      // Each bullet, with any lines that continue it.
      for (const item of chunk.split(/\n(?=\s*- )/)) {
        const text = item.replace(/^\s*- /, "").replace(/\s*\n\s*/g, " ").trim();
        if (text) out.push({ bullet: true, text });
      }
    } else {
      const text = chunk.replace(/\s*\n\s*/g, " ").trim();
      if (text && !text.startsWith("#")) out.push({ bullet: false, text });
    }
  }
  return out;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const links = (list: Link[] = []) => (list.length ? ` Links: ${list.map((l) => `${l.label} ${l.url}`).join(", ")}.` : "");

function about(text: string): Passage[] {
  const { data: a, body } = splitFrontmatter(text);
  const title = `About ${a.name}`;
  const education = (a.education as { degree: string; school: string; date: string; note?: string }[])
    .map((e) => `${e.degree}, ${e.school}, ${e.date}${e.note ? ` (${e.note})` : ""}`)
    .join("; ");
  const passages: Passage[] = [
    {
      id: "about.md#facts",
      source: "about.md",
      title,
      kind: "facts",
      body:
        `${a.name}, ${a.headline}. Location: ${a.location}. ${sentence(a.workAuthorization)} ` +
        `Contact: email ${a.contact.email}, LinkedIn ${a.contact.linkedin}, GitHub ${a.contact.github}. ` +
        `Résumé: merlinyang.com${a.resumePdf}.`,
    },
    {
      id: "about.md#education",
      source: "about.md",
      title,
      kind: "facts",
      body: `${a.name}'s education: ${education}.${(a.credentials ?? []).map((c: string) => ` ${sentence(c)}`).join("")}`,
    },
    { id: "about.md#summary", source: "about.md", title, kind: "summary", body: `${a.name}, ${a.headline}: ${a.summary}` },
  ];
  blocks(body).forEach((b, i) =>
    passages.push({ id: `about.md#story-${i + 1}`, source: "about.md", title, kind: "paragraph", body: `${a.name}'s background: ${b.text}` }),
  );
  return passages;
}

function experience(source: string, text: string): Passage[] {
  const { data: e, body } = splitFrontmatter(text);
  const where = `${e.role} at ${e.company}`;
  // A summary only when there's something to say beyond the role and dates, which every bullet
  // already carries. A passage of just a title sits close to every question and crowds out real
  // answers.
  const passages: Passage[] = e.about
    ? [{ id: `${source}#summary`, source, title: e.company, kind: "summary", body: `${where}${e.location ? ` (${e.location})` : ""}, ${e.dates}: ${sentence(e.about)}` }]
    : [];
  blocks(body).forEach((b, i) =>
    passages.push({ id: `${source}#bullet-${i + 1}`, source, title: e.company, kind: b.bullet ? "bullet" : "paragraph", body: `${where}, ${e.dates}: ${b.text}` }),
  );
  return passages;
}

function project(source: string, text: string): Passage[] {
  const { data: p, body } = splitFrontmatter(text);
  // What it is, and what it's built with, apart: a list of tools in the summary pulls it away
  // from "What is ARC?", and a passage of just the tools answers "What did you build ARC with?".
  const passages: Passage[] = [
    { id: `${source}#summary`, source, title: p.name, kind: "summary", body: `${p.name} is a project of Merlin Yang's (${p.dates}): ${sentence(p.blurb)}` },
    { id: `${source}#tech`, source, title: p.name, kind: "tech", body: `${p.name} is built with ${p.tech.join(", ")}.${links(p.links)}` },
  ];
  blocks(body).forEach((b, i) =>
    passages.push({ id: `${source}#bullet-${i + 1}`, source, title: p.name, kind: b.bullet ? "bullet" : "paragraph", body: `${p.name}, project, ${p.dates}: ${b.text}` }),
  );
  return passages;
}

function skills(text: string): Passage[] {
  return (parse(text) as { id: string; group: string; items: string[] }[]).map((s) => ({
    id: `skills.yaml#${s.id}`,
    source: "skills.yaml",
    title: `Skills: ${s.group}`,
    kind: "skills",
    body: `Merlin Yang's skills, ${s.group}: ${s.items.join(", ")}.`,
  }));
}

function earlierProjects(text: string): Passage[] {
  return (parse(text) as { id: string; name: string; desc: string; tech: string[]; links: Link[] }[]).map((p) => ({
    id: `earlier-projects.yaml#${p.id}`,
    source: "earlier-projects.yaml",
    title: p.name,
    kind: "summary",
    body: `${p.name}, an earlier frontend project: ${sentence(p.desc)} Built with ${p.tech.join(", ")}.${links(p.links)}`,
  }));
}

function instant(text: string): Passage[] {
  return (parse(text) as { id: string; question: string; answer: string }[]).map((q) => ({
    id: `instant.yaml#${q.id}`,
    source: "instant.yaml",
    title: q.question,
    kind: "instant",
    body: `Asked "${q.question}", Merlin answers: ${q.answer.trim()}`,
  }));
}

/** A private note, cut at each heading. Its first "# " heading, if any, is its title. */
export function note(source: string, text: string): Passage[] {
  const { data, body } = splitFrontmatter(text);
  const doc = data.title ?? /^# (.+)$/m.exec(body)?.[1] ?? source.replace(/^extra\/|\.md$/g, "");
  const sections = body.split(/^(?=#{2,6} )/m);
  const passages: Passage[] = [];
  sections.forEach((section, i) => {
    const heading = /^#{2,6} (.+)$/m.exec(section)?.[1];
    const text = blocks(section.replace(/^#{1,6} .+$/gm, ""))
      .map((b) => b.text)
      .join(" ");
    if (!text) return;
    passages.push({ id: `${source}#${i + 1}`, source, title: heading ? `${doc}: ${heading}` : doc, kind: "note", body: `${heading ? `${doc}, ${heading}` : doc}: ${text}` });
  });
  return passages;
}

/** Every passage from content/ and, if it exists, knowledge/extra/. */
export async function readPassages(content: string, extra?: string): Promise<Passage[]> {
  const read = (path: string) => readFile(join(content, path), "utf8");
  const listed = async (dir: string) => (await readdir(join(content, dir))).filter((f) => f.endsWith(".md")).sort();
  const passages: Passage[] = [...about(await read("about.md"))];
  for (const f of await listed("experience")) passages.push(...experience(`experience/${f}`, await read(`experience/${f}`)));
  for (const f of await listed("projects")) passages.push(...project(`projects/${f}`, await read(`projects/${f}`)));
  passages.push(...skills(await read("skills.yaml")), ...earlierProjects(await read("earlier-projects.yaml")), ...instant(await read("instant.yaml")));
  if (extra && existsSync(extra)) {
    for (const f of (await readdir(extra)).filter((f) => f.endsWith(".md")).sort()) {
      passages.push(...note(`extra/${f}`, await readFile(join(extra, f), "utf8")));
    }
  }
  const seen = new Set<string>();
  for (const p of passages) {
    if (seen.has(p.id)) throw new Error(`two passages share the id ${p.id}`);
    seen.add(p.id);
  }
  return passages;
}

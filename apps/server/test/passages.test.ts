/**
 * Cutting the profile into passages (src/rag/passages.ts), without the model server or database.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT } from "../src/env.ts";
import { blocks, note, readPassages, splitFrontmatter } from "../src/rag/passages.ts";

test("a Markdown file's header and body come apart", () => {
  const { data, body } = splitFrontmatter("---\nname: ARC\ntech: [Python, Qdrant]\n---\n\n- One.\n");
  assert.deepEqual(data, { name: "ARC", tech: ["Python", "Qdrant"] });
  assert.equal(body.trim(), "- One.");
});

test("bullets and paragraphs are split, with wrapped lines joined", () => {
  const text = "A paragraph that\nwraps.\n\n- First bullet\n  carries on.\n- Second.\n\n## A heading\n";
  assert.deepEqual(blocks(text), [
    { bullet: false, text: "A paragraph that wraps." },
    { bullet: true, text: "First bullet carries on." },
    { bullet: true, text: "Second." },
  ]);
});

test("a private note is cut at each heading, and each piece says where it's from", () => {
  const passages = note("extra/hobbies.md", "# Hobbies\n\nIntro line.\n\n## Climbing\n\nBouldering on weekends.\n\n## Empty\n");
  assert.deepEqual(
    passages.map((p) => [p.id, p.title, p.body]),
    [
      ["extra/hobbies.md#1", "Hobbies", "Hobbies: Intro line."],
      ["extra/hobbies.md#2", "Hobbies: Climbing", "Hobbies, Climbing: Bouldering on weekends."],
    ],
  );
});

test("the real profile cuts into passages that each stand on their own", async () => {
  const passages = await readPassages(`${ROOT}content`);
  assert.ok(passages.length > 40, `only ${passages.length} passages`);
  assert.equal(new Set(passages.map((p) => p.id)).size, passages.length, "ids are unique");
  for (const p of passages) {
    assert.ok(p.body.trim().length > 20, `${p.id} is nearly empty`);
    assert.ok(!p.source.startsWith("profile"), "profile/ is never searched");
  }
  // A bullet names its project, so it can be found and understood without the rest of the file.
  const leak = passages.find((p) => p.body.includes("memory leak"));
  assert.ok(leak?.body.startsWith("ARC (PaperPrism), project,"), leak?.body);
  // Every bullet in every project and job becomes a passage.
  const bullets = passages.filter((p) => p.kind === "bullet").length;
  assert.ok(bullets >= 20, `only ${bullets} bullets`);
});

test("private notes are read only when the folder exists", async () => {
  const without = await readPassages(`${ROOT}content`, `${ROOT}knowledge/no-such-folder`);
  assert.ok(without.every((p) => !p.source.startsWith("extra/")));
});

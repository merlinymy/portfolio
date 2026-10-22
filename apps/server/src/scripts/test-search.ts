/**
 * npm run test:search: asks every question in test/search-questions.yaml and checks that the
 * passage answering it comes back (docs/phase-4-knowledge-plan.md).
 *
 * A question passes when one of its expected passages is among the 6 the chat would be given, the
 * same 6 the answer model sees in phase 5. An expected passage is named by its file and a few words
 * it contains, so the test survives reordering a project's bullets. The report also counts how
 * many came first. It exits with an error if any question misses.
 */
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { connect } from "../db/client.ts";
import { type Hit, search } from "../rag/search.ts";

interface Case {
  question: string;
  expect: { source: string; contains: string }[];
}

const SHOWN = 6;
const cases = parse(await readFile(new URL("../../test/search-questions.yaml", import.meta.url), "utf8")) as Case[];

const matches = (hit: Hit, c: Case) =>
  c.expect.some((e) => hit.source === e.source && hit.body.toLowerCase().includes(e.contains.toLowerCase()));

const sql = connect();
let found = 0;
let first = 0;
const misses: string[] = [];
try {
  for (const c of cases) {
    const hits = await search(sql, c.question, SHOWN);
    const rank = hits.findIndex((h) => matches(h, c)) + 1;
    if (rank > 0) found++;
    if (rank === 1) first++;
    console.log(`${rank > 0 ? `found ${rank}` : "MISSED "}  ${c.question}`);
    if (rank === 0) {
      misses.push(c.question);
      for (const h of hits.slice(0, 3)) console.log(`           got ${h.id}`);
    }
  }
} finally {
  await sql.end();
}
console.log(`\n${found} of ${cases.length} found in the top ${SHOWN}; ${first} of ${cases.length} first.`);
if (misses.length) process.exit(1);

/**
 * npm run ingest: loads the profile into the chat's search (docs/phase-4-knowledge-plan.md).
 *
 * Brings the database up to date, cuts content/ (and knowledge/extra/, if there's anything in it)
 * into passages, embeds them on the model server, and swaps them in all at once: the old passages
 * stay searchable until the new ones are all in. Run it after editing either folder.
 *
 *   npm run ingest            load
 *   npm run ingest -- --dry   print the passages instead, without the model server or database
 */
import { connect } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { ROOT } from "../env.ts";
import { asVector, embed } from "../rag/embed.ts";
import { readPassages } from "../rag/passages.ts";

const passages = await readPassages(`${ROOT}content`, `${ROOT}knowledge/extra`);
const words = passages.reduce((n, p) => n + p.body.split(/\s+/).length, 0);
const files = new Set(passages.map((p) => p.source)).size;

if (process.argv.includes("--dry")) {
  for (const p of passages) console.log(`${p.id}  (${p.kind})\n  ${p.body}\n`);
  console.log(`${passages.length} passages, ${words} words, from ${files} files`);
  process.exit(0);
}

const started = performance.now();
const { model, vectors } = await embed(
  passages.map((p) => p.body),
  "passage",
);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

const sql = connect();
try {
  const ran = await migrate(sql);
  if (ran.length) console.log(`database updated: ${ran.join(", ")}`);
  await sql.begin(async (tx) => {
    await tx`delete from passages`;
    for (const [i, p] of passages.entries()) {
      await tx`
        insert into passages (id, source, title, kind, body, embedding, model)
        values (${p.id}, ${p.source}, ${p.title}, ${p.kind}, ${p.body}, ${asVector(vectors[i])}::vector, ${model})`;
    }
  });
  console.log(`loaded ${passages.length} passages (${words} words) from ${files} files; embedding took ${seconds} s with ${model}`);
} finally {
  await sql.end();
}

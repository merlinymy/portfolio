/**
 * npm run search -- "A question.": the passages the chat would be given for it, best first, with
 * where each ranked by meaning and by keyword ("-" means outside that ranking's top 20).
 *
 *   npm run search -- "Have you used Qdrant?" --limit 10
 */
import { connect } from "../db/client.ts";
import { search } from "../rag/search.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--limit");
const limit = at >= 0 ? Number(args.splice(at, 2)[1]) : 6;
const question = args.join(" ").trim();
if (!question) {
  console.error('Ask a question: npm run search -- "Have you used Qdrant?"');
  process.exit(1);
}

const sql = connect();
try {
  const hits = await search(sql, question, limit);
  hits.forEach((h, i) => {
    console.log(`${i + 1}. ${h.id}  (meaning ${h.meaning ?? "-"}, keyword ${h.keyword ?? "-"})`);
    console.log(`   ${h.body.length > 220 ? `${h.body.slice(0, 220)}…` : h.body}`);
  });
} finally {
  await sql.end();
}

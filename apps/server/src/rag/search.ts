/**
 * Hybrid search over the passages (docs/phase-4-knowledge-plan.md): two rankings of the same
 * passages, merged.
 *
 * - By meaning: the passages whose embeddings are closest to the question's.
 * - By keyword: the passages containing the question's words (as stems, "indexing" -> "index"),
 *   each word weighted by how rare it is among the passages. A word in nearly every passage counts
 *   for almost nothing; one in a single passage, like "Qdrant" or "Angular", counts a lot. (The
 *   weight is BM25's inverse document frequency.)
 * - Merged by reciprocal rank fusion: each passage scores 1 / (60 + its rank) in each list it
 *   appears in, so one near the top of both lists beats one at the top of only one.
 */
import type { Sql } from "../db/client.ts";
import { asVector, embed } from "./embed.ts";

/** How far down each ranking is read before merging. */
const POOL = 20;
/**
 * Words recruiters frame questions with, which say nothing about the topic. Left in, "Tell me about
 * a time you…" matches "Tell me about yourself." Postgres reduces them to stems as it does the
 * question's words.
 */
const FRAMING =
  "tell me about a time when describe walk through talk share give example explain know like ever would could please anything something thing way kind sort lot really yourself";
/** Reciprocal rank fusion's usual constant: it keeps the very top ranks from dominating. */
const K = 60;

export interface Hit {
  id: string;
  source: string;
  title: string;
  kind: string;
  body: string;
  score: number;
  /** Where it ranked by meaning and by keyword (1 is best), or null if outside the top POOL. */
  meaning: number | null;
  keyword: number | null;
}

/** Merges rankings (lists of ids, best first) by reciprocal rank fusion. */
export function fuse(rankings: string[][]): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export async function byMeaning(sql: Sql, vector: number[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from passages order by embedding <=> ${asVector(vector)}::vector, id limit ${POOL}`;
  return rows.map((r) => r.id);
}

export async function byKeyword(sql: Sql, question: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    with asked as (
      select unnest(tsvector_to_array(to_tsvector('english', ${question}))) as word
      except
      select unnest(tsvector_to_array(to_tsvector('english', ${FRAMING})))
    ),
    total as (select count(*)::float8 as n from passages),
    weights as (
      select s.word, ln(1 + (total.n - s.ndoc + 0.5) / (s.ndoc + 0.5)) as weight
      from ts_stat('select terms from passages') s, total
      where s.word in (select word from asked)
    )
    select p.id
    from passages p join weights w on w.word = any(tsvector_to_array(p.terms))
    group by p.id
    order by sum(w.weight) desc, p.id
    limit ${POOL}`;
  return rows.map((r) => r.id);
}

/** The `limit` passages that best answer the question, best first. */
export async function search(sql: Sql, question: string, limit = 6): Promise<Hit[]> {
  const {
    vectors: [vector],
  } = await embed([question], "query");
  const [meaning, keyword] = await Promise.all([byMeaning(sql, vector), byKeyword(sql, question)]);
  const top = fuse([meaning, keyword]).slice(0, limit);
  const rows = await sql<Omit<Hit, "score" | "meaning" | "keyword">[]>`
    select id, source, title, kind, body from passages where id = any(${top.map((t) => t.id)})`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rank = (list: string[], id: string) => (list.includes(id) ? list.indexOf(id) + 1 : null);
  return top.map((t) => ({ ...byId.get(t.id)!, score: t.score, meaning: rank(meaning, t.id), keyword: rank(keyword, t.id) }));
}

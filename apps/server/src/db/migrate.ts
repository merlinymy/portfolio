/**
 * Brings the database up to date: runs each file in migrations/ that hasn't run yet, in name
 * order, each in its own transaction, and records it in schema_migrations. Never edit a migration
 * that has run; add a new one.
 */
import { readdir, readFile } from "node:fs/promises";
import type { Sql } from "./client.ts";

const DIR = new URL("./migrations/", import.meta.url);

export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const ran: string[] = [];
  for (const name of (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const text = await readFile(new URL(name, DIR), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    ran.push(name);
  }
  return ran;
}

/**
 * A throwaway Postgres database for tests: made with the .env settings as `portfolio_test_<random>`
 * on the same server, migrated, and dropped afterwards. Tests never touch the `portfolio` database
 * that holds real data.
 */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../../src/db/migrate.ts";
import { setting } from "../../src/env.ts";
import type { Sql } from "../../src/db/client.ts";

function open(database: string): Sql {
  return postgres({
    host: setting("POSTGRES_HOST", "127.0.0.1"),
    port: Number(setting("POSTGRES_PORT", "5433")),
    database,
    username: "portfolio",
    password: setting("POSTGRES_PASSWORD"),
    onnotice: () => {},
    max: 8,
  });
}

export interface TestDb {
  sql: Sql;
  name: string;
  /** Closes the connection and drops the database. */
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `portfolio_test_${randomBytes(6).toString("hex")}`;
  const admin = open("postgres");
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const sql = open(name);
  await migrate(sql);
  return {
    sql,
    name,
    async drop() {
      await sql.end();
      const again = open("postgres");
      try {
        await again.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await again.end();
      }
    },
  };
}

/** A browser row; the ip hash is whatever the test passes (default: a fresh one). */
export async function addVisitor(sql: Sql, ipHash: string = randomUUID()): Promise<string> {
  const id = randomUUID();
  await sql`insert into visitors (id, ip_hash) values (${id}, ${ipHash})`;
  return id;
}

/** Adds a message `secondsAgo` seconds in the past, as the rate limits and the spending sum count them. */
export async function addMessage(
  sql: Sql,
  o: { visitorId: string; ipHash: string; conversationId?: string; action?: string | null; costUsd?: number; secondsAgo?: number; text?: string },
): Promise<void> {
  let conversationId = o.conversationId;
  if (!conversationId) {
    conversationId = randomUUID();
    await sql`insert into conversations (id, visitor_id) values (${conversationId}, ${o.visitorId})`;
  }
  await sql`
    insert into messages (conversation_id, visitor_id, ip_hash, role, text, action, cost_usd, created_at)
    values (${conversationId}, ${o.visitorId}, ${o.ipHash}, 'visitor', ${o.text ?? "hello"}, ${o.action === undefined ? "answer" : o.action},
            ${(o.costUsd ?? 0).toFixed(6)}, now() - make_interval(secs => ${o.secondsAgo ?? 0}))`;
}

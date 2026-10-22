/**
 * The connection to Postgres (docker-compose.yml): on this Mac only, as the `portfolio` user.
 */
import postgres from "postgres";
import { setting } from "../env.ts";

export type Sql = postgres.Sql;

export function connect(): Sql {
  return postgres({
    host: setting("POSTGRES_HOST", "127.0.0.1"),
    port: Number(setting("POSTGRES_PORT", "5433")),
    database: "portfolio",
    username: "portfolio",
    password: setting("POSTGRES_PASSWORD"),
    // Postgres reports "already exists" notices on reruns of the migrations; they aren't problems.
    onnotice: () => {},
  });
}

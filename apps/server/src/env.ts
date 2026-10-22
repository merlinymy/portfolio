/**
 * Settings from the repo root's .env file (copy .env.example; git ignores .env). Values already
 * set in the environment win, so a container or a test can override them.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo root, wherever a script is run from. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const file = `${ROOT}.env`;
if (existsSync(file)) process.loadEnvFile(file);

export function setting(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error(`${name} isn't set: add it to .env (see .env.example)`);
  return value;
}

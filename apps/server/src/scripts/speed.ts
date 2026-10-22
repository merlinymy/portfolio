/**
 * npm run speed: how long each stage of a reply takes (plan §7.10), over the last 500 visitor
 * messages. "typical" is the median (half of messages were quicker); "slow" is the 95th percentile
 * (1 message in 20 was slower). Each speed-up round goes after the biggest number.
 */
import { recentTimings } from "../db/chat.ts";
import { connect } from "../db/client.ts";

export const STAGES = ["gate", "prefilter", "strike_check", "search", "answer", "output_check", "first_audio", "total"] as const;

/** The value that `p` (0 to 1) of the sorted values are at or below (nearest rank). */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** Per stage: how many messages had it, and the typical and slow times in milliseconds. */
export function stageStats(rows: Record<string, number>[]): { stage: string; count: number; typical: number; slow: number }[] {
  const stats = [];
  for (const stage of STAGES) {
    const values = rows.map((r) => r[stage]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    if (values.length) stats.push({ stage, count: values.length, typical: percentile(values, 0.5), slow: percentile(values, 0.95) });
  }
  return stats;
}

if (import.meta.main) {
  const sql = connect();
  try {
    const rows = await recentTimings(sql, 500);
    if (rows.length === 0) {
      console.log("No messages yet.");
    } else {
      console.log(`Stage times over the last ${rows.length} messages (milliseconds):\n`);
      console.log(`${"stage".padEnd(14)}${"messages".padStart(9)}${"typical".padStart(10)}${"slow".padStart(10)}`);
      for (const s of stageStats(rows)) {
        console.log(`${s.stage.padEnd(14)}${String(s.count).padStart(9)}${String(s.typical).padStart(10)}${String(s.slow).padStart(10)}`);
      }
      console.log("\ntypical = the median; slow = the 95th percentile (1 message in 20 took longer).");
    }
  } finally {
    await sql.end();
  }
}

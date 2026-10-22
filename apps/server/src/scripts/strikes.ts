/**
 * npm run strikes: looking at strikes, and undoing one given by mistake (plan §7.2). There's no
 * admin page; transcripts record every strike and its reason, so the ids come from here.
 *
 *   npm run strikes -- list                 the latest 50 strikes, newest first, with the message that earned each
 *   npm run strikes -- list <visitorId>     one browser's strikes, and where it stands
 *   npm run strikes -- revoke <strikeId>    marks the strike revoked, takes one off the browser's count, and
 *                                           unlocks it if that brings it under 3
 *   npm run strikes -- unlock <visitorId>   clears a browser's strikes and lock
 */
import { getVisitor, listStrikes, revokeStrike, unlockVisitor } from "../db/chat.ts";
import { connect } from "../db/client.ts";
import { isUuid } from "../identity.ts";

const [command, argument] = process.argv.slice(2);

const usage = () => {
  console.error("Usage: npm run strikes -- list [visitorId] | revoke <strikeId> | unlock <visitorId>");
  process.exit(1);
};
const standing = (v: { strikes: number; lockedUntil: Date | null }) =>
  `${v.strikes} strike${v.strikes === 1 ? "" : "s"}, ${v.lockedUntil ? `locked until ${v.lockedUntil.toISOString()}` : "not locked"}`;

if (!command) usage();
if ((command === "revoke" && !/^\d+$/.test(argument ?? "")) || (command === "unlock" && !isUuid(argument))) usage();
if (command === "list" && argument !== undefined && !isUuid(argument)) usage();

const sql = connect();
try {
  if (command === "list") {
    if (argument) {
      const visitor = await getVisitor(sql, argument);
      console.log(visitor ? `Browser ${argument}: ${standing(visitor)}` : `No browser ${argument}.`);
    }
    const rows = await listStrikes(sql, argument);
    for (const s of rows) {
      const message = s.messageText ? ` "${s.messageText.replace(/\s+/g, " ").slice(0, 100)}"` : "";
      console.log(`#${s.id}  ${s.createdAt.toISOString()}  ${s.category}${s.revokedAt ? "  (revoked)" : ""}  browser ${s.visitorId}`);
      console.log(`    why: ${s.reason}${message ? `\n    said:${message}` : ""}`);
    }
    if (rows.length === 0) console.log("No strikes.");
  } else if (command === "revoke") {
    const result = await revokeStrike(sql, argument);
    if (!result) console.log(`No strike #${argument}.`);
    else if (result.alreadyRevoked) console.log(`Strike #${argument} was already revoked. Browser ${result.visitorId}: ${standing(result)}.`);
    else console.log(`Revoked strike #${argument}. Browser ${result.visitorId} now has ${standing(result)}.`);
  } else if (command === "unlock") {
    console.log((await unlockVisitor(sql, argument)) ? `Browser ${argument} has no strikes and isn't locked.` : `No browser ${argument}.`);
  } else {
    usage();
  }
} finally {
  await sql.end();
}

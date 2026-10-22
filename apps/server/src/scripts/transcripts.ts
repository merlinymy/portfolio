/**
 * npm run transcripts: reading what visitors and the chat said (plan §7.6). They're private: the
 * messages are in your database on this Mac only.
 *
 *   npm run transcripts -- recent [n]            the n newest conversations (default 20), one line each
 *   npm run transcripts -- show <conversationId> the whole conversation, with how each reply was made and what it cost
 *   npm run transcripts -- purge                 removes conversations, handoffs, instant clicks, browsers not seen, and
 *                                                emails saved in knowledge/outbox, all older than 12 months
 *                                                (the api also does this at start and every 24 hours)
 */
import { conversationMessages, purgeOld, recentConversations } from "../db/chat.ts";
import { connect } from "../db/client.ts";
import { ROOT } from "../env.ts";
import { isUuid } from "../identity.ts";
import { purgeOutbox } from "../mail.ts";

const [command, argument] = process.argv.slice(2);

const usage = () => {
  console.error("Usage: npm run transcripts -- recent [n] | show <conversationId> | purge");
  process.exit(1);
};
if (!command) usage();
if (command === "show" && !isUuid(argument)) usage();
if (command === "recent" && argument !== undefined && !/^[1-9]\d*$/.test(argument)) usage();

const sql = connect();
try {
  if (command === "recent") {
    const rows = await recentConversations(sql, Number(argument ?? 20));
    for (const c of rows) {
      const first = (c.firstQuestion ?? "").replace(/\s+/g, " ").slice(0, 70);
      console.log(`${c.id}  ${c.startedAt.toISOString()}  ${c.messages} messages  $${c.costUsd.toFixed(4)}  [${c.actions.join(", ")}]  "${first}"`);
    }
    if (rows.length === 0) console.log("No conversations yet.");
  } else if (command === "show") {
    const messages = await conversationMessages(sql, argument);
    if (messages.length === 0) console.log(`No messages in conversation ${argument}.`);
    for (const m of messages) {
      const who = m.role === "visitor" ? "Visitor" : "AI Merlin";
      const how = [m.action, m.category].filter(Boolean).join(", ");
      console.log(`[${m.createdAt.toISOString()}] ${who}${how ? ` (${how})` : ""}:`);
      if (m.jobPostLength) console.log(`  (pasted a job posting, ${m.jobPostLength} characters)`);
      console.log(`  ${m.text.replace(/\n/g, "\n  ")}`);
      if (m.role === "visitor" && (m.reason || m.costUsd)) console.log(`  -- ${m.reason ?? ""}${m.costUsd ? `  cost $${m.costUsd.toFixed(4)}` : ""}`);
    }
  } else if (command === "purge") {
    const gone = await purgeOld(sql);
    const files = await purgeOutbox(`${ROOT}knowledge/outbox`);
    console.log(
      `Removed ${gone.conversations} conversations, ${gone.handoffs} handoffs, ${gone.clicks} instant clicks, ` +
        `${gone.visitors} browsers and ${files} outbox files older than 12 months.`,
    );
  } else {
    usage();
  }
} finally {
  await sql.end();
}

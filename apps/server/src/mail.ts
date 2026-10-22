/**
 * Email to you (plan §7.5, §7.7): handoffs, and the monthly spending-cap alert. Sent through
 * Resend's REST API once RESEND_API_KEY and HANDOFF_TO are set; until then each email is saved as
 * a text file in knowledge/outbox/ (private, git-ignored) and one line in the log says where.
 * Message bodies are never logged: they hold visitors' details.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { ROOT } from "./env.ts";

export interface Mail {
  subject: string;
  text: string;
  /** Where a reply goes (a handoff's visitor), so answering the email answers them. */
  replyTo?: string;
}

export interface MailConfig {
  apiKey?: string;
  to?: string;
  from: string;
  outboxDir: string;
}

/** Reads the settings when called, so a changed .env takes effect on restart like the rest. */
export function mailConfig(): MailConfig {
  return {
    apiKey: process.env.RESEND_API_KEY || undefined,
    to: process.env.HANDOFF_TO || undefined,
    from: process.env.HANDOFF_FROM || "Merlin's site <chat@merlinyang.com>",
    outboxDir: `${ROOT}knowledge/outbox`,
  };
}

/**
 * Saves an email as a text file in the outbox and returns its path. The name is the time and a
 * random tag, never anything from the email: file names and log lines would otherwise carry a
 * visitor's name. Only you can read the file.
 */
export async function saveToOutbox(mail: Mail, outboxDir: string): Promise<string> {
  await mkdir(outboxDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${outboxDir}/${stamp}-${randomBytes(6).toString("hex")}.txt`;
  const head = [`Subject: ${mail.subject}`, mail.replyTo ? `Reply-To: ${mail.replyTo}` : null].filter(Boolean).join("\n");
  await writeFile(path, `${head}\n\n${mail.text}\n`, { mode: 0o600 });
  return path;
}

/** Deletes outbox files not touched for `months` months (they hold visitors' details); returns how many. */
export async function purgeOutbox(outboxDir: string, months = 12, now = Date.now()): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  let names: string[];
  try {
    names = await readdir(outboxDir);
  } catch {
    return 0; // no outbox yet
  }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith(".txt"))) {
    const file = `${outboxDir}/${name}`;
    try {
      if ((await stat(file)).mtimeMs < cutoff.getTime()) {
        await unlink(file);
        removed++;
      }
    } catch {
      // gone already, or not ours to delete: leave it
    }
  }
  return removed;
}

/**
 * Sends the email, or saves it to the outbox when Resend isn't set up. Throws if Resend refuses it
 * (the caller records that); the message is the status and Resend's error name, never the body.
 */
export async function sendMail(
  mail: Mail,
  config: MailConfig = mailConfig(),
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = console.log,
): Promise<{ via: "resend" | "outbox"; where?: string }> {
  if (!config.apiKey || !config.to) {
    const path = await saveToOutbox(mail, config.outboxDir);
    log(`mail: saved to ${path.startsWith(ROOT) ? path.slice(ROOT.length) : path} (RESEND_API_KEY or HANDOFF_TO isn't set)`);
    return { via: "outbox", where: path };
  }
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.from,
      to: config.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { name?: unknown } | null;
    throw new Error(`Resend answered ${res.status}${typeof detail?.name === "string" ? ` (${detail.name})` : ""}`);
  }
  log("mail: sent through Resend");
  return { via: "resend" };
}

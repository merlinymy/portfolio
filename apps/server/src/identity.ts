/**
 * Who is asking (plan §7.2): the signed visitor cookie, the scrambled IP address, and Cloudflare
 * Turnstile's check that a person (not a script) is behind a request.
 *
 * The cookie is `<visitor uuid>.<HMAC-SHA256 of the uuid, base64url>`. The signature, made with a
 * secret only the server knows, means a cookie someone edited or invented is detected.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { setting } from "./env.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/**
 * Compares two strings without the time taken depending on where they first differ. Both are
 * hashed first, so their lengths don't leak either.
 */
export function safeEqual(a: string, b: string): boolean {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function signature(visitorId: string, secret: string): string {
  return createHmac("sha256", secret).update(visitorId).digest("base64url");
}

/** The cookie's value for a browser. */
export function signVisitor(visitorId: string, secret = setting("COOKIE_SECRET")): string {
  return `${visitorId}.${signature(visitorId, secret)}`;
}

/** The visitor id inside a cookie value, or null if it's missing, malformed or its signature doesn't match. */
export function verifyVisitor(cookie: string | undefined, secret = setting("COOKIE_SECRET")): string | null {
  if (!cookie) return null;
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const id = cookie.slice(0, dot);
  if (!isUuid(id)) return null;
  return safeEqual(cookie.slice(dot + 1), signature(id, secret)) ? id : null;
}

/**
 * Text from a visitor made safe to store and show: control characters (a NUL makes Postgres refuse
 * the row) and lone surrogate halves are dropped; newlines and tabs stay.
 */
export function stripControl(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** The eight 16-bit groups of an IPv6 address, or null if it doesn't parse. */
function groupsOf(address: string): number[] | null {
  let text = address;
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const before = head ? head.split(":") : [];
  const after = tail ? tail.split(":") : [];
  const gap = 8 - before.length - after.length;
  if (tail === undefined ? gap !== 0 : gap < 1) return null;
  const groups = [...before, ...(tail === undefined ? [] : Array(gap).fill("0")), ...after].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * What identifies a visitor's network, for limits and for scrambling: an IPv4 address as it is, an
 * IPv4-mapped IPv6 address (::ffff:1.2.3.4) as the IPv4 address, and any other IPv6 address as its
 * first 64 bits, since one subscriber is normally given a whole /64 and could otherwise rotate
 * through billions of addresses to dodge a per-address limit.
 */
export function normalizeIp(ip: string): string {
  let address = ip.trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (isIPv4(address) || !isIPv6(address)) return address;
  const groups = groupsOf(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/**
 * An IP address scrambled one way with a secret (HMAC-SHA256, hex): enough to count one network's
 * messages, never the address itself. IPv6 addresses count by their /64 (see normalizeIp).
 */
export function hashIp(ip: string, salt = setting("IP_SALT")): string {
  return createHmac("sha256", salt).update(normalizeIp(ip)).digest("hex");
}

/**
 * What the api's secrets must look like to start (security review): the three that sign and scramble
 * need 32 characters or more, and Cloudflare's Turnstile test keys (which let every token through)
 * are flagged. Returns problems and warnings; main.ts refuses to start on the first and logs the second.
 */
export function checkSettings(env: Record<string, string | undefined> = process.env): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const name of ["ORIGIN_SECRET", "COOKIE_SECRET", "IP_SALT"]) {
    const value = env[name] ?? "";
    if (value.length < 32) errors.push(`${name} must be at least 32 characters${value ? ` (it is ${value.length})` : " (it isn't set)"}; make one with: openssl rand -hex 32`);
  }
  if (/^[123]x0000/.test(env.TURNSTILE_SECRET ?? "")) {
    warnings.push("TURNSTILE_SECRET is one of Cloudflare's TEST keys: every Turnstile token passes, so anything can create browsers. Use the real secret key before this is public.");
  }
  return { errors, warnings };
}

const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Asks Cloudflare whether a Turnstile token is genuine. False if it isn't, or if Cloudflare can't
 * be reached: a visitor is never let in unchecked. (Cloudflare's test secrets: 1x000…AA always
 * passes and 2x000…AA always fails.)
 */
export async function verifyTurnstile(
  token: string,
  ip: string | undefined,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetchImpl(TURNSTILE_URL, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: unknown };
    return body.success === true;
  } catch (err) {
    console.error(`turnstile: couldn't reach Cloudflare (${err instanceof Error ? err.name : "error"})`);
    return false;
  }
}

/**
 * The visitor cookie, the scrambled IP address and the Turnstile check (src/identity.ts), with
 * Cloudflare stubbed out.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkSettings, hashIp, isUuid, normalizeIp, safeEqual, signVisitor, stripControl, verifyTurnstile, verifyVisitor } from "../src/identity.ts";

const SECRET = "test-cookie-secret";

test("a signed cookie gives back the visitor it was made for", () => {
  const id = randomUUID();
  const cookie = signVisitor(id, SECRET);
  assert.match(cookie, /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyVisitor(cookie, SECRET), id);
});

test("a changed or invented cookie is refused", () => {
  const id = randomUUID();
  const cookie = signVisitor(id, SECRET);
  const [, signature] = cookie.split(".");
  const other = randomUUID();
  assert.equal(verifyVisitor(`${other}.${signature}`, SECRET), null, "someone else's id with this signature");
  assert.equal(verifyVisitor(`${id}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`, SECRET), null, "one character of the signature changed");
  assert.equal(verifyVisitor(`${id}.`, SECRET), null, "no signature");
  assert.equal(verifyVisitor(id, SECRET), null, "no dot");
  assert.equal(verifyVisitor(`not-a-uuid.${signature}`, SECRET), null, "not an id");
  assert.equal(verifyVisitor("", SECRET), null);
  assert.equal(verifyVisitor(undefined, SECRET), null);
  assert.equal(verifyVisitor(cookie, "another-secret"), null, "signed with a different secret");
});

test("the IP address is scrambled the same way each time, differently per salt, and never kept", () => {
  const a = hashIp("203.0.113.9", "salt");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hashIp("203.0.113.9", "salt"));
  assert.notEqual(a, hashIp("203.0.113.10", "salt"));
  assert.notEqual(a, hashIp("203.0.113.9", "other salt"));
  assert.ok(!a.includes("203"));
});

test("safeEqual compares whole strings, whatever their length", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual("", "x"));
  assert.ok(isUuid(randomUUID()));
  assert.ok(!isUuid("nope"));
});

function stubFetch(answer: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as typeof fetch;
  return { impl, calls };
}

test("Turnstile: a token Cloudflare accepts passes, and the request is the form Cloudflare documents", async () => {
  const { impl, calls } = stubFetch(Response.json({ success: true }));
  assert.equal(await verifyTurnstile("tok", "203.0.113.9", "secret", impl), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(calls[0].init.method, "POST");
  const form = calls[0].init.body as URLSearchParams;
  assert.equal(form.get("secret"), "secret");
  assert.equal(form.get("response"), "tok");
  assert.equal(form.get("remoteip"), "203.0.113.9");
});

test("Turnstile: a refused token, a bad answer or an unreachable Cloudflare all fail closed", async (t) => {
  t.mock.method(console, "error", () => {}); // the unreachable and unreadable cases log one line each
  assert.equal(await verifyTurnstile("tok", "1.2.3.4", "s", stubFetch(Response.json({ success: false, "error-codes": ["invalid-input-response"] })).impl), false);
  assert.equal(await verifyTurnstile("tok", "1.2.3.4", "s", stubFetch(new Response("nope", { status: 500 })).impl), false);
  assert.equal(await verifyTurnstile("tok", "1.2.3.4", "s", stubFetch(new Response("not json")).impl), false);
  assert.equal(await verifyTurnstile("tok", "1.2.3.4", "s", stubFetch(new Error("offline")).impl), false);
});

test("Turnstile: with no address known, no remoteip is sent", async () => {
  const { impl, calls } = stubFetch(Response.json({ success: true }));
  await verifyTurnstile("tok", undefined, "s", impl);
  assert.equal((calls[0].init.body as URLSearchParams).has("remoteip"), false);
});

test("control characters and lone surrogates are dropped; newlines, tabs and real text stay", () => {
  assert.equal(stripControl("a\u0000b"), "ab");
  assert.equal(stripControl("tab\there\nnewline"), "tab\there\nnewline");
  assert.equal(stripControl("x\u0001\u0007\u001f\u007f\u0085\u009fy"), "xy");
  assert.equal(stripControl("carriage\r\nreturn"), "carriage\nreturn");
  assert.equal(stripControl("lone \ud800 high, lone \udc00 low"), "lone  high, lone  low");
  assert.equal(stripControl("emoji 😀 and 你好 and é"), "emoji 😀 and 你好 and é");
  assert.equal(stripControl(""), "");
});

test("IP addresses are compared by network: IPv4 as it is, IPv4-mapped IPv6 as IPv4, other IPv6 by its /64", () => {
  assert.equal(normalizeIp("203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeIp("::FFFF:cb00:7109"), "203.0.113.9");
  const subscriber = normalizeIp("2001:db8:1:2:3:4:5:6");
  assert.equal(subscriber, "2001:db8:1:2::/64");
  for (const same of ["2001:db8:1:2::9", "2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2:0:0:0:1", "[2001:db8:1:2::1]", "2001:db8:1:2::1%en0"]) {
    assert.equal(normalizeIp(same), subscriber, same);
  }
  assert.notEqual(normalizeIp("2001:db8:1:3::1"), subscriber, "the next /64 is another network");
  assert.equal(normalizeIp("::1"), normalizeIp("0:0:0:0:ffff::1"), "loopback and a nearby address share the all-zero /64");
  assert.equal(normalizeIp("unknown"), "unknown");
  assert.equal(normalizeIp("not an address"), "not an address");
});

test("hashIp scrambles the network, so rotating through one IPv6 /64 gives one hash", () => {
  const hash = (ip: string) => hashIp(ip, "salt");
  assert.equal(hash("2001:db8:1:2::1"), hash("2001:db8:1:2:aaaa:bbbb:cccc:dddd"));
  assert.notEqual(hash("2001:db8:1:2::1"), hash("2001:db8:1:3::1"));
  assert.equal(hash("::ffff:198.51.100.7"), hash("198.51.100.7"), "an IPv4 client seen through IPv6 is the same client");
  assert.notEqual(hash("198.51.100.7"), hash("198.51.100.8"));
  assert.match(hash("2001:db8::1"), /^[0-9a-f]{64}$/);
  assert.ok(!hash("2001:db8::1").includes("2001"));
});

test("the api won't start with short secrets, and says so about Cloudflare's test Turnstile keys", () => {
  const good = { ORIGIN_SECRET: "a".repeat(64), COOKIE_SECRET: "b".repeat(32), IP_SALT: "c".repeat(40), TURNSTILE_SECRET: "0x4AAAAAAAreal" };
  assert.deepEqual(checkSettings(good), { errors: [], warnings: [] });

  const weak = checkSettings({ ...good, ORIGIN_SECRET: "short", COOKIE_SECRET: "b".repeat(31), IP_SALT: undefined });
  assert.equal(weak.errors.length, 3);
  assert.match(weak.errors[0], /ORIGIN_SECRET.*at least 32.*it is 5/);
  assert.match(weak.errors[1], /COOKIE_SECRET.*it is 31/);
  assert.match(weak.errors[2], /IP_SALT.*isn't set/);
  assert.ok(!weak.errors.join(" ").includes("short\""), "the secret itself isn't printed");

  for (const key of ["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000FF"]) {
    const test = checkSettings({ ...good, TURNSTILE_SECRET: key });
    assert.deepEqual(test.errors, []);
    assert.equal(test.warnings.length, 1);
    assert.match(test.warnings[0], /TEST keys/);
    assert.ok(!test.warnings[0].includes(key));
  }
});

/**
 * Makes a reply fit to be spoken (plan §7.1 step 6, docs/phase-5-chat-plan.md): plain prose with no
 * Markdown (the asterisks, hash marks and dashes some text uses for bold, headings and lists), no
 * HTML tags and no links except to your own sites, then cut into sentences that can each be sent to
 * the voice. The reply is read aloud, so a stray asterisk or a list marker would be heard.
 *
 * Replies are plain text, so a link in one is a link the visitor could be tricked into following:
 * only addresses under allowedLinks() survive, whatever the answer model was talked into writing.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { splitFrontmatter } from "../rag/passages.ts";

/** The longest piece the model server will voice at once (docs/phase-5-chat-plan.md). */
const MAX_SENTENCE = 600;

// ── Finding links ───────────────────────────────────────────────────────────────────────────────

const set = (list: string) => new Set(list.trim().split(/\s+/));

/** Every ending an address can have: the country ones, and the common others. */
const COUNTRY_ENDINGS = set(`
  ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg
  ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi
  gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw
  ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng
  ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn
  so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws
  ye yt za zm zw
`);
const ALL_ENDINGS = new Set([
  ...COUNTRY_ENDINGS,
  ...set(`
    com org net edu gov mil int info biz name pro mobi asia travel jobs xyz online site tech store shop app dev page cloud
    club top live blog news link click work world today space website fun icu vip wiki art studio agency digital email
    solutions services systems network group company center academy global guru ninja rocks social media games zone life
    love team tools land bio ink
  `),
]);

/**
 * Endings that make a bare "name.ending" an address even with no path after it. The country ones
 * that are also ordinary words (.me, .us, .it, .is, .no) or file types (.md, .py, .rs, .sh, .cc)
 * aren't here: "README.md" and "main.py" are file names, and "done.it" is a missing space. With a
 * path after them ("evil.cc/login") any ending counts.
 */
const BARE_ENDINGS = set(`
  com org net edu gov mil int info biz mobi asia xyz io ai co dev app uk ca de fr jp cn au nz es nl ru br ch se ly tv gg gl
  site online tech store shop link page cloud club top live blog news pro
`);
/** The word before a country ending in "example.co.in" or "example.com.au". */
const SECOND_LEVEL = set("co com org net ac gov edu or ne go");
/** Product names that look like addresses and aren't. */
const NOT_ADDRESSES = set("socket.io asp.net vb.net claude.ai character.ai");

const SCHEMES = set(`
  http https ftp ftps sftp ssh git svn ws wss mailto tel sms mms javascript vbscript data file blob about chrome
  chrome-extension moz-extension view-source intent market magnet irc ircs news nntp telnet ldap ldaps smb nfs rtsp rtmp
  xmpp sip sips skype slack spotify steam zoommtg whatsapp facebook geo bitcoin urn jar callto facetime itms itms-apps
  ms-settings vscode
`);

const NOT_SPACE = String.raw`[^\s<>"'\x60]`;
const LINK_PATTERN = new RegExp(
  [
    // https://…, ftp://…, or any other "name://".
    String.raw`(?<scheme>\b[a-z][a-z0-9+.-]{1,30}:\/\/${NOT_SPACE}*)`,
    // mailto:x@y.com, javascript:alert(1), data:text/html,…: a known scheme, or any "name:" followed by something address-like.
    // (Not "**Note:** text" or "Note: text": the colon has to be followed at once by the address.)
    String.raw`(?<colon>\b(?:${[...SCHEMES].join("|")}):(?=[^\s:<>"'\x60*_~])${NOT_SPACE}*)`,
    String.raw`(?<other>\b[a-z][a-z0-9+.-]{1,30}:(?=[^\s:<>"'\x60*_~])(?=${NOT_SPACE}*[/@(])${NOT_SPACE}*)`,
    // www.…
    String.raw`(?<www>\bwww\.${NOT_SPACE}+)`,
    // 192.168.1.1, 192.168.1.1:8080/admin
    String.raw`(?<ip4>(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)(?::\d{1,5})?(?:\/${NOT_SPACE}*)?)`,
    // [2001:db8::1]:8080/x, and 2001:db8::1 or fe80::1 on their own.
    String.raw`(?<ip6b>\[[0-9a-f:.]{3,}\](?::\d{1,5})?(?:\/${NOT_SPACE}*)?)`,
    String.raw`(?<ip6>(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4})?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})(?![\w:.]))`,
    // example.com or example.io/path, not part of an email address or a longer word.
    String.raw`(?<bare>(?<![\w@./:%+-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![\w@-])(?<path>\/${NOT_SPACE}*)?)`,
  ].join("|"),
  "gi",
);

export interface FoundLink {
  /** The address as written, without the punctuation that ended the sentence. */
  url: string;
  start: number;
  end: number;
}

const validOctets = (ip: string) => ip.split(/[:/]/)[0].split(".").every((n) => Number(n) <= 255);

/**
 * Anything in a piece of text that works as a link: an address with a scheme (https://…, mailto:…,
 * javascript:…), one starting www., an IP address, or a name ending in a real domain ending
 * (example.com, x.io/path, evil.cc/login, example.co.in). "Node.js", "README.md", "3.8", "e.g."
 * and email addresses aren't.
 */
export function findUrls(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of text.matchAll(LINK_PATTERN)) {
    let url = m[0];
    // The punctuation after a link ("see example.com.", "(example.com)") isn't part of it.
    for (;;) {
      const last = url.at(-1)!;
      const unbalanced = (open: string, close: string) => last === close && url.split(close).length > url.split(open).length;
      if (".,;:!?'\"".includes(last) || unbalanced("(", ")") || unbalanced("[", "]") || unbalanced("{", "}")) url = url.slice(0, -1);
      else break;
    }
    if (!url) continue;
    const g = m.groups!;
    if (g.ip4 && !validOctets(url)) continue;
    if (g.ip6b && (url.match(/:/g)?.length ?? 0) < 2) continue;
    // Like "Add::add" in code, a run of letters and colons is only an address if it has a digit.
    if (g.ip6 && !/\d/.test(url)) continue;
    if (g.bare) {
      const host = url.split("/")[0];
      const labels = host.toLowerCase().split(".");
      const ending = labels.at(-1)!;
      if (!ALL_ENDINGS.has(ending)) continue;
      if (!g.path) {
        // Bare, it has to look like a domain, not a name: "ASP.NET", "M.Sc", "done.Today", "main.py".
        if (NOT_ADDRESSES.has(host.toLowerCase()) || host.split(".").at(-1) !== ending || labels.at(-2)!.length < 2) continue;
        const second = labels.length >= 3 && SECOND_LEVEL.has(labels.at(-2)!) && COUNTRY_ENDINGS.has(ending);
        if (!BARE_ENDINGS.has(ending) && !second) continue;
      }
    }
    found.push({ url, start: m.index, end: m.index + url.length });
  }
  return found;
}

// ── Which links are allowed ─────────────────────────────────────────────────────────────────────

interface Prefix {
  host: string;
  /** "https://*.example.com": any subdomain of the host, but not the host itself. */
  subdomains: boolean;
  /** Lowercase, no trailing slash; empty for the whole site. */
  path: string;
}

/** A link's host and path, the way a browser would read them, so tricks like "a.com\@b.com" or "a/../b" can't pass. */
function where(url: string): { host: string; path: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return {
    host: parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, ""),
    path: parsed.pathname.toLowerCase().replace(/\/+$/, ""),
  };
}

function prefixOf(entry: string): Prefix | null {
  const wildcard = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\*\./i.test(entry);
  const place = where(entry.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)\*\./i, "$1"));
  return place && { ...place, subdomains: wildcard };
}

function isAllowed(url: string, prefixes: Prefix[]): boolean {
  const place = where(url);
  if (!place) return false;
  return prefixes.some((p) => {
    const hostOk = p.subdomains ? place.host.endsWith(`.${p.host}`) : place.host === p.host;
    // A path prefix matches whole parts only: /merlinymy and /merlinymy/repo, not /merlinymy-evil.
    const pathOk = p.path === "" || place.path === p.path || place.path.startsWith(`${p.path}/`);
    return hostOk && pathOk;
  });
}

// ── Cleaning a reply ────────────────────────────────────────────────────────────────────────────

/** Tags that sit inside a line of text, so removing one shouldn't leave a gap. */
const INLINE_TAGS = new Set("a b i u s em strong span code small sup sub mark del ins abbr cite q kbd font".split(" "));
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Characters that can't be heard or seen but can hide things: control characters, zero-width and
 * soft-hyphen characters, left-to-right and right-to-left overrides that make "moc.live" show as
 * "evil.com", and the private-use range, which holds this file's own markers while it works.
 */
const INVISIBLE = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e000}-\u{f8ff}]/gu;

/** A line of a Markdown table or list that was a sentence on its own ends like one, so the voice pauses. */
const terminated = (text: string) => (/[.!?:;,…]["')\]]*$/.test(text) ? text : `${text}.`);

/**
 * @param text the answer model's reply
 * @param allowed link prefixes that may stay (allowedLinks()): scheme optional, case ignored,
 *   matched on host and whole path parts; "https://*.example.com" means any subdomain
 */
export function cleanReply(text: string, allowed: readonly string[]): string {
  const prefixes = allowed.map(prefixOf).filter((p): p is Prefix => p !== null);
  const keep = (url: string) => isAllowed(url, prefixes);
  let droppedLink = false;

  /** Takes out every link that isn't yours; `mark` can set a kept one aside. */
  const scrub = (piece: string, mark: (url: string) => string = (url) => url): string => {
    let rebuilt = "";
    let at = 0;
    for (const link of findUrls(piece)) {
      rebuilt += piece.slice(at, link.start);
      if (keep(link.url)) rebuilt += mark(link.url);
      else droppedLink = true;
      at = link.end;
    }
    return rebuilt + piece.slice(at);
  };

  // Code and kept links are set aside while Markdown is stripped, so "__init__" and "a_b_c" survive.
  // Code is no place to hide a link, so it's scrubbed first.
  const held: string[] = [];
  const hold = (piece: string) => `\u{e000}${held.push(piece) - 1}\u{e001}`;

  // Look-alike letters ("ｅｖｉｌ．ｃｏｍ", "evil․com") become ordinary ones, and invisible characters go.
  let s = text.normalize("NFKC").replace(INVISIBLE, "").replace(/\r\n?/g, "\n");

  // HTML: comments and script blocks whole, autolinks (<https://…>) as plain links, other tags dropped.
  s = s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<((?:[a-z][a-z0-9+.-]*):\/\/[^<>\s]+)>/gi, "$1")
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^<>]*>/gi, (_tag, name: string) => (INLINE_TAGS.has(name.toLowerCase()) ? "" : " "))
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    // An entity can spell out what was just taken away ("&#xE000;"), so it goes again.
    .replace(INVISIBLE, "");

  const lines: string[] = [];
  let fenced = false;
  for (const raw of s.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (raw.trim()) lines.push(hold(scrub(raw.trim())));
      continue;
    }

    // The line's job: heading, list item, quote, table row, or plain text.
    let line = raw;
    let ownSentence = false;
    let m: RegExpExecArray | null;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*=+\s*$/.test(line) || /^\s*\[[^\]]+\]:\s*\S+/.test(line)) continue;
    if ((m = /^\s{0,3}#{1,6}(?:\s+(.*))?$/.exec(line))) {
      line = (m[1] ?? "").replace(/\s+#+\s*$/, "");
      ownSentence = true;
    } else if ((m = /^\s*(?:[-*+•]|\d{1,2}[.)])\s+(.*)$/.exec(line))) {
      line = m[1].replace(/^\[[ xX]\]\s*/, "");
      ownSentence = true;
    } else if (/^\s*>/.test(line)) {
      line = line.replace(/^(\s*>\s?)+/, "");
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) continue;
      line = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(", ");
      ownSentence = true;
    }

    // Inline: code, images, links, then bold and italics.
    line = line.replace(/(`+)(.+?)\1/g, (_whole, _ticks, code: string) => hold(scrub(code.trim()))).replace(/`+/g, "");
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    line = line.replace(/\[([^\]]*)\]\(\s*<?((?:[^()\s>]|\([^()\s]*\))*)>?(?:\s+"[^"]*")?\s*\)/g, (_whole, label: string, url: string) => {
      if (!url || !keep(url)) {
        droppedLink ||= !!url;
        return label;
      }
      // "[example.com](https://example.com)" already says where it goes.
      const shown = (u: string) => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
      return !label || shown(label).includes(shown(url)) ? (label || url) : `${label} (${url})`;
    });
    line = line.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

    // Any other link: kept only if it's yours.
    line = scrub(line, hold);

    line = line
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1")
      .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1")
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
      .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1")
      .replace(/(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1")
      .replace(/\*{2,}|~~|__/g, "")
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");

    line = line.trim();
    if (line) lines.push(ownSentence ? terminated(line) : line);
  }

  let out = lines.join("\n").replace(/\u{e000}(\d+)\u{e001}/gu, (_whole, i: string) => held[+i] ?? "");
  // Stripping Markdown can bring a link together that was written in pieces ("evil**.**com"), so look once more.
  out = scrub(out);
  // A removed link can leave "see ." or "()" behind.
  if (droppedLink) out = out.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s+([,.;:!?])/g, "$1");
  return out.replace(/\s+/g, " ").trim();
}

// ── Cutting a reply into sentences ──────────────────────────────────────────────────────────────

/** Words whose full stop doesn't end a sentence ("Dr. Smith", "vs. Flask"). */
const ABBREVIATIONS = new Set(
  ("dr mr mrs ms mx prof sr jr vs etc approx cf fig inc ltd corp dept univ est al st " +
    "jan feb mar apr jun jul aug sep sept oct nov dec").split(" "),
);
/** "e.g", "i.e", "a.m", "U.S", "M.S", "Ph.D": letters joined by full stops. */
const DOTTED = /^(?:\p{L}{1,2}\.)+\p{L}{1,2}$/u;

/**
 * Whether the full stop, "!" or "?" at `at` (the end of `punctuation`) ends a sentence. Wrongly
 * joining two sentences only makes one voiced piece longer; wrongly splitting one makes the voice
 * stop mid-thought, so when it's unclear this says no.
 */
function endsSentence(paragraph: string, at: number, punctuation: string, next: string): boolean {
  if (/\.{2,}|…/.test(punctuation)) return false;
  if (punctuation !== ".") return true;
  const word = paragraph.slice(paragraph.lastIndexOf(" ", at - 2) + 1, at - 1).replace(/^[^\p{L}\p{N}]+/u, "");
  if (ABBREVIATIONS.has(word.toLowerCase()) || DOTTED.test(word)) return false;
  // Sentences start with a capital: "M.S. in Computer Science", "etc. and more" go on.
  return !/\p{Ll}/u.test(next);
}

/** A sentence over the limit, cut at the last ";", else ",", else space that leaves a piece within it. */
function cutLong(sentence: string): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE + 1);
    // Not too early: a cut in the first quarter would leave a scrap and a still-long remainder.
    const floor = MAX_SENTENCE / 4;
    const lastCut = (pattern: RegExp, keepMark: number) => {
      let best = -1;
      for (const m of window.matchAll(pattern)) if (m.index >= floor) best = m.index + keepMark;
      return best;
    };
    const cut = [lastCut(/;\s/g, 1), lastCut(/,\s/g, 1), lastCut(/\s/g, 0)].find((c) => c > 0) ?? MAX_SENTENCE;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/**
 * A reply as the sentences to voice, in order. Splits after ".", "!" or "?" and a space, but not
 * inside abbreviations (U.S., e.g., Dr.), numbers and versions (3.8, Python 3.6), names with a dot
 * (Node.js, merlinyang.com) or ellipses, and never leaves a piece over 600 characters.
 */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const paragraph = raw.replace(/\s+/g, " ").trim();
    if (!paragraph) continue;
    const found: string[] = [];
    let start = 0;
    for (const m of paragraph.matchAll(/([.!?…]+)(["'”’)\]]*)\s+/g)) {
      const end = m.index + m[1].length + m[2].length;
      if (endsSentence(paragraph, m.index + m[1].length, m[1], paragraph[m.index + m[0].length])) {
        found.push(paragraph.slice(start, end));
        start = m.index + m[0].length;
      }
    }
    found.push(paragraph.slice(start));
    for (const piece of found.map((p) => p.trim()).filter(Boolean)) {
      // A scrap with no words in it ("...", "?!") rides with the sentence before it rather than being voiced.
      if (!/[\p{L}\p{N}]/u.test(piece)) {
        if (out.length) out[out.length - 1] += ` ${piece}`;
        continue;
      }
      out.push(...cutLong(piece));
    }
  }
  return out.flatMap((s) => (s.length > MAX_SENTENCE ? cutLong(s) : [s]));
}

// ── Your own links ──────────────────────────────────────────────────────────────────────────────

/**
 * The link prefixes a reply may keep: your LinkedIn and GitHub (content/about.md), every project's
 * links (content/projects/*.md, content/earlier-projects.yaml), and your own sites. Passed to
 * cleanReply().
 */
export async function allowedLinks(contentDir: string): Promise<string[]> {
  const urls = new Set<string>();
  const add = (url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) urls.add(url.trim());
  };
  const addAll = (links: unknown) => {
    if (Array.isArray(links)) for (const link of links) add(link?.url);
  };

  const { data: about } = splitFrontmatter(await readFile(join(contentDir, "about.md"), "utf8"));
  add(about.contact?.linkedin);
  add(about.contact?.github);

  const projects = join(contentDir, "projects");
  if (existsSync(projects)) {
    for (const file of (await readdir(projects)).filter((f) => f.endsWith(".md")).sort()) {
      addAll(splitFrontmatter(await readFile(join(projects, file), "utf8")).data.links);
    }
  }
  const earlier = join(contentDir, "earlier-projects.yaml");
  if (existsSync(earlier)) {
    for (const project of (parse(await readFile(earlier, "utf8")) as { links?: unknown }[] | null) ?? []) addAll(project?.links);
  }

  add("https://merlinyang.com");
  add("https://*.merlinyang.com");
  return [...urls];
}

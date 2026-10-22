/**
 * Your voice for the chat (plan §6.1, §7.1 step 9): one sentence in, audio and lip timing out,
 * from the model server's POST /speak (services/models/server.py).
 *
 * Texts that never change (approved answers and the pre-written replies) are kept on disk after
 * the first time, so they play at once. The cache is keyed by the text alone: after changing the
 * voice or services/models/pronunciations.json, delete knowledge/cache/voice/ so they're voiced again.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Visemes, Words } from "@portfolio/shared/chat";
import type { ChatDeps, Spoken } from "./types.ts";

export interface SpeakerOptions {
  /** The model server, e.g. http://127.0.0.1:8790. */
  modelsUrl: string;
  /** Where cached sentences live (knowledge/cache/voice). */
  cacheDir: string;
  /** How long to wait for one sentence before giving up and showing it as text only. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readWords(value: unknown): Words | null {
  if (!Array.isArray(value)) return null;
  const words: Words = [];
  for (const w of value) {
    if (!w || typeof w.text !== "string" || !isNumber(w.start) || !isNumber(w.end)) return null;
    words.push({ text: w.text, start: w.start, end: w.end });
  }
  return words;
}

function readVisemes(value: unknown): Visemes | null {
  if (!Array.isArray(value)) return null;
  const shapes: Visemes = [];
  for (const v of value) {
    if (!Array.isArray(v) || v.length !== 2 || !isNumber(v[0]) || typeof v[1] !== "string") return null;
    shapes.push([v[0], v[1]]);
  }
  return shapes;
}

/** The model server's answer (or a cache file) as a Spoken, or null if it isn't usable audio. */
function toSpoken(text: string, body: unknown): Spoken | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.audio !== "string" || !b.audio || !isNumber(b.duration)) return null;
  return { text, audio: b.audio, duration: b.duration, words: readWords(b.words), visemes: readVisemes(b.visemes) };
}

export function makeSpeaker(options: SpeakerOptions): ChatDeps["speak"] {
  const { modelsUrl, cacheDir, timeoutMs, fetchImpl = fetch, log = console.log } = options;
  /** Cached texts being voiced right now, so two replies needing the same one wait for a single call. */
  const pending = new Map<string, Promise<Spoken | null>>();

  async function voice(text: string): Promise<Spoken | null> {
    try {
      const res = await fetchImpl(`${modelsUrl}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        log(`voice: the model server answered ${res.status}`);
        return null;
      }
      const spoken = toSpoken(text, await res.json());
      if (!spoken) log("voice: the model server's answer had no audio");
      return spoken;
    } catch (err) {
      log(`voice: couldn't reach the model server (${err instanceof Error ? err.name : "error"})`);
      return null;
    }
  }

  async function cached(text: string): Promise<Spoken | null> {
    const file = `${cacheDir}/${createHash("sha256").update(text).digest("hex")}.json`;
    try {
      const hit = toSpoken(text, JSON.parse(await readFile(file, "utf8")));
      if (hit) return hit;
    } catch {
      // Not cached yet (or the file is unreadable): voice it.
    }
    const spoken = await voice(text);
    // Without lip timing the aligner failed on this sentence; don't keep that result for good.
    if (spoken?.words && spoken.visemes) {
      try {
        await mkdir(cacheDir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(spoken));
        await rename(temp, file);
      } catch (err) {
        log(`voice: couldn't save to the cache (${err instanceof Error ? err.name : "error"})`);
      }
    }
    return spoken;
  }

  return (text, opts) => {
    if (!opts?.cache) return voice(text);
    let running = pending.get(text);
    if (!running) {
      running = cached(text).finally(() => pending.delete(text));
      pending.set(text, running);
    }
    return running;
  };
}

/** Lets only `max` things run at once; the rest wait their turn, in order (plan §7.7: 3 replies voiced at once). */
export interface Semaphore {
  /**
   * Waits for a free place and returns the function that gives it back. Rejects if `signal` aborts
   * while waiting (a visitor who left shouldn't keep a place in line).
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
}

export function makeSemaphore(max: number): Semaphore {
  let free = max;
  const waiting: (() => void)[] = [];

  function give(): void {
    const next = waiting.shift();
    if (next) next();
    else free++;
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new Error("aborted"));
      const take = () => {
        let given = false;
        return () => {
          if (!given) {
            given = true;
            give();
          }
        };
      };
      if (free > 0) {
        free--;
        return Promise.resolve(take());
      }
      return new Promise((resolve, reject) => {
        const turn = () => {
          signal?.removeEventListener("abort", leave);
          resolve(take());
        };
        const leave = () => {
          const at = waiting.indexOf(turn);
          if (at >= 0) waiting.splice(at, 1);
          reject(new Error("aborted"));
        };
        waiting.push(turn);
        signal?.addEventListener("abort", leave, { once: true });
      });
    },
  };
}

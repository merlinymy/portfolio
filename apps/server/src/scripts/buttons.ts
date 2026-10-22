/**
 * npm run buttons: voices the chat's question buttons (knowledge/buttons.yaml) ahead of time.
 *
 *   npm run buttons -- review   voices every version, approved or not, and writes a page to listen
 *                               to them on: knowledge/voice/buttons/index.html (private)
 *   npm run buttons -- voice    voices only the approved versions, so the api plays them at once
 *
 * Each sentence is voiced by the model server (npm run voice) and kept in the api's voice cache
 * (knowledge/cache/voice/), the same cache the api reads when a button is clicked; a sentence
 * already there isn't voiced again. Approving a version is setting `approved: true` for it in
 * knowledge/buttons.yaml after listening.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadButtons, type Button } from "../chat/buttons.ts";
import { sentences } from "../chat/clean.ts";
import { loadFixed } from "../chat/fixed.ts";
import type { Spoken } from "../chat/types.ts";
import { makeSpeaker } from "../chat/voice.ts";
import { ROOT, setting } from "../env.ts";

const command = process.argv[2];
if (command !== "review" && command !== "voice") {
  console.error("Use: npm run buttons -- review   (or: voice)");
  process.exit(1);
}

const knowledge = `${ROOT}knowledge`;
const buttons = await loadButtons(knowledge, await loadFixed(knowledge, `${ROOT}content`));
const speak = makeSpeaker({
  modelsUrl: setting("MODELS_URL", "http://127.0.0.1:8790"),
  cacheDir: `${knowledge}/cache/voice`,
  timeoutMs: 60_000,
  log: (line) => console.log(`  ${line}`),
});

/** The sentences of one version, voiced in order; null if any failed. */
async function voiceVersion(text: string): Promise<Spoken[] | null> {
  const out: Spoken[] = [];
  for (const sentence of sentences(text)) {
    const spoken = await speak(sentence, { cache: true });
    if (!spoken) return null;
    out.push(spoken);
  }
  return out;
}

/** The PCM samples of a WAV file, and its sample rate. */
function pcmOf(wav: Buffer): { rate: number; data: Buffer } {
  let at = 12;
  let rate = 24_000;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(at + 12);
    if (id === "data") return { rate, data: wav.subarray(at + 8, at + 8 + size) };
    at += 8 + size + (size % 2);
  }
  throw new Error("not a WAV file");
}

/** One WAV of the whole version, with the short pause the page leaves between sentences. */
function joined(parts: Spoken[]): Buffer {
  const pcm = parts.map((p) => pcmOf(Buffer.from(p.audio, "base64")));
  const rate = pcm[0].rate;
  const gap = Buffer.alloc(Math.round(rate * 0.15) * 2);
  const data = Buffer.concat(pcm.flatMap((p, i) => (i ? [gap, p.data] : [p.data])));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const outDir = `${knowledge}/voice/buttons`;
const sections: string[] = [];
let failed = 0;
const started = performance.now();

for (const button of buttons as Button[]) {
  const drafts = command === "voice" ? button.drafts.filter((d) => d.approved) : button.drafts;
  console.log(`${button.id}: ${drafts.length} version${drafts.length === 1 ? "" : "s"}`);
  const rows: string[] = [];
  for (const [n, draft] of drafts.entries()) {
    const spoken = await voiceVersion(draft.text);
    if (!spoken) {
      failed++;
      console.log(`  version ${n + 1}: voicing failed`);
      rows.push(`<li><p class="failed">Version ${n + 1}: voicing failed. Is npm run voice running?</p><p>${escape(draft.text)}</p></li>`);
      continue;
    }
    const seconds = spoken.reduce((s, p) => s + p.duration, 0) + 0.15 * (spoken.length - 1);
    const words = draft.text.split(/\s+/).length;
    console.log(`  version ${n + 1}: ${seconds.toFixed(1)} s, ${words} words${draft.approved ? ", approved" : ""}`);
    if (command === "review") {
      const name = `${button.id}-${n + 1}.wav`;
      await mkdir(outDir, { recursive: true });
      await writeFile(`${outDir}/${name}`, joined(spoken));
      rows.push(
        `<li><h3>Version ${n + 1} <span class="${draft.approved ? "yes" : "no"}">${draft.approved ? "approved" : "not approved yet"}</span> ` +
          `<small>${seconds.toFixed(0)} s, ${words} words</small></h3>` +
          `<audio controls preload="none" src="${name}"></audio><p>${escape(draft.text)}</p></li>`,
      );
    }
  }
  sections.push(`<section><h2>${escape(button.question)}</h2><ol>${rows.join("")}</ol></section>`);
}

if (command === "review") {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Question buttons</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; background: #fff; }
  h2 { margin-top: 2.5rem; } h3 { font-size: 1rem; margin: 1.5rem 0 .4rem; }
  small { color: #6e6e73; font-weight: normal; } audio { width: 100%; }
  .yes { color: #1a7f37; } .no { color: #b35900; } .failed { color: #c00; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #111; } small { color: #a1a1a6; } }
</style></head><body>
<h1>Question buttons</h1>
<p>Each version as a click would play it, in your voice. To approve one, set <code>approved: true</code> for it in
<code>knowledge/buttons.yaml</code>. Only approved versions are ever played; repeat clicks go through them in order.</p>
${sections.join("\n")}
</body></html>
`;
  await writeFile(`${outDir}/index.html`, page);
  console.log(`\nListen at: file://${outDir}/index.html`);
}
console.log(`${((performance.now() - started) / 1000).toFixed(0)} s${failed ? `; ${failed} version(s) failed to voice` : ""}`);
if (failed) process.exit(1);

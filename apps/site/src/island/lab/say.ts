/**
 * The lab's "Say" box: the face speaks a sentence in your cloned voice, with its lips timed to the
 * words (phase 3's model server, tried out before the chat exists).
 *
 * It only appears with `npm run dev`. The dev server passes /models/* to the model server on this
 * Mac (astro.config.mjs), which must be running: `npm run voice`. The public site never reaches the
 * model server, since it would say anything it's given in your voice (plan §3.2).
 */
import { button, useControls } from "leva";
import { control } from "../face/settings";
import { speech, type Voiced } from "../face/speech";

const FIRST_LINE = "Hi, I'm Merlin. I build AI tools for experts outside tech, and I care most about whether the answers are actually right.";
const NOT_RUNNING = "The voice isn't running. Start it with `npm run voice`, wait a few seconds, then try again.";

/** Splits where a sentence ends, the way the chat will send a reply to the voice. */
function sentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function voice(text: string): Promise<Voiced> {
  let response: Response;
  try {
    response = await fetch("/models/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  if (response.status === 400) throw new Error((await response.json()).detail);
  if (response.status === 503) throw new Error("The voice is still loading. Try again in a few seconds.");
  if (!response.ok) throw new Error(NOT_RUNNING);
  return response.json();
}

/** Adds the "Say" folder to the lab. Called only in development (see Lab.tsx). */
export function useSay() {
  const draft = { text: FIRST_LINE };
  const [, set] = useControls("Say", () => ({
    sentence: {
      value: FIRST_LINE,
      rows: 4,
      onChange: (v: string) => {
        draft.text = v;
      },
    },
    say: button(() => {
      // Sound must be allowed inside the click itself, before any waiting (iPhones insist).
      speech.unlock();
      speech.stop();
      void say(draft.text);
    }),
    status: { value: "Type a sentence, then press say.", editable: false },
  }));

  async function say(text: string) {
    const parts = sentences(text);
    if (!parts.length) return;
    control.setState("speaking");
    const playing: Promise<void>[] = [];
    try {
      // Each sentence plays as soon as it's voiced, while the next is being voiced: the chat's order.
      for (const [i, part] of parts.entries()) {
        const asked = performance.now();
        const voiced = await voice(part);
        const ready = Math.round(performance.now() - asked);
        const timing = voiced.visemes ? "" : " (no lip timing: fake mouth movement)";
        set({ status: `Sentence ${i + 1} of ${parts.length}: ${voiced.duration.toFixed(1)} s of speech, ready in ${ready} ms${timing}` });
        playing.push(speech.enqueue(voiced));
      }
    } catch (error) {
      set({ status: error instanceof Error ? error.message : String(error) });
    } finally {
      // Whatever was voiced still plays to the end before the face goes back to idle.
      await Promise.all(playing);
      if (control.state === "speaking") control.setState("idle");
    }
  }
}

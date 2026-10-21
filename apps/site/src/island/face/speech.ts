/**
 * Plays your voiced sentences and tells the face which mouth shape goes with this moment of the
 * audio (plan §6.2). Each sentence comes from the model server (services/models/server.py) as WAV
 * audio plus a timeline of mouth shapes.
 *
 * The timeline is read against the audio's own clock, not a timer, so the lips can't drift from the
 * sound. Sentences queue up and play back to back, as a reply's sentences will arrive one by one.
 */

/** One sentence as the model server returns it. */
export interface Voiced {
  text: string;
  duration: number;
  /** Each on-screen word with its start and end in seconds; null if the aligner failed. */
  words: { text: string; start: number; end: number }[] | null;
  /** [seconds, shape] pairs; each shape holds until the next. Null if the aligner failed. */
  visemes: [number, string][] | null;
  /** The WAV file, base64. */
  audio: string;
}

interface Segment {
  start: number;
  end: number;
  visemes: [number, string][];
}

/** The pause between queued sentences, in seconds. */
const GAP = 0.12;
/** Audio scheduled this far ahead starts cleanly instead of clipping its first moment. */
const LEAD_IN = 0.05;

export class SpeechPlayer {
  private context: AudioContext | null = null;
  private segments: Segment[] = [];
  private sources: AudioBufferSourceNode[] = [];

  /**
   * Browsers only allow sound after a click or tap, and iPhones only if the audio starts inside
   * that same event, so call this first thing in the click handler, before any waiting.
   */
  unlock() {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  /** Queues a sentence after any still playing. Resolves when it has finished playing. */
  async enqueue(sentence: Voiced): Promise<void> {
    this.unlock();
    const context = this.context!;
    const bytes = Uint8Array.from(atob(sentence.audio), (c) => c.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    const last = this.segments.at(-1);
    const start = Math.max(context.currentTime + LEAD_IN, last ? last.end + GAP : 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(start);
    this.sources.push(source);
    this.segments.push({ start, end: start + buffer.duration, visemes: sentence.visemes ?? [] });
    return new Promise((resolve) => {
      source.onended = () => {
        this.sources = this.sources.filter((s) => s !== source);
        resolve();
      };
    });
  }

  /** Whether any queued sentence is still to play. */
  get speaking() {
    const last = this.segments.at(-1);
    return !!this.context && !!last && this.context.currentTime < last.end;
  }

  /**
   * The mouth shape for this moment, looked up `lead` seconds ahead because a mouth forms a shape
   * just before the sound comes out. "sil" in the pauses. Null when nothing is playing, or when the
   * aligner couldn't time this sentence, so the face falls back to its fake speech.
   */
  viseme(lead: number): string | null {
    if (!this.speaking) return null;
    const t = this.context!.currentTime + lead;
    const segment = this.segments.find((s) => t >= s.start && t < s.end);
    if (!segment) return "sil";
    if (!segment.visemes.length) return null;
    const at = t - segment.start;
    let shape = "sil";
    for (const [time, name] of segment.visemes) {
      if (time > at) break;
      shape = name;
    }
    return shape;
  }

  stop() {
    for (const source of this.sources) source.stop();
    this.sources = [];
    this.segments = [];
  }
}

/** The page's one player: the lab's "Say" box now, the chat in phase 6. */
export const speech = new SpeechPlayer();

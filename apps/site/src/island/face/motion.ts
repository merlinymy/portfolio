/**
 * Motion layers that don't need three.js (plan §5.4): clip playback, gaze, lip-sync and
 * expression mixing. Each writes into plain arrays the render loop owns.
 */
import type { Clip, FaceData, GazePose, Target } from "./data";

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Moves `current` toward `target`, covering about 63% of the gap every `tau` seconds. */
export function approach(current: number, target: number, dt: number, tau: number): number {
  return tau <= 0 ? target : target + (current - target) * Math.exp(-dt / tau);
}

/** One sample of a clip: slider values, head angles (x, y, z) and eye angles (left xyz, right xyz). */
export class Pose {
  readonly weights: Float32Array;
  readonly head = new Float32Array(3);
  readonly eyes = new Float32Array(6);
  constructor(sliders: number) {
    this.weights = new Float32Array(sliders);
  }
  blendToward(other: Pose, t: number) {
    for (let i = 0; i < this.weights.length; i++) this.weights[i] = lerp(this.weights[i], other.weights[i], t);
    for (let i = 0; i < 3; i++) this.head[i] = lerp(this.head[i], other.head[i], t);
    for (let i = 0; i < 6; i++) this.eyes[i] = lerp(this.eyes[i], other.eyes[i], t);
  }
}

/** Plays a clip on a loop, crossfading its end into its start so the loop point doesn't jump. */
export class ClipPlayer {
  private readonly scratch: Pose;
  private readonly duration: number;
  private readonly fade: number;
  constructor(
    readonly clip: Clip,
    fadeSeconds = 0.8,
  ) {
    const sliders = clip.weights.length / clip.frames;
    this.scratch = new Pose(sliders);
    this.duration = (clip.frames - 1) / clip.fps;
    this.fade = Math.min(fadeSeconds, this.duration / 3);
  }

  /** Writes the pose `t` seconds after the clip started playing. */
  sample(t: number, out: Pose) {
    const { duration: d, fade: f } = this;
    const s = f + (t % (d - f));
    this.raw(s, out);
    if (s > d - f) {
      this.raw(s - (d - f), this.scratch);
      out.blendToward(this.scratch, smooth((s - (d - f)) / f));
    }
  }

  private raw(seconds: number, out: Pose) {
    const { clip } = this;
    const sliders = out.weights.length;
    const position = clamp(seconds * clip.fps, 0, clip.frames - 1);
    const i = Math.floor(position);
    const j = Math.min(i + 1, clip.frames - 1);
    const a = position - i;
    for (let s = 0; s < sliders; s++) {
      out.weights[s] = lerp(clip.weights[i * sliders + s], clip.weights[j * sliders + s], a) * clip.weightScale;
    }
    for (let k = 0; k < 3; k++) out.head[k] = lerp(clip.head[i * 3 + k], clip.head[j * 3 + k], a) * clip.angleScale;
    for (let k = 0; k < 6; k++) out.eyes[k] = lerp(clip.eyes[i * 6 + k], clip.eyes[j * 6 + k], a) * clip.angleScale;
  }
}

/** Crossfades from one clip to the next when the face state changes. */
export class ClipBlend {
  private current: { player: ClipPlayer; start: number } | undefined;
  private previous: { player: ClipPlayer; start: number } | undefined;
  private fadeStart = 0;
  private readonly other: Pose;
  constructor(
    sliders: number,
    private readonly fadeSeconds = 0.6,
  ) {
    this.other = new Pose(sliders);
  }

  play(player: ClipPlayer, now: number) {
    if (this.current?.player === player) return;
    this.previous = this.current;
    this.current = { player, start: now };
    this.fadeStart = now;
  }

  sample(now: number, out: Pose) {
    if (!this.current) return;
    this.current.player.sample(now - this.current.start, out);
    const k = (now - this.fadeStart) / this.fadeSeconds;
    if (this.previous && k < 1) {
      this.previous.player.sample(now - this.previous.start, this.other);
      this.other.blendToward(out, smooth(k));
      out.weights.set(this.other.weights);
      out.head.set(this.other.head);
      out.eyes.set(this.other.eyes);
    } else {
      this.previous = undefined;
    }
  }
}

const average = (a: number, b: number) => (a + b) / 2;

/**
 * Turns a look direction into eye angles and eyelid sliders, within the range captured by the
 * app's eye-range step (gaze.json). Sides are told apart by where the eyes actually pointed
 * (`lookAt`), not by the pose labels, since people often mirror a "look left" prompt.
 */
export class Gaze {
  private readonly center: GazePose;
  private readonly plusX: GazePose;
  private readonly minusX: GazePose;
  private readonly up: GazePose;
  private readonly down: GazePose;
  /** Eye angles (radians) of the extreme looks, measured from the center look. */
  readonly range: { plusX: number; minusX: number; up: number; down: number };
  /** eyeLook… sliders, which the look replaces; other eye sliders (blink, squint, wide) get an offset. */
  private readonly lookSliders: number[] = [];
  private readonly lidSliders: number[] = [];

  constructor(data: FaceData) {
    const { gaze, names } = data;
    this.center = gaze.center;
    [this.minusX, this.plusX] = [gaze.left, gaze.right].sort((a, b) => a.lookAt[0] - b.lookAt[0]);
    [this.down, this.up] = [gaze.up, gaze.down].sort((a, b) => a.lookAt[1] - b.lookAt[1]);
    const yaw = (p: GazePose) => average(p.eyes[1], p.eyes[4]) - average(this.center.eyes[1], this.center.eyes[4]);
    const pitch = (p: GazePose) => average(p.eyes[0], p.eyes[3]) - average(this.center.eyes[0], this.center.eyes[3]);
    // A positive x rotation tips the eyes down, so looking up has a negative pitch.
    this.range = { plusX: yaw(this.plusX), minusX: -yaw(this.minusX), up: -pitch(this.up), down: pitch(this.down) };
    names.forEach((name, i) => {
      if (name.startsWith("eyeLook")) this.lookSliders.push(i);
      else if (name.startsWith("eye")) this.lidSliders.push(i);
    });
  }

  /** The largest look the captured range allows, for clamping requests. */
  limit(yaw: number, pitchUp: number): [number, number] {
    return [clamp(yaw, -this.range.minusX, this.range.plusX), clamp(pitchUp, -this.range.down, this.range.up)];
  }

  /**
   * Applies a look of `yaw` (positive toward +x, the viewer's right) and `pitchUp` (positive up),
   * in radians relative to the head, with `amount` 0–1 blending it over the clip's own eyes.
   */
  apply(yaw: number, pitchUp: number, amount: number, pose: Pose) {
    if (amount <= 0) return;
    const h = yaw >= 0 ? clamp(yaw / this.range.plusX, 0, 1) : clamp(-yaw / this.range.minusX, 0, 1);
    const v = pitchUp >= 0 ? clamp(pitchUp / this.range.up, 0, 1) : clamp(-pitchUp / this.range.down, 0, 1);
    const side = yaw >= 0 ? this.plusX : this.minusX;
    const vertical = pitchUp >= 0 ? this.up : this.down;
    const c = this.center;
    const offset = (s: number) => h * (side.weights[s] - c.weights[s]) + v * (vertical.weights[s] - c.weights[s]);
    for (const s of this.lookSliders) {
      pose.weights[s] = lerp(pose.weights[s], clamp(c.weights[s] + offset(s), 0, 1), amount);
    }
    for (const s of this.lidSliders) {
      pose.weights[s] = clamp(pose.weights[s] + amount * offset(s), 0, 1);
    }
    for (let k = 0; k < 6; k++) {
      const look = c.eyes[k] + h * (side.eyes[k] - c.eyes[k]) + v * (vertical.eyes[k] - c.eyes[k]);
      pose.eyes[k] = lerp(pose.eyes[k], look, amount);
    }
  }
}

const MOUTH = /^(jaw|mouth|cheekPuff|tongueOut)/;

/** Mouth and jaw sliders from a mouth-shape (viseme) target, eased so shapes flow into each other. */
export class LipSync {
  readonly mouthSliders: number[] = [];
  private readonly rest: number[];
  private readonly target: Float32Array;
  private readonly current: Float32Array;
  private readonly jaw: number;

  constructor(private readonly data: FaceData) {
    data.names.forEach((name, i) => {
      if (MOUTH.test(name)) this.mouthSliders.push(i);
    });
    this.jaw = data.names.indexOf("jawOpen");
    this.rest = data.visemes.sil;
    this.target = new Float32Array(data.names.length);
    this.current = new Float32Array(data.names.length);
    this.target.set(this.rest);
    this.current.set(this.rest);
  }

  setViseme(id: string) {
    this.target.set(this.data.visemes[id] ?? this.rest);
  }

  /** How far the jaw is open beyond rest, 0–1: a stand-in for loudness until real audio drives it. */
  get openness() {
    return clamp((this.current[this.jaw] - this.rest[this.jaw]) * 3, 0, 1);
  }

  update(dt: number) {
    for (const s of this.mouthSliders) this.current[s] = approach(this.current[s], this.target[s], dt, 0.045);
  }

  /** Blends the mouth over the pose by `amount`, exaggerating each shape away from rest by `strength`. */
  apply(pose: Pose, amount: number, strength: number) {
    if (amount <= 0) return;
    for (const s of this.mouthSliders) {
      const shaped = clamp(this.rest[s] + (this.current[s] - this.rest[s]) * strength, 0, 1);
      pose.weights[s] = lerp(pose.weights[s], shaped, amount);
    }
  }
}

/** Random speech-like mouth shapes with pauses, standing in for real replies until phase 6. */
export class Babbler {
  private next = 0;
  private phraseEnd = 0;
  private static readonly SHAPES = ["aa", "E", "ih", "oh", "ou", "PP", "FF", "DD", "kk", "SS", "nn", "RR", "CH", "TH"];

  /** Returns the mouth shape to show at `now`, or undefined to keep the current one. */
  update(now: number): string | undefined {
    if (now < this.next) return undefined;
    if (now > this.phraseEnd) {
      // Between phrases: rest for a moment, then speak for one to three seconds.
      const pause = 0.25 + Math.random() * 0.35;
      this.next = now + pause;
      this.phraseEnd = this.next + 1 + Math.random() * 2;
      return "sil";
    }
    this.next = now + 0.07 + Math.random() * 0.1;
    return Babbler.SHAPES[Math.floor(Math.random() * Babbler.SHAPES.length)];
  }
}

/** Adds the weighted expression offsets onto the neutral face, writing x, y, z per vertex. */
export function mixExpressions(base: Float32Array, targets: Target[], weights: Float32Array, out: Float32Array) {
  out.set(base);
  for (let s = 0; s < targets.length; s++) {
    const w = weights[s];
    if (w < 0.002) continue;
    const { indices, deltas } = targets[s];
    for (let k = 0; k < indices.length; k++) {
      const v = indices[k] * 3;
      out[v] += deltas[k * 3] * w;
      out[v + 1] += deltas[k * 3 + 1] * w;
      out[v + 2] += deltas[k * 3 + 2] * w;
    }
  }
}

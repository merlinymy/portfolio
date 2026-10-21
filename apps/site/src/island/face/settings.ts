/**
 * The face's tunable settings, the effect catalog and the face states (plan §5.6, §5.7).
 *
 * `settings` and `control` are plain mutable objects: the render loop reads them every frame and
 * the ?lab panel writes them, so tweaking never re-renders React. The defaults live in
 * settings.json; the lab's "Export settings" button copies a replacement for that file.
 */
import type { ClipName } from "./data";
import defaults from "./settings.json";

export const EFFECTS = {
  wind: "Wind / drift",
  ripple: "Ripple on click",
  sweep: "Wave sweep",
  pulse: "Voice pulse",
  glitch: "Glitch",
  dust: "Dust dissolve",
  breathing: "Breathing",
  scanline: "Scanline",
  magnet: "Pointer magnet",
  depthFade: "Depth fade",
  shimmer: "Edge shimmer",
  twinkle: "Twinkle",
  assemble: "Assemble intro",
  stateColor: "State color",
} as const;
export type EffectName = keyof typeof EFFECTS;

/** "auto" follows the face state; "on" and "off" override it, for trying effects in the lab. */
export type EffectMode = "auto" | "on" | "off";

export const FACE_STATES = [
  "sleeping",
  "idle",
  "listening",
  "panel",
  "thinking",
  "speaking",
  "strike",
  "locked",
] as const;
export type FaceState = (typeof FACE_STATES)[number];

interface StateInfo {
  clip: ClipName;
  /** Effects this state turns on when their mode is "auto". */
  effects: EffectName[];
  /** How strongly the face follows the pointer or tilt, 0–1. */
  follow: number;
}

/** Effects that are on in every state when "auto". Ripple stops when locked. */
export const ALWAYS_ON: EffectName[] = ["depthFade", "stateColor", "assemble", "ripple"];

export const STATES: Record<FaceState, StateInfo> = {
  sleeping: { clip: "sleeping", effects: ["breathing"], follow: 0 },
  idle: { clip: "idle", effects: ["wind"], follow: 1 },
  listening: { clip: "listening", effects: ["wind"], follow: 1 },
  panel: { clip: "idle", effects: ["wind"], follow: 1 },
  thinking: { clip: "thinking", effects: ["sweep", "wind"], follow: 0.3 },
  speaking: { clip: "talking", effects: ["pulse", "wind"], follow: 0.7 },
  strike: { clip: "idle", effects: ["glitch"], follow: 0.5 },
  locked: { clip: "sleeping", effects: ["dust"], follow: 0 },
};

/** How long the strike state shows before the face returns to the previous state, in seconds. */
export const STRIKE_SECONDS = 1.6;

export interface EffectSettings {
  mode: EffectMode;
  strength: number;
  speed: number;
}

export interface Settings {
  look: {
    pointSize: number;
    pointOpacity: number;
    lineOpacity: number;
    eyeOpacity: number;
    /** Eye-ring points relative to face points, so the eyes read clearly. */
    eyeSize: number;
    eyeGlow: number;
    baseColor: string;
  };
  motion: {
    /** Degrees the face would turn for a pointer at the edge of the window. */
    reach: number;
    headYaw: number;
    headPitch: number;
    /** Share of a look the head turns; the eyes turn the rest. */
    headShare: number;
    headSmoothing: number;
    eyeSmoothing: number;
    /** Scale of the clip's own head movement. */
    clipHead: number;
    /** Exaggerates the captured mouth shapes, measured from the resting mouth. */
    lipSync: number;
    /** Degrees of phone tilt for a full look. */
    tiltRange: number;
    tiltInvert: boolean;
  };
  states: Record<FaceState, { color: string; brightness: number }>;
  effects: Record<EffectName, EffectSettings>;
}

export const DEFAULT_SETTINGS = defaults as Settings;
export const settings: Settings = structuredClone(DEFAULT_SETTINGS);

/** Live requests from the page or the lab, read by the render loop. */
export const control = {
  state: "idle" as FaceState,
  /** The state to return to after a strike. */
  previous: "idle" as FaceState,
  /** Fake speech while speaking, until the real voice arrives (phase 6). */
  babble: true,
  /** Holds one mouth shape, for checking the captured shapes in the lab. "off" for none. */
  viseme: "off",
  /** Set to replay the assemble intro on the next frame. */
  replayIntro: false,

  setState(next: FaceState) {
    if (next === "strike" && this.state !== "strike") this.previous = this.state;
    this.state = next;
  },
};

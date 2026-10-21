/**
 * The face's tunable settings, the effect catalog and the face states (plan §5.6, §5.7).
 *
 * `settings` and `control` are plain mutable objects: the render loop reads them every frame and
 * the ?lab panel writes them, so tweaking never re-renders React. The defaults live in
 * settings.json; the lab's "Export settings" button copies a replacement for that file.
 */
import type { ClipName } from "./data";
import type { HairSettings } from "./hair";
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
  photoColor: "Photo color",
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
  /** How strongly the face follows the pointer or a finger, 0–1. */
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
    /** The area kept in view, in meters: it fits both the width and the height. */
    frameWidth: number;
    frameHeight: number;
    /** The height in face space the view centers on (the eyes are at about +0.03 m). */
    frameCenterY: number;
    /** Hide what's behind the face and head, instead of seeing through them. */
    occlude: boolean;
    /**
     * Realistic mode, 0–1: the face as a solid surface wrapped in the photo skin image, blended
     * over the points and edges. Only works where face-texture.jpg exists (on this Mac, plan §5.8).
     */
    realism: number;
    skinBrightness: number;
    /** Where the light comes from, in degrees: around (0 = straight ahead) and up. */
    lightAround: number;
    lightUp: number;
  };
  /** The fitted head, neck and shoulders (plan §5.8). */
  head: {
    show: boolean;
    /** Corrections to the size measured from the photo, above the ears and behind the face. */
    width: number;
    height: number;
    depth: number;
    pointOpacity: number;
    lineOpacity: number;
  };
  hair: HairSettings & {
    show: boolean;
    /** How far the ends sway in the wind. */
    sway: number;
    /** How much the ends trail behind when the head turns. */
    lag: number;
    opacity: number;
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
    /** Seconds the mouth moves ahead of your voice, since lips form a shape just before the sound. */
    lipLead: number;
  };
  /** How the six profile buttons move around the head on wide screens (plan §4.2). */
  buttons: {
    style: ButtonStyle;
    /** Distance from the face, 1 = just outside its outline. */
    spread: number;
    speed: number;
    bob: number;
  };
  states: Record<FaceState, { color: string; brightness: number }>;
  effects: Record<EffectName, EffectSettings>;
}

/**
 * "head": fixed to points around the head, so they turn with the face. "orbit": a slow circle
 * around it. "ring": still, with a gentle bob. With reduced motion the buttons always stay still.
 */
export const BUTTON_STYLES = ["head", "orbit", "ring"] as const;
export type ButtonStyle = (typeof BUTTON_STYLES)[number];

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
  /** Holds the neutral scanned face with no clip, for rendering the still image (tools/face/still.ts). */
  still: false,
  /** A point on screen (client pixels) the face looks at instead of the pointer: an open panel or a focused button. */
  attention: null as { x: number; y: number } | null,
  /** Width of a panel open on the right, in pixels; the face moves into the space beside it. */
  panelInset: 0,

  setState(next: FaceState) {
    if (next === "strike" && this.state !== "strike") this.previous = this.state;
    this.state = next;
  },
};

/**
 * Every adjustable value of every look (docs/face-looks-plan.md), with its range and a short note
 * on what it does. The lab builds its controls from these, and settings.json holds the chosen
 * values. This file has no three.js in it, because the page's settings load before the 3D code.
 */

export interface Param {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Shown when you hover the control in the lab. */
  hint: string;
}

export type ParamValues<T extends Record<string, Param>> = { [K in keyof T]: number };

/** "scan" is the original points and edges. */
export const LOOK_STYLES = ["scan", "flame"] as const;
export type LookStyle = (typeof LOOK_STYLES)[number];

export const FLAME = {
  quality: { value: 0.5, min: 0.25, max: 1, step: 0.05, label: "resolution", hint: "Share of the screen's resolution the fire is worked out at. Lower is blurrier and faster." },
  rise: { value: 0.32, min: 0, max: 1.2, step: 0.01, label: "rise speed", hint: "How fast the flames climb, in screen heights per second." },
  turbulence: { value: 0.22, min: 0, max: 1, step: 0.01, label: "swirl", hint: "How much the flames twist and wander as they rise." },
  swirlSize: { value: 3.2, min: 0.5, max: 10, step: 0.1, label: "swirl detail", hint: "Size of the swirls: higher makes smaller, busier twists." },
  swirlSpeed: { value: 1.1, min: 0, max: 4, step: 0.05, label: "swirl speed", hint: "How quickly the swirling pattern changes." },
  cooling: { value: 1.25, min: 0.2, max: 4, step: 0.05, label: "cooling", hint: "How fast flames die out as they rise. Higher gives shorter flames." },
  flicker: { value: 0.6, min: 0, max: 2, step: 0.05, label: "flicker", hint: "Random gaps that make the flames break up and flicker." },
  softness: { value: 1.2, min: 0, max: 4, step: 0.05, label: "softness", hint: "How much the flames blur into each other as they rise." },
  edgeHeat: { value: 1, min: 0, max: 2, step: 0.05, label: "edge heat", hint: "How strongly the face's outline, eyes and lips burn: the edges of the scan." },
  rimHeat: { value: 0.8, min: 0, max: 2, step: 0.05, label: "rim heat", hint: "How strongly the sides of the face burn, where the surface turns away from you." },
  featureHeat: { value: 0.9, min: 0, max: 2, step: 0.05, label: "feature heat", hint: "How strongly the parts that move most (brows, eyelids, lips) burn." },
  brightness: { value: 1.3, min: 0, max: 3, step: 0.05, label: "fire brightness", hint: "Overall brightness of the flames." },
  bloom: { value: 0.7, min: 0, max: 2, step: 0.05, label: "glow", hint: "Soft glow spreading around the fire." },
  haze: { value: 0.35, min: 0, max: 2, step: 0.05, label: "heat haze", hint: "Shimmer that wobbles the flames like hot air." },
  faceStrength: { value: 0.8, min: 0, max: 1, step: 0.01, label: "face strength", hint: "How much the flames hold back over the face, so it stays recognisable. 0 lets fire cover it." },
  emberGlow: { value: 1, min: 0, max: 3, step: 0.05, label: "ember cracks", hint: "Brightness of the glowing cracks in the charred face." },
  crackSize: { value: 7, min: 2, max: 20, step: 0.5, label: "crack detail", hint: "How fine the cracks are: higher is more, smaller cracks." },
  crackFlow: { value: 1, min: 0, max: 4, step: 0.05, label: "crack movement", hint: "How fast the cracks slowly shift and pulse." },
  faceLight: { value: 0.5, min: 0, max: 1.5, step: 0.01, label: "face light", hint: "A soft front light on the face, so its shape reads through the fire." },
  underLight: { value: 0.5, min: 0, max: 2, step: 0.05, label: "firelight from below", hint: "Orange light the flames throw up onto the face." },
  sparks: { value: 1, min: 0, max: 1, step: 0.01, label: "sparks", hint: "Share of the sparks that fly. 0 turns them off." },
  sparkSize: { value: 1.6, min: 0.2, max: 3, step: 0.05, label: "spark size", hint: "How big the sparks are." },
  sparkRise: { value: 1, min: 0, max: 3, step: 0.05, label: "spark rise", hint: "How fast and high the sparks float up." },
  sparkLife: { value: 2.2, min: 0.3, max: 6, step: 0.1, label: "spark life (s)", hint: "How many seconds a spark glows before it burns out." },
  sparkWander: { value: 1, min: 0, max: 4, step: 0.05, label: "spark wander", hint: "How much the sparks drift sideways on the air." },
  voiceFlare: { value: 0.8, min: 0, max: 4, step: 0.05, label: "voice flare", hint: "How much the fire flares up with your voice while speaking." },
  stateTint: { value: 0.45, min: 0, max: 1, step: 0.01, label: "state tint", hint: "How much the face state's color (State colors in the lab) tints the flames." },
  pointerStir: { value: 1, min: 0, max: 4, step: 0.05, label: "pointer stir", hint: "How much moving the pointer pushes the flames and sparks." },
  eyeGlow: { value: 2.2, min: 0, max: 5, step: 0.05, label: "ember eyes", hint: "Brightness of the glowing eye rings. 0 hides them." },
} as const satisfies Record<string, Param>;

export type FlameSettings = ParamValues<typeof FLAME>;

/** The starting values of a look's parameters. */
export function defaultsOf<T extends Record<string, Param>>(spec: T): ParamValues<T> {
  return Object.fromEntries(Object.entries(spec).map(([key, p]) => [key, p.value])) as ParamValues<T>;
}

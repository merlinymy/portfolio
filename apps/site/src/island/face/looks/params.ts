/**
 * Every adjustable value of every look (docs/face-looks-plan.md), with its range and a short note
 * on what it does. The lab builds its controls from these, and settings.json holds the chosen
 * values. This file has no three.js in it, because the page's settings load before the 3D code.
 */

export interface NumberParam {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** Shown when you hover the control in the lab. */
  hint: string;
}

/** A color, as "#rrggbb". */
export interface ColorParam {
  value: string;
  label: string;
  hint: string;
}

export type Param = NumberParam | ColorParam;

export type ParamValues<T extends Record<string, Param>> = { [K in keyof T]: T[K] extends ColorParam ? string : number };

/** "scan" is the original points and edges. */
export const LOOK_STYLES = ["scan", "flame", "ink"] as const;
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

export const INK = {
  // The portrait: where the ink gathers to draw your face
  quality: { value: 0.6, min: 0.25, max: 1, step: 0.05, label: "resolution", hint: "Share of the screen's resolution the ink is worked out at. Full keeps the finest wisps; lower is softer and faster." },
  inkColor: { value: "#ffffff", label: "ink color", hint: "The ink's color. White glows against the black water." },
  amount: { value: 0.9, min: 0, max: 3, step: 0.05, label: "ink amount", hint: "How much ink draws your face." },
  portrait: { value: 1, min: 0, max: 3, step: 0.05, label: "portrait", hint: "How much ink gathers where light falls on your face (forehead, nose, cheekbones, lips). The hollows stay dark water." },
  contrast: { value: 1.3, min: 0.3, max: 5, step: 0.05, label: "contrast", hint: "How sharply the lit parts stand out from the hollows. Higher leaves eye sockets and shadows emptier." },
  lightAbove: { value: 30, min: -60, max: 80, step: 1, label: "light from above (°)", hint: "How high the light that shapes the portrait is. Higher lights the brow and nose and darkens under them." },
  lightSide: { value: -8, min: -70, max: 70, step: 1, label: "light from the side (°)", hint: "How far to one side that light is. 0 is straight on; either side shades half the face." },
  features: { value: 0.9, min: 0, max: 2, step: 0.05, label: "eyes and lips", hint: "Extra ink around your eyes and lips, so they stay readable as the ink drifts." },
  liveliness: { value: 0.35, min: 0, max: 2, step: 0.05, label: "moving parts", hint: "Extra ink on the parts that move most: brows, eyelids, lips." },
  outlineFade: { value: 0.9, min: 0, max: 1, step: 0.01, label: "outline fade", hint: "How softly the face fades out toward its outline, so no mask edge shows." },
  grain: { value: 0.55, min: 0, max: 1, step: 0.01, label: "grain", hint: "Breaks the ink into uneven patches as it's laid down, so it looks dropped rather than painted." },
  thickness: { value: 0.8, min: 0.1, max: 4, step: 0.05, label: "thickness", hint: "How solid the ink looks. Low keeps it thin and see-through; overlapping wisps add up." },
  fade: { value: 5, min: 0.5, max: 20, step: 0.1, label: "fade time (s)", hint: "Seconds the ink takes to thin away into the water." },
  // Steady face or drops
  rhythm: { value: 0, min: 0, max: 1, step: 0.01, label: "rhythm", hint: "0: a steady face, always redrawn, with wisps drifting off it. 1: your face arrives as a drop of ink, blooms apart, then re-forms. In between mixes the two." },
  dropEvery: { value: 7, min: 1, max: 20, step: 0.5, label: "drop every (s)", hint: "Seconds between drops, when rhythm is above 0." },
  bloom: { value: 1, min: 0, max: 4, step: 0.05, label: "bloom", hint: "How hard each drop bursts outward as it blooms." },
  // How the water moves the ink
  swirl: { value: 1.2, min: 0, max: 4, step: 0.05, label: "swirl", hint: "How strongly the water curls the ink into eddies." },
  swirlSize: { value: 3, min: 0.5, max: 12, step: 0.1, label: "swirl detail", hint: "Size of the eddies: higher makes smaller, busier curls." },
  swirlSpeed: { value: 0.5, min: 0, max: 3, step: 0.05, label: "swirl speed", hint: "How quickly the currents change." },
  spread: { value: 0.025, min: 0, max: 0.3, step: 0.005, label: "spread", hint: "How fast the ink unfurls outward from the face, evenly in every direction." },
  drift: { value: 0, min: -0.3, max: 0.3, step: 0.005, label: "drift", hint: "An up or down current: above 0 the ink rises toward the surface, below 0 it sinks. 0 spreads evenly." },
  momentum: { value: 0.8, min: 0, max: 4, step: 0.05, label: "momentum (s)", hint: "How long a push (the pointer, a click, a drop, your voice) keeps the water moving." },
  sharpness: { value: 1, min: 0, max: 1, step: 0.01, label: "crispness", hint: "How crisp the fine wisps stay as they move. Lower lets them blur into haze." },
  softness: { value: 0.1, min: 0, max: 2, step: 0.05, label: "diffusion", hint: "How much the ink blurs into the water on its own, like ink slowly dissolving." },
  billow: { value: 0.7, min: 0, max: 4, step: 0.05, label: "billow", hint: "How rounded and lit from above the ink clouds look." },
  glow: { value: 0.6, min: 0, max: 2, step: 0.05, label: "glow", hint: "Soft glow around the ink." },
  waterSpread: { value: 0.62, min: 0.3, max: 3, step: 0.05, label: "water spread", hint: "How far the water reaches out from the face, in screen heights, before fading into the page. Larger fills the whole view." },
  // The surface, seen from below
  surfaceHeight: { value: 0.155, min: 0.06, max: 0.3, step: 0.005, label: "surface height (m)", hint: "How far above the face the water's surface is. Lower brings the shimmering band further down the view." },
  surfaceReach: { value: 0.55, min: 0.1, max: 2, step: 0.05, label: "surface reach (m)", hint: "How far back the surface stays visible before it fades into the dark." },
  waveSize: { value: 1.7, min: 0.2, max: 4, step: 0.05, label: "ripple size", hint: "Size of the ripples on the surface: higher is smaller, busier ripples." },
  waveSpeed: { value: 1, min: 0, max: 4, step: 0.05, label: "ripple speed", hint: "How fast the ripples move." },
  waveTilt: { value: 1, min: 0, max: 3, step: 0.05, label: "ripple depth", hint: "How steep the ripples are. Steeper ripples let more flickers of light through." },
  shimmer: { value: 0.6, min: 0, max: 3, step: 0.05, label: "shimmer", hint: "Brightness of the flickers of light coming through the surface." },
  mirror: { value: 0.8, min: 0, max: 2, step: 0.05, label: "mirror", hint: "How strongly the surface mirrors the ink below it. From underneath, water acts like a mirror at shallow angles." },
  // Light under water
  shafts: { value: 0.6, min: 0, max: 2, step: 0.05, label: "light shafts", hint: "Brightness of the slanted beams of light coming down from the surface." },
  shaftSpeed: { value: 0.6, min: 0, max: 3, step: 0.05, label: "shaft speed", hint: "How fast the light shafts sway." },
  caustics: { value: 0.6, min: 0, max: 3, step: 0.05, label: "caustics", hint: "Brightness of the moving net of light that the rippling surface casts on the ink." },
  causticSize: { value: 1, min: 0.2, max: 4, step: 0.05, label: "caustic size", hint: "Size of the caustic net: higher is a finer net." },
  causticSpeed: { value: 1, min: 0, max: 4, step: 0.05, label: "caustic speed", hint: "How fast the caustic net moves." },
  waterColor: { value: "#03070d", label: "deep water color", hint: "The color of the water far away. Near black, with a hint of blue." },
  lightColor: { value: "#cfe8ff", label: "light color", hint: "The color of the light coming through the surface." },
  specks: { value: 0.8, min: 0, max: 1, step: 0.01, label: "floating specks", hint: "Share of the tiny specks drifting in the water that catch the light. 0 turns them off." },
  speckSize: { value: 1, min: 0.2, max: 3, step: 0.05, label: "speck size", hint: "How big the floating specks are." },
  // Reactions
  puff: { value: 0.7, min: 0, max: 4, step: 0.05, label: "voice puff", hint: "How much ink your voice breathes out of the mouth while speaking." },
  pointerStir: { value: 1, min: 0, max: 4, step: 0.05, label: "pointer stir", hint: "How much moving the pointer stirs the water." },
  clickPush: { value: 1, min: 0, max: 4, step: 0.05, label: "click pulse", hint: "How hard a click pushes the ink outward from where it lands." },
  stateTint: { value: 0.6, min: 0, max: 1, step: 0.01, label: "state tint", hint: "How much the face state's color (State colors in the lab) tints the ink, for example red on a strike." },
  eyeGlow: { value: 0, min: 0, max: 5, step: 0.05, label: "eye rings", hint: "Brightness of the glowing eye rings over the ink. 0 hides them, leaving the ink to draw the eyes." },
} as const satisfies Record<string, Param>;

export type InkSettings = ParamValues<typeof INK>;

/** The starting values of a look's parameters. */
export function defaultsOf<T extends Record<string, Param>>(spec: T): ParamValues<T> {
  return Object.fromEntries(Object.entries(spec).map(([key, p]) => [key, p.value])) as ParamValues<T>;
}

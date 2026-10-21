/**
 * The effects lab (plan §5.6): open the site with ?lab for live controls over every effect, the
 * motion and the face states. Visitors never download this file or leva.
 *
 * Every control writes straight into `settings` or `control`, which the render loop reads each
 * frame. "Export settings" copies the current values as JSON to paste over
 * apps/site/src/island/face/settings.json, which makes them the new defaults.
 */
import { Leva, button, buttonGroup, folder, useControls } from "leva";
import type { FaceData } from "../face/data";
import {
  BUTTON_STYLES,
  EFFECTS,
  FACE_STATES,
  control,
  settings,
  type ButtonStyle,
  type EffectMode,
  type EffectName,
} from "../face/settings";

function slider<T extends object, K extends keyof T>(
  target: T,
  key: K,
  min: number,
  max: number,
  step: number,
  label = String(key),
) {
  return {
    value: target[key] as number,
    min,
    max,
    step,
    label,
    onChange: (v: number) => {
      target[key] = v as T[K];
    },
  };
}

function exportSettings() {
  const json = `${JSON.stringify(settings, null, 2)}\n`;
  navigator.clipboard.writeText(json).then(
    () => alert("Settings copied. Paste them over apps/site/src/island/face/settings.json to make them the defaults."),
    () => {
      console.log(json);
      alert("Couldn't use the clipboard; the settings are in the browser console.");
    },
  );
}

export default function Lab({ data }: { data: FaceData }) {
  const half = Math.ceil(FACE_STATES.length / 2);
  const stateButtons = (label: string, states: readonly (typeof FACE_STATES)[number][]) =>
    buttonGroup({ label, opts: Object.fromEntries(states.map((s) => [s, () => control.setState(s)])) });

  useControls("Face", {
    "states 1": stateButtons("state", FACE_STATES.slice(0, half)),
    "states 2": stateButtons(" ", FACE_STATES.slice(half)),
    babble: {
      value: control.babble,
      label: "fake speech",
      hint: "Random mouth shapes while speaking, until real replies drive the lips",
      onChange: (v: boolean) => {
        control.babble = v;
      },
    },
    viseme: {
      value: control.viseme,
      label: "hold mouth shape",
      options: ["off", ...Object.keys(data.visemes)],
      onChange: (v: string) => {
        control.viseme = v;
      },
    },
    "replay intro": button(() => {
      control.replayIntro = true;
    }),
    "export settings": button(exportSettings),
  });

  const m = settings.motion;
  useControls("Motion", {
    reach: slider(m, "reach", 0, 90, 1, "reach (°)"),
    headYaw: slider(m, "headYaw", 0, 45, 1, "head turn limit (°)"),
    headPitch: slider(m, "headPitch", 0, 30, 1, "head nod limit (°)"),
    headShare: slider(m, "headShare", 0, 1, 0.05, "head share"),
    headSmoothing: slider(m, "headSmoothing", 0, 1, 0.01, "head smoothing (s)"),
    eyeSmoothing: slider(m, "eyeSmoothing", 0, 0.5, 0.01, "eye smoothing (s)"),
    clipHead: slider(m, "clipHead", 0, 2, 0.05, "recorded head sway"),
    lipSync: slider(m, "lipSync", 0.5, 3, 0.05, "lip-sync strength"),
  });

  const b = settings.buttons;
  useControls("Buttons", {
    style: {
      value: b.style,
      label: "movement",
      options: [...BUTTON_STYLES],
      hint: "head: turn with the face · orbit: circle slowly · ring: still, with a bob",
      onChange: (v: ButtonStyle) => {
        b.style = v;
      },
    },
    spread: slider(b, "spread", 0.7, 1.6, 0.01, "distance from face"),
    speed: slider(b, "speed", 0, 3, 0.05, "speed"),
    bob: slider(b, "bob", 0, 3, 0.05, "bob"),
  });

  const look = settings.look;
  useControls("Look", {
    pointSize: slider(look, "pointSize", 0.2, 4, 0.05, "point size (mm)"),
    pointOpacity: slider(look, "pointOpacity", 0, 1, 0.01, "points"),
    lineOpacity: slider(look, "lineOpacity", 0, 1, 0.01, "lines"),
    eyeOpacity: slider(look, "eyeOpacity", 0, 1, 0.01, "eye rings"),
    eyeSize: slider(look, "eyeSize", 0.5, 3, 0.05, "eye ring size"),
    eyeGlow: slider(look, "eyeGlow", 0.5, 3, 0.05, "eye ring glow"),
    baseColor: {
      value: look.baseColor,
      label: "base color",
      onChange: (v: string) => {
        look.baseColor = v;
      },
    },
    frameWidth: slider(look, "frameWidth", 0.15, 0.6, 0.01, "view width (m)"),
    frameHeight: slider(look, "frameHeight", 0.2, 0.7, 0.01, "view height (m)"),
    frameCenterY: slider(look, "frameCenterY", -0.15, 0.1, 0.005, "view center (m)"),
    realism: slider(look, "realism", 0, 1, 0.01, "realistic (this Mac only)"),
    skinBrightness: slider(look, "skinBrightness", 0.5, 1.6, 0.01, "skin brightness"),
    lightAround: slider(look, "lightAround", -90, 90, 1, "light from side (°)"),
    lightUp: slider(look, "lightUp", -60, 80, 1, "light from above (°)"),
    occlude: {
      value: look.occlude,
      label: "hide what's behind",
      hint: "Off: see through the face and head, like a hologram",
      onChange: (v: boolean) => {
        look.occlude = v;
      },
    },
  });

  const head = settings.head;
  useControls(
    "Head",
    {
      showHead: {
        value: head.show,
        label: "show",
        onChange: (v: boolean) => {
          head.show = v;
        },
      },
      headWidth: slider(head, "width", 0.8, 1.25, 0.01, "width"),
      headHeight: slider(head, "height", 0.8, 1.25, 0.01, "height"),
      headDepth: slider(head, "depth", 0.8, 1.25, 0.01, "depth"),
      headPoints: slider(head, "pointOpacity", 0, 1, 0.01, "points"),
      headLines: slider(head, "lineOpacity", 0, 1, 0.01, "lines"),
    },
    { collapsed: true },
  );

  const hair = settings.hair;
  useControls(
    "Hair",
    {
      showHair: {
        value: hair.show,
        label: "show",
        onChange: (v: boolean) => {
          hair.show = v;
        },
      },
      hairStyle: {
        value: hair.style,
        label: "style",
        options: ["loose", "bun"],
        onChange: (v: "loose" | "bun") => {
          hair.style = v;
        },
      },
      hairCount: slider(hair, "count", 200, 4000, 100, "strands"),
      hairLength: slider(hair, "length", 0.02, 0.5, 0.01, "length below chin (m)"),
      hairPart: slider(hair, "part", -0.04, 0.04, 0.002, "part (m from center)"),
      hairClump: slider(hair, "clump", 0, 1, 0.05, "locks"),
      bunHeight: slider(hair, "bunHeight", 0, 1, 0.05, "bun height"),
      bunSize: slider(hair, "bunSize", 0.04, 0.12, 0.005, "bun size (m)"),
      hairSway: slider(hair, "sway", 0, 3, 0.05, "sway"),
      hairLag: slider(hair, "lag", 0, 3, 0.05, "trail on turns"),
      hairOpacity: slider(hair, "opacity", 0, 1, 0.01, "opacity"),
    },
    { collapsed: true },
  );

  // Leva needs every key unique across the panel, so keys carry the effect or state name.
  const effects = Object.fromEntries(
    (Object.keys(EFFECTS) as EffectName[]).map((name) => {
      const e = settings.effects[name];
      const controls = {
        [`${name}.mode`]: {
          value: e.mode,
          label: "mode",
          options: ["auto", "on", "off"],
          onChange: (v: EffectMode) => {
            e.mode = v;
          },
        },
        [`${name}.strength`]: slider(e, "strength", name === "magnet" ? -2 : 0, 2, 0.05, "strength"),
        [`${name}.speed`]: slider(e, "speed", 0.1, 3, 0.05, "speed"),
      };
      return [EFFECTS[name], folder(controls, { collapsed: true })];
    }),
  );
  useControls("Effects", effects, { collapsed: true });

  const states = Object.fromEntries(
    FACE_STATES.map((name) => {
      const s = settings.states[name];
      const controls = {
        [`${name}.color`]: {
          value: s.color,
          label: "color",
          onChange: (v: string) => {
            s.color = v;
          },
        },
        [`${name}.brightness`]: slider(s, "brightness", 0, 2, 0.05, "brightness"),
      };
      return [name, folder(controls, { collapsed: true })];
    }),
  );
  useControls("State colors", states, { collapsed: true });

  return <Leva titleBar={{ title: "Face lab" }} theme={{ sizes: { rootWidth: "360px", controlWidth: "170px" } }} />;
}

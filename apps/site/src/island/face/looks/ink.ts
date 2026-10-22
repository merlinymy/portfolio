/**
 * The ink-in-water look (docs/face-looks-plan.md, "Ink in water"): your face drawn only in ink,
 * seen underwater. The ink gathers where light falls on your face and around your eyes and lips,
 * and keeps diffusing: thin wisps peel off and unfurl into the water while fresh ink redraws the
 * face. "Rhythm" moves it between a steady face and drops: your face arriving as a drop of ink,
 * blooming apart, then re-forming. The camera sits just below the surface, which shows along the
 * top from underneath, mirroring the ink, with light shafts, caustics and drifting specks.
 *
 * Each frame:
 * 1. The face is drawn into a hidden picture of where its ink goes: its lit parts (a portrait in
 *    light and shadow), its eyes and lips, fading out toward the outline, broken into grain.
 * 2. The water's state (ink amount, how fresh it is, and the water's movement) is moved along the
 *    water's own current in two steps. A first guess, then a correction: the guess is sent back
 *    the other way and half the difference fixed, within the range it came from. That keeps fine
 *    wisps crisp, where moving once would blur them a little every frame.
 * 3. On screen: the water and its surface, then the ink, then the specks.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  NormalBlending,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderTarget,
} from "three";
import { settings, type FaceState } from "../settings";
import { createLookMaterial } from "../shaders";
import {
  type Look,
  type LookFrame,
  type LookParts,
  Pass,
  fullscreen,
  fullscreenVertex,
  hiddenPicture,
  lookSurface,
  openings,
  ringWeights,
  screenUv,
} from "./common";
import { caustics, noise } from "./glsl";

const DEG = Math.PI / 180;
/** States that keep the ink its own color; the others tint it with their color. */
const UNTINTED: FaceState[] = ["idle", "panel", "listening", "speaking"];
const SPECK_COUNT = 1800;
/** How long after a click its pulse keeps pushing, in seconds. */
const CLICK_SECONDS = 0.6;

/** Turns a pixel into the direction it looks along, in the scene. */
const viewRay = /* glsl */ `
uniform mat4 uInverseProjection, uCameraWorld;
uniform vec3 uCameraPosition;
vec3 viewRay(vec2 uv) {
  vec4 view = uInverseProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  view /= view.w;
  return normalize((uCameraWorld * vec4(view.xyz, 0.0)).xyz);
}
`;

const portraitFragment = /* glsl */ `
uniform float uTime, uPortrait, uContrast, uFeatures, uLiveliness, uOutlineFade, uGrain, uSeed, uAmount;
uniform vec3 uLightDirection;
varying vec3 vNormal, vView, vFace;
varying float vExpressive, vEdge, vExtra;
${noise}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  if (dot(n, v) < 0.0) n = -n;
  // A portrait in light and shadow: ink where light falls, none in the hollows or where the face
  // turns away.
  float lit = pow(max(dot(n, uLightDirection), 0.0), uContrast);
  float facing = smoothstep(0.0, 0.4, dot(n, v));
  float ink = lit * uPortrait * facing + vEdge * uFeatures + vExpressive * uLiveliness * 0.5;
  // vExtra is the distance from the outline here: 1 on it, so the face fades into the water.
  ink *= 1.0 - vExtra * uOutlineFade;
  // Grain: patchy, as if dropped rather than painted. Each drop gets its own pattern.
  float g = 0.5 + 0.5 * fbm(vFace * 55.0 + vec3(0.0, 0.0, uSeed + uTime * 0.04));
  ink *= mix(1.0, smoothstep(0.2, 0.8, g) * 1.7, uGrain);
  gl_FragColor = vec4(ink * uAmount, 0.0, 0.0, 1.0);
}
`;

/** Step 1: the first guess at where everything moves, and the water's new movement. */
const moveFragment = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uTexel, uPointer, uPointerVelocity, uMouth, uCenter;
uniform vec3 uClicks[3];
uniform float uAspect, uDt, uTime, uSwirl, uSwirlSize, uSwirlSpeed, uDrift, uSpread, uBloom, uMomentum, uSoftness;
uniform float uPointerStir, uClickPush, uPuff, uMouthRadius, uSurfaceLine;
varying vec2 vUv;
${noise}
void main() {
  // Square units, one screen height tall, so eddies are round on any screen.
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  vec4 here = texture2D(uState, vUv);
  vec2 from = vUv - vec2(here.b / uAspect, here.a) * uDt;
  vec4 prev = texture2D(uState, from);
  vec2 carried = prev.rg;
  if (uSoftness > 0.0) {
    vec2 o = uTexel * uSoftness;
    vec2 around = (texture2D(uState, from + vec2(o.x, 0.0)).rg + texture2D(uState, from - vec2(o.x, 0.0)).rg
      + texture2D(uState, from + vec2(0.0, o.y)).rg + texture2D(uState, from - vec2(0.0, o.y)).rg) * 0.25;
    carried = mix(carried, around, min(uSoftness, 1.0) * 0.6);
  }

  // The current: three sizes of swirl (broad currents, eddies, fine wisps), the ink unfurling
  // outward from the face, an optional drift up or down, and a drop's burst as it blooms.
  vec2 c = q - vec2(uCenter.x * uAspect, uCenter.y);
  vec2 current = (curl(q * uSwirlSize, uTime * uSwirlSpeed * 0.2)
    + curl(q * uSwirlSize * 2.7 + 3.1, uTime * uSwirlSpeed * 0.33) * 0.45
    + curl(q * uSwirlSize * 6.3 + 7.7, uTime * uSwirlSpeed * 0.5) * 0.22) * uSwirl * 0.025;
  current += c * uSpread + vec2(0.0, uDrift);
  current += normalize(c + 1e-5) * uBloom * exp(-dot(c, c) / 0.05);
  // Just under the surface, water moving up turns and spreads sideways.
  float under = smoothstep(uSurfaceLine - 0.08, uSurfaceLine, vUv.y);
  current.x += sign(c.x) * under * max(current.y, 0.0);
  current.y *= 1.0 - under;
  // Pushes carry on for "momentum" seconds, then the current takes over again.
  float keep = uMomentum > 0.0 ? exp(-uDt / uMomentum) : 0.0;
  vec2 v = mix(current, prev.ba, keep);

  // The pointer drags the water along with it.
  vec2 d = q - vec2(uPointer.x * uAspect, uPointer.y);
  v += uPointerVelocity * exp(-dot(d, d) / 0.005) * uPointerStir * uDt * 6.0;
  // A click sends a ring outward from where it landed.
  for (int i = 0; i < 3; i++) {
    vec3 k = uClicks[i];
    if (k.z >= 0.0 && k.z < ${CLICK_SECONDS.toFixed(2)}) {
      vec2 e = q - vec2(k.x * uAspect, k.y);
      float ring = exp(-pow((length(e) - k.z * 0.3) / 0.045, 2.0));
      v += normalize(e + 1e-5) * ring * uClickPush * 3.0 * uDt * (1.0 - k.z / ${CLICK_SECONDS.toFixed(2)});
    }
  }
  // Your voice breathes ink out of the mouth, pushing it outward.
  vec2 m = q - vec2(uMouth.x * uAspect, uMouth.y);
  float mouth = exp(-dot(m, m) / max(uMouthRadius * uMouthRadius, 1e-6));
  v += normalize(m + 1e-5) * mouth * uPuff * 2.5 * uDt;
  gl_FragColor = vec4(carried, clamp(v, -1.5, 1.5));
}
`;

/** Step 2: correct the guess, fade, then lay down fresh ink. */
const settleFragment = /* glsl */ `
uniform sampler2D uState, uGuess, uPortrait;
uniform vec2 uTexel, uMouth;
uniform float uAspect, uDt, uSharpness, uFade, uInject, uPuff, uMouthRadius;
varying vec2 vUv;
void main() {
  vec4 before = texture2D(uState, vUv);
  vec4 guess = texture2D(uGuess, vUv);
  vec2 stride = vec2(before.b / uAspect, before.a) * uDt;
  // Send the guess back the other way; whatever doesn't land where it started is the error.
  vec2 returned = texture2D(uGuess, vUv + stride).rg;
  vec2 corrected = guess.rg + 0.5 * (before.rg - returned) * uSharpness;
  // Stay within the values the guess came from, so the correction can't overshoot into ripples.
  vec2 from = vUv - stride;
  vec2 h = uTexel * 0.5;
  vec2 a = texture2D(uState, from + vec2(-h.x, -h.y)).rg;
  vec2 b = texture2D(uState, from + vec2(h.x, -h.y)).rg;
  vec2 c = texture2D(uState, from + vec2(-h.x, h.y)).rg;
  vec2 d = texture2D(uState, from + vec2(h.x, h.y)).rg;
  corrected = clamp(corrected, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));

  float ink = corrected.r * exp(-uDt / max(uFade, 0.01));
  float fresh = corrected.g * exp(-uDt / max(uFade * 0.3, 0.01));
  vec2 m = vec2((vUv.x - uMouth.x) * uAspect, vUv.y - uMouth.y);
  float mouth = exp(-dot(m, m) / max(uMouthRadius * uMouthRadius, 1e-6));
  ink += mouth * uPuff * 0.6 * uDt;
  fresh = max(fresh, mouth * min(uPuff, 1.0));
  // The portrait: fresh ink where the face is (steadily, or in drops).
  float laid = texture2D(uPortrait, vUv).r * uInject;
  ink = max(ink, laid);
  fresh = max(fresh, clamp(laid * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(ink, fresh, guess.ba);
}
`;

const waterFragment = /* glsl */ `
uniform sampler2D uState;
uniform mat4 uViewProjection;
uniform float uTime, uSurfaceY, uReach, uWaveSize, uWaveSpeed, uWaveTilt, uShimmer, uMirror;
uniform float uShafts, uShaftSpeed, uThickness, uAspect, uSpread;
uniform vec2 uCenter;
uniform vec3 uWaterColor, uLightColor, uInkColor;
varying vec2 vUv;
${noise}
${viewRay}
float wave(vec2 p, float t) {
  return sin(dot(p, vec2(0.8, 0.6)) + t * 1.3) * 0.5
    + sin(dot(p, vec2(-0.5, 0.9)) * 1.7 - t * 1.1) * 0.35
    + snoise(vec3(p * 0.9, t * 0.35)) * 0.6
    + snoise(vec3(p * 2.3, t * 0.6)) * 0.25;
}
float shaft(float x, float t) {
  float a = 0.5 + 0.5 * snoise(vec3(x * 9.0, 0.0, t * 0.12));
  float b = 0.5 + 0.5 * snoise(vec3(x * 23.0, 4.0, t * 0.2));
  return pow(a, 4.0) * 1.4 + pow(b, 6.0) * 0.6;
}
void main() {
  vec3 dir = viewRay(vUv);
  // Deep water, a little lighter toward the surface.
  vec3 color = uWaterColor * (0.8 + 0.6 * smoothstep(-0.2, 0.25, dir.y));

  // Light shafts slanting down from the surface, at the face and farther back.
  for (int k = 0; k < 3; k++) {
    float plane = -0.05 - float(k) * 0.22;
    vec3 w = uCameraPosition + dir * ((plane - uCameraPosition.z) / dir.z);
    float depth = uSurfaceY - w.y;
    if (depth > 0.0) {
      float s = shaft(w.x + depth * 0.32, uTime * uShaftSpeed);
      color += uLightColor * s * exp(-depth * 3.5) * uShafts * 0.1 * (1.0 - 0.28 * float(k));
    }
  }

  // The surface overhead, seen from underneath.
  if (dir.y > 0.0) {
    vec3 hit = uCameraPosition + dir * ((uSurfaceY - uCameraPosition.y) / dir.y);
    vec2 p = hit.xz * uWaveSize * 14.0;
    float t = uTime * uWaveSpeed;
    float e = 0.04;
    vec2 slope = vec2(wave(p + vec2(e, 0.0), t) - wave(p - vec2(e, 0.0), t), wave(p + vec2(0.0, e), t) - wave(p - vec2(0.0, e), t)) / (2.0 * e);
    // The surface's downward-facing direction, tilted by the ripples.
    vec3 n = normalize(vec3(-slope.x * uWaveTilt * 0.6, -1.0, -slope.y * uWaveTilt * 0.6));
    float cosine = dot(-dir, n);
    // From below, water passes the sky's light only for rays steeper than about 48.6 degrees from
    // straight up; shallower rays bounce back down, so the surface is a mirror. Ripples steep
    // enough to tip a spot inside that angle flicker bright: the shimmer.
    float through = smoothstep(0.58, 0.74, cosine);
    vec3 bounce = reflect(dir, n);
    vec3 mirror = uWaterColor * 1.4;
    if (bounce.z < 0.0 && hit.z > 0.0) {
      // What the mirror shows: the ink where the bounced ray meets the face's plane.
      vec3 seen = hit + bounce * (-hit.z / bounce.z);
      vec4 clip = uViewProjection * vec4(seen, 1.0);
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        mirror += uInkColor * (1.0 - exp(-texture2D(uState, uv).r * uThickness)) * 0.75;
      }
    }
    vec3 surface = mirror * uMirror + uLightColor * (0.05 + pow(through, 2.0) * 1.4 * uShimmer);
    // Fine glints along the ripples' crests.
    surface += uLightColor * pow(max(snoise(vec3(p * 3.0, t * 1.7)), 0.0), 8.0) * 0.6 * uShimmer;
    float near = exp(-max(-hit.z, 0.0) / max(uReach, 0.01));
    color = mix(color, surface, near * smoothstep(0.0, 0.03, dir.y));
  }

  // The water fades into the page away from the face, and at the view's edges.
  float away = length(vec2((vUv.x - uCenter.x) * uAspect, vUv.y - uCenter.y));
  vec2 edge = abs(vUv - 0.5) * 2.0;
  float alpha = smoothstep(uSpread * 1.15, uSpread * 0.55, away) * smoothstep(1.0, 0.85, max(edge.x, edge.y));
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

const inkFragment = /* glsl */ `
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uTime, uThickness, uBillow, uGlow, uCaustics, uCausticSize, uCausticSpeed, uTintAmount;
uniform vec3 uInkColor, uTint;
varying vec2 vUv;
${noise}
${caustics}
${viewRay}
void main() {
  vec4 state = texture2D(uState, vUv);
  float ink = state.r;
  // The ink's slopes give it a surface to light, so thicker parts billow, lit from above.
  vec2 o = uTexel * 2.0;
  float dx = texture2D(uState, vUv + vec2(o.x, 0.0)).r - texture2D(uState, vUv - vec2(o.x, 0.0)).r;
  float dy = texture2D(uState, vUv + vec2(0.0, o.y)).r - texture2D(uState, vUv - vec2(0.0, o.y)).r;
  vec3 n = normalize(vec3(-dx * uBillow * 4.0, -dy * uBillow * 4.0, 1.0));
  float light = clamp(dot(n, normalize(vec3(-0.25, 0.75, 0.6))), 0.0, 1.0);
  // Caustics where the ink is, at the face's plane.
  vec3 dir = viewRay(vUv);
  vec3 w = uCameraPosition + dir * (-uCameraPosition.z / dir.z);
  float c = caustic(w.xy * 28.0 * uCausticSize, uTime * 0.5 * uCausticSpeed);
  vec3 color = mix(uInkColor, uTint, uTintAmount);
  // Thin ink is see-through; overlapping wisps add up.
  float cover = 1.0 - exp(-ink * uThickness);
  vec3 lit = color * (0.45 + 0.75 * light) * (1.0 + c * uCaustics * 0.35);
  // The thinnest wisps cool toward the water's blue; fresh ink is the brightest.
  lit = mix(lit * vec3(0.6, 0.72, 0.92), lit, smoothstep(0.02, 0.5, cover)) * (0.8 + 0.4 * state.g);
  float glow = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    vec2 ring = vec2(cos(a), sin(a));
    glow += texture2D(uState, vUv + ring * uTexel * 9.0).r + 0.6 * texture2D(uState, vUv + ring * uTexel * 24.0).r;
  }
  glow = 1.0 - exp(-glow / 12.8 * uThickness);
  vec3 shown = lit * cover + color * glow * uGlow * 0.25;
  float alpha = clamp(cover * 0.9 + glow * uGlow * 0.05, 0.0, 1.0);
  gl_FragColor = vec4(1.0 - exp(-shown * 1.2), alpha);
}
`;

const speckVertex = /* glsl */ `
uniform float uTime, uScale, uSize, uShare, uSurfaceY, uCaustics, uCausticSize, uCausticSpeed;
attribute vec3 aRandom;
varying float vBright;
${noise}
${caustics}
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float t = uTime;
  vec3 p = (aRandom - 0.5) * vec3(0.6, 0.6, 0.7);
  // Specks sink very slowly, wrap back to the top, and wander a little.
  p.y = mod(p.y + 0.3 - t * 0.004 * (0.5 + aRandom.x), 0.6) - 0.3;
  p += vec3(snoise(vec3(aRandom.xy * 9.0, t * 0.05)), snoise(vec3(aRandom.yz * 9.0, t * 0.05)), snoise(vec3(aRandom.zx * 9.0, t * 0.05))) * 0.02;
  float shown = step(hash(aRandom.x * 91.7 + aRandom.y * 13.1), uShare) * step(p.y, uSurfaceY);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float c = caustic(p.xz * 35.0 * uCausticSize, t * 0.5 * uCausticSpeed);
  vBright = shown * (0.25 + c * uCaustics) * exp(-(uSurfaceY - p.y) * 3.0) * (0.6 + 0.4 * sin(t * 1.3 + aRandom.y * 30.0));
  gl_PointSize = max(1.0, uSize * 0.0007 * mix(0.4, 1.4, aRandom.x) * uScale / -mv.z) * shown;
}
`;

const speckFragment = /* glsl */ `
uniform vec3 uLightColor;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uLightColor * core * core * vBright, 1.0);
}
`;

export function createInk(parts: LookParts): Look {
  const uniforms = parts.scene.uniforms;
  const surface = lookSurface(parts);
  // The portrait fades out toward the face's outline, and picks out the eyes and lips.
  const holes = openings(parts.data);
  surface.setAttribute("aExtra", new BufferAttribute(ringWeights(parts.data, holes.outline, 7), 1));
  surface.setAttribute("aEdge", new BufferAttribute(ringWeights(parts.data, [...holes.mouth, ...holes.eyes.flat()], 3), 1));

  // Shared by several of the shaders below; updated every frame.
  const camera = {
    uInverseProjection: { value: new Matrix4() },
    uCameraWorld: { value: new Matrix4() },
    uCameraPosition: { value: new Vector3() },
  };
  const colors = {
    uInkColor: { value: new Color() },
    uLightColor: { value: new Color() },
    uWaterColor: { value: new Color() },
    uTint: { value: new Color(1, 1, 1) },
    uTintAmount: { value: 0 },
  };
  const light = {
    uCaustics: { value: 1 },
    uCausticSize: { value: 1 },
    uCausticSpeed: { value: 1 },
  };
  const surfaceY = { value: 0.155 };
  const thickness = { value: 1 };
  const mouthAt = { uMouth: { value: new Vector2(-1, -1) }, uMouthRadius: { value: 0.05 } };
  const puff = { value: 0 };
  // See-through materials whose colors are already multiplied by their opacity.
  const layered = { transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false };

  // 1. Where the face's ink goes: the portrait.
  const portraitMaterial = createLookMaterial(uniforms, portraitFragment, {
    uPortrait: { value: 1 },
    uContrast: { value: 1 },
    uFeatures: { value: 1 },
    uLiveliness: { value: 0 },
    uOutlineFade: { value: 1 },
    uGrain: { value: 0 },
    uSeed: { value: 0 },
    uAmount: { value: 0 },
    uLightDirection: { value: new Vector3(0, 0, 1) },
  });
  const portraitScene = new Scene();
  const portraitMesh = new Mesh(surface, portraitMaterial);
  portraitMesh.frustumCulled = false;
  portraitScene.add(portraitMesh);

  // 2. The water's state, moved in two steps.
  const move = new Pass(
    new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: moveFragment,
      uniforms: {
        ...mouthAt,
        uState: { value: null },
        uTexel: { value: new Vector2() },
        uPointer: { value: new Vector2(-1, -1) },
        uPointerVelocity: { value: new Vector2() },
        uCenter: { value: new Vector2(0.5, 0.5) },
        uClicks: { value: [new Vector3(0, 0, -1), new Vector3(0, 0, -1), new Vector3(0, 0, -1)] },
        uAspect: { value: 1 },
        uDt: { value: 0 },
        uTime: uniforms.uTime,
        uSwirl: { value: 0 },
        uSwirlSize: { value: 1 },
        uSwirlSpeed: { value: 1 },
        uDrift: { value: 0 },
        uSpread: { value: 0 },
        uBloom: { value: 0 },
        uMomentum: { value: 1 },
        uSoftness: { value: 0 },
        uPointerStir: { value: 0 },
        uClickPush: { value: 0 },
        uPuff: puff,
        uSurfaceLine: { value: 0.9 },
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  const settle = new Pass(
    new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: settleFragment,
      uniforms: {
        ...mouthAt,
        uState: { value: null },
        uGuess: { value: null },
        uPortrait: { value: null },
        uTexel: { value: new Vector2() },
        uAspect: { value: 1 },
        uDt: { value: 0 },
        uSharpness: { value: 1 },
        uFade: { value: 1 },
        uInject: { value: 1 },
        uPuff: puff,
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  let pictures: { portrait: WebGLRenderTarget; guess: WebGLRenderTarget; a: WebGLRenderTarget; b: WebGLRenderTarget } | undefined;
  let pictureKey = "";

  // 3. On screen, back to front.
  const waterMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: waterFragment,
    uniforms: {
      ...camera,
      ...colors,
      uState: { value: null },
      uViewProjection: { value: new Matrix4() },
      uTime: uniforms.uTime,
      uSurfaceY: surfaceY,
      uReach: { value: 0.5 },
      uWaveSize: { value: 1 },
      uWaveSpeed: { value: 1 },
      uWaveTilt: { value: 1 },
      uShimmer: { value: 1 },
      uMirror: { value: 1 },
      uShafts: { value: 1 },
      uShaftSpeed: { value: 1 },
      uThickness: thickness,
      uAspect: { value: 1 },
      uSpread: { value: 1 },
      uCenter: { value: new Vector2(0.5, 0.5) },
    },
    ...layered,
    depthTest: false,
  });
  const water = fullscreen(waterMaterial);
  water.renderOrder = -10;

  const inkMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: inkFragment,
    uniforms: {
      ...camera,
      ...colors,
      ...light,
      uState: { value: null },
      uTexel: { value: new Vector2() },
      uTime: uniforms.uTime,
      uThickness: thickness,
      uBillow: { value: 1 },
      uGlow: { value: 0 },
    },
    ...layered,
    depthTest: false,
  });
  const ink = fullscreen(inkMaterial);
  ink.renderOrder = 2;

  // Specks glow, so they add their light to whatever is behind them.
  const speckGeometry = new BufferGeometry();
  const randoms = new Float32Array(SPECK_COUNT * 3);
  for (let i = 0; i < randoms.length; i++) randoms[i] = Math.random();
  speckGeometry.setAttribute("position", new BufferAttribute(new Float32Array(SPECK_COUNT * 3), 3));
  speckGeometry.setAttribute("aRandom", new BufferAttribute(randoms, 3));
  const speckMaterial = new ShaderMaterial({
    vertexShader: speckVertex,
    fragmentShader: speckFragment,
    uniforms: {
      ...colors,
      ...light,
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uSize: { value: 1 },
      uShare: { value: 1 },
      uSurfaceY: surfaceY,
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const specks = new Points(speckGeometry, speckMaterial);
  specks.frustumCulled = false;
  specks.renderOrder = 3;

  const object = new Group();
  object.add(water, ink, specks);

  const pointer = { uv: new Vector2(-1, -1), velocity: new Vector2(), seen: false };
  const scratch = {
    v: new Vector3(),
    point: new Vector3(),
    uv: new Vector2(),
    other: new Vector2(),
    move: new Vector2(),
    size: new Vector2(),
    clear: new Color(),
    color: new Color(),
    viewProjection: new Matrix4(),
  };
  const eyes = { glow: 0, color: new Color(0.9, 0.95, 1) };

  function resize(frame: LookFrame, quality: number) {
    frame.gl.getDrawingBufferSize(scratch.size);
    const w = Math.max(16, Math.round(scratch.size.x * quality));
    const h = Math.max(16, Math.round(scratch.size.y * quality));
    const key = `${w}x${h}`;
    if (key === pictureKey && pictures) return pictures;
    if (pictures) for (const t of Object.values(pictures)) t.dispose();
    pictures = { portrait: hiddenPicture(w, h), guess: hiddenPicture(w, h), a: hiddenPicture(w, h), b: hiddenPicture(w, h) };
    pictureKey = key;
    for (const t of [pictures.a, pictures.b]) {
      frame.gl.setRenderTarget(t);
      frame.gl.clear();
    }
    return pictures;
  }

  return {
    object,
    eyes,
    update(frame) {
      const f = settings.looks.ink;
      const dt = Math.min(frame.dt, 1 / 20);
      const calm = frame.reduced ? 0.35 : 1;
      const gl = frame.gl;
      const cam = frame.camera;
      gl.getClearColor(scratch.clear);
      const clearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 0);
      const p = resize(frame, f.quality);
      const aspect = frame.width / Math.max(1, frame.height);
      const ease = 1 - Math.exp(-dt / 0.4);

      // Colors: the ink tints toward the state's color, except in the everyday states.
      colors.uInkColor.value.set(f.inkColor);
      colors.uLightColor.value.set(f.lightColor);
      colors.uWaterColor.value.set(f.waterColor);
      const tinted = !UNTINTED.includes(frame.state);
      colors.uTintAmount.value += ((tinted ? f.stateTint : 0) - colors.uTintAmount.value) * ease;
      colors.uTint.value.lerp(scratch.color.set(settings.states[frame.state].color), ease);
      light.uCaustics.value = f.caustics * frame.brightness;
      light.uCausticSize.value = f.causticSize;
      light.uCausticSpeed.value = f.causticSpeed * calm;
      surfaceY.value = f.surfaceHeight;
      thickness.value = f.thickness;
      puff.value = f.puff * frame.loudness;

      cam.updateMatrixWorld();
      camera.uInverseProjection.value.copy(cam.projectionMatrixInverse);
      camera.uCameraWorld.value.copy(cam.matrixWorld);
      camera.uCameraPosition.value.setFromMatrixPosition(cam.matrixWorld);
      scratch.viewProjection.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

      // The pointer, in screen heights a second.
      if (frame.pointer.inside) {
        const u = frame.pointer.x / Math.max(1, frame.width);
        const v = 1 - frame.pointer.y / Math.max(1, frame.height);
        if (pointer.seen && dt > 0) {
          pointer.velocity.lerp(scratch.move.set(((u - pointer.uv.x) * aspect) / dt, (v - pointer.uv.y) / dt), 0.5);
        }
        pointer.uv.set(u, v);
        pointer.seen = true;
      } else {
        pointer.seen = false;
        pointer.velocity.multiplyScalar(Math.exp(-dt / 0.15));
      }
      pointer.velocity.clampLength(0, 3);

      // The mouth: its middle (turned with the head) and size on screen, for the voice.
      scratch.v.set(0, 0, 0);
      for (const i of holes.mouth) scratch.v.add(scratch.point.fromArray(frame.positions, i * 3));
      scratch.v.divideScalar(Math.max(1, holes.mouth.length));
      let mouthSize = 0;
      for (const i of holes.mouth) mouthSize = Math.max(mouthSize, scratch.point.fromArray(frame.positions, i * 3).distanceTo(scratch.v));
      scratch.v.applyMatrix4(frame.headMatrix);
      const mouthUv = screenUv(scratch.v, cam, scratch.uv);
      mouthAt.uMouth.value.copy(mouthUv);
      screenUv(scratch.point.copy(scratch.v).setX(scratch.v.x + Math.max(mouthSize, 0.01) * 0.7), cam, scratch.other);
      mouthAt.uMouthRadius.value = Math.abs(scratch.other.x - mouthUv.x) * aspect;

      // Where the surface meets the face's plane on screen, and the face's middle.
      const mu = move.material.uniforms;
      mu.uSurfaceLine.value = screenUv(scratch.point.set(0, f.surfaceHeight, 0), cam, scratch.other).y;
      const center = screenUv(scratch.point.set(0, 0, 0).applyMatrix4(frame.headMatrix), cam, scratch.other);
      mu.uCenter.value.copy(center);
      waterMaterial.uniforms.uCenter.value.copy(center);

      // Clicks: the face's ripples (Face.tsx) start where a click lands; each sends out a pulse.
      uniforms.uRipples.value.forEach((r, i) => {
        const age = frame.now - r.w;
        const slot = mu.uClicks.value[i];
        if (r.w < 0 || age < 0 || age > CLICK_SECONDS) slot.set(0, 0, -1);
        else {
          const at = screenUv(scratch.point.set(r.x, r.y, r.z).applyMatrix4(frame.headMatrix), cam, scratch.other);
          slot.set(at.x, at.y, age);
        }
      });

      // Rhythm: between a steady face and drops. Right after a drop, ink lands strongly and bursts
      // outward; between drops, only the steady share keeps the face drawn.
      const period = Math.max(1, f.dropEvery);
      const sinceDrop = frame.now % period;
      const drop = Math.exp(-sinceDrop / 0.35);
      const inject = 1 - f.rhythm + f.rhythm * drop * 1.6;
      const bloom = f.rhythm * f.bloom * Math.exp(-sinceDrop / 0.9) * 0.25;

      // 1. The portrait.
      const pu = portraitMaterial.uniforms;
      pu.uPortrait.value = f.portrait;
      pu.uContrast.value = f.contrast;
      pu.uFeatures.value = f.features;
      pu.uLiveliness.value = f.liveliness;
      pu.uOutlineFade.value = f.outlineFade;
      pu.uGrain.value = f.grain;
      pu.uSeed.value = Math.floor(frame.now / period) * 7.13;
      pu.uAmount.value = f.amount * frame.intro * frame.brightness;
      const above = f.lightAbove * DEG;
      const side = f.lightSide * DEG;
      pu.uLightDirection.value.set(Math.sin(side) * Math.cos(above), Math.sin(above), Math.cos(side) * Math.cos(above));
      gl.setRenderTarget(p.portrait);
      gl.clear();
      gl.render(portraitScene, cam);

      // 2. Move the water's state: a first guess, then the correction; then swap.
      mu.uState.value = p.a.texture;
      mu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      mu.uPointer.value.copy(pointer.uv);
      mu.uPointerVelocity.value.copy(pointer.velocity);
      mu.uAspect.value = aspect;
      mu.uDt.value = dt;
      mu.uSwirl.value = f.swirl;
      mu.uSwirlSize.value = f.swirlSize;
      mu.uSwirlSpeed.value = f.swirlSpeed * calm;
      mu.uDrift.value = f.drift * calm;
      mu.uSpread.value = f.spread * calm;
      mu.uBloom.value = bloom * calm;
      mu.uMomentum.value = f.momentum;
      mu.uSoftness.value = f.softness;
      mu.uPointerStir.value = f.pointerStir;
      mu.uClickPush.value = f.clickPush;
      move.render(gl, p.guess);
      const su = settle.material.uniforms;
      su.uState.value = p.a.texture;
      su.uGuess.value = p.guess.texture;
      su.uPortrait.value = p.portrait.texture;
      su.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      su.uAspect.value = aspect;
      su.uDt.value = dt;
      su.uSharpness.value = f.sharpness;
      su.uFade.value = f.fade;
      su.uInject.value = inject;
      settle.render(gl, p.b);
      [p.a, p.b] = [p.b, p.a];
      gl.setRenderTarget(null);
      gl.setClearColor(scratch.clear, clearAlpha);

      // 3. On screen.
      const wu = waterMaterial.uniforms;
      wu.uState.value = p.a.texture;
      wu.uViewProjection.value.copy(scratch.viewProjection);
      wu.uReach.value = f.surfaceReach;
      wu.uAspect.value = aspect;
      wu.uSpread.value = f.waterSpread;
      wu.uWaveSize.value = f.waveSize;
      wu.uWaveSpeed.value = f.waveSpeed * calm;
      wu.uWaveTilt.value = f.waveTilt;
      wu.uShimmer.value = f.shimmer * frame.brightness;
      wu.uMirror.value = f.mirror;
      wu.uShafts.value = f.shafts * frame.brightness;
      wu.uShaftSpeed.value = f.shaftSpeed * calm;

      const iu = inkMaterial.uniforms;
      iu.uState.value = p.a.texture;
      iu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      iu.uBillow.value = f.billow;
      iu.uGlow.value = f.glow;

      speckMaterial.uniforms.uShare.value = f.specks;
      speckMaterial.uniforms.uSize.value = f.speckSize;

      // Eye rings are off unless asked for: the ink draws the eyes.
      eyes.glow = f.eyeGlow * frame.intro;
      eyes.color.copy(colors.uInkColor.value).lerp(colors.uTint.value, colors.uTintAmount.value);
    },
    dispose() {
      if (pictures) for (const t of Object.values(pictures)) t.dispose();
      move.dispose();
      settle.dispose();
      portraitMaterial.dispose();
      for (const m of [water, ink]) m.geometry.dispose();
      for (const m of [waterMaterial, inkMaterial, speckMaterial]) m.dispose();
      speckGeometry.dispose();
    },
  };
}

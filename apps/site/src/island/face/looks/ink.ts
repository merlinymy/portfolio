/**
 * The ink-in-water look (docs/face-looks-plan.md, "Ink in water"): an underwater view. The camera
 * looks level, just below the surface, so the surface shows from underneath along the top: a
 * rippling sheet that mirrors the ink below it, with flickers of light where a ripple lets the sky
 * through. Below it your face hangs in black water, pale and lit by caustics, and white ink billows
 * off it, curls into eddies and fades. Specks drift in the light shafts, and bubbles rise from your
 * mouth while you speak.
 *
 * Each frame:
 * 1. The face is drawn into a hidden picture of where it gives off ink: its open edges, the sides
 *    that turn away, the parts that move most, and a thin wash over the whole face.
 * 2. The water's state is fed back into itself: ink amount, how fresh it is, and the water's own
 *    movement. The movement is a swirling current plus pushes from the pointer, clicks and your
 *    voice, which carry on for a moment ("momentum"); the ink rides on it.
 * 3. On screen: the water and its surface, the submerged face, the ink, then specks and bubbles.
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
  FacePoints,
  type Look,
  type LookFrame,
  type LookParts,
  Pass,
  fullscreen,
  fullscreenVertex,
  hiddenPicture,
  lookSurface,
  openings,
  screenUv,
} from "./common";
import { caustics, noise } from "./glsl";

/** States that keep the ink its own color; the others tint it with their color. */
const UNTINTED: FaceState[] = ["idle", "panel", "listening", "speaking"];
const SPECK_COUNT = 1800;
const BUBBLE_COUNT = 280;
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

const sourceFragment = /* glsl */ `
uniform float uTime, uEdgeInk, uRimInk, uFeatureInk, uFaceInk, uAmount;
varying vec3 vNormal, vView, vFace;
varying float vExpressive, vEdge;
${noise}
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(-vView)));
  float rim = pow(1.0 - facing, 2.0);
  float grain = 0.55 + 0.45 * snoise(vec3(vFace.xy * 55.0, uTime * 0.5));
  float ink = (vEdge * uEdgeInk + rim * uRimInk + vExpressive * uFeatureInk * 0.6 + uFaceInk) * grain * uAmount;
  gl_FragColor = vec4(ink, 0.0, 0.0, 1.0);
}
`;

const waterStateFragment = /* glsl */ `
uniform sampler2D uPrev, uSource;
uniform vec2 uTexel, uPointer, uPointerVelocity, uMouth;
uniform vec3 uClicks[3];
uniform float uAspect, uDt, uTime, uSwirl, uSwirlSize, uSwirlSpeed, uDrift, uMomentum, uFade, uSoftness;
uniform float uPointerStir, uClickPush, uPuff, uMouthRadius, uSurfaceLine, uCenterX;
varying vec2 vUv;
${noise}
void main() {
  // Square units, one screen height tall, so eddies are round on any screen.
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  vec2 velocity = texture2D(uPrev, vUv).ba;
  vec2 from = vUv - vec2(velocity.x / uAspect, velocity.y) * uDt;
  vec4 prev = texture2D(uPrev, from);
  vec2 o = uTexel * uSoftness;
  float ink = prev.r * 0.4
    + (texture2D(uPrev, from + vec2(o.x, 0.0)).r + texture2D(uPrev, from - vec2(o.x, 0.0)).r
    + texture2D(uPrev, from + vec2(0.0, o.y)).r + texture2D(uPrev, from - vec2(0.0, o.y)).r) * 0.15;
  float fresh = prev.g;

  // The current: a swirling flow plus a slow drift. Just under the surface, rising water turns
  // and spreads out sideways.
  // Three sizes of swirl: broad currents, eddies, and fine wisps.
  vec2 current = (curl(q * uSwirlSize, uTime * uSwirlSpeed * 0.2)
    + curl(q * uSwirlSize * 2.7 + 3.1, uTime * uSwirlSpeed * 0.33) * 0.45
    + curl(q * uSwirlSize * 6.3 + 7.7, uTime * uSwirlSpeed * 0.5) * 0.22)
    * uSwirl * 0.025 + vec2(0.0, uDrift);
  float under = smoothstep(uSurfaceLine - 0.1, uSurfaceLine, vUv.y);
  current.y *= 1.0 - under;
  current.x += sign(q.x - uCenterX * uAspect) * under * max(uDrift, 0.0) * 1.5;
  // Pushes carry on for "momentum" seconds, then the current takes over again.
  float keep = uMomentum > 0.0 ? exp(-uDt / uMomentum) : 0.0;
  vec2 v = mix(current, prev.ba, keep);

  // The pointer drags the water along with it.
  vec2 d = q - vec2(uPointer.x * uAspect, uPointer.y);
  v += uPointerVelocity * exp(-dot(d, d) / 0.005) * uPointerStir * uDt * 6.0;
  // A click sends a ring outward from where it landed.
  for (int i = 0; i < 3; i++) {
    vec3 c = uClicks[i];
    if (c.z >= 0.0 && c.z < ${CLICK_SECONDS.toFixed(2)}) {
      vec2 e = q - vec2(c.x * uAspect, c.y);
      float ring = exp(-pow((length(e) - c.z * 0.3) / 0.045, 2.0));
      v += normalize(e + 1e-5) * ring * uClickPush * 3.0 * uDt * (1.0 - c.z / ${CLICK_SECONDS.toFixed(2)});
    }
  }
  // Your voice puffs ink out of the mouth, pushing it down and sideways, away from the face.
  vec2 m = q - vec2(uMouth.x * uAspect, uMouth.y);
  float mouth = exp(-dot(m, m) / max(uMouthRadius * uMouthRadius, 1e-6));
  v += normalize(vec2(m.x, min(m.y, 0.0) - 0.02)) * mouth * uPuff * 3.5 * uDt;
  ink += mouth * uPuff * 0.7 * uDt;
  fresh = max(fresh, mouth * min(uPuff, 1.0));
  v = clamp(v, -1.5, 1.5);

  ink *= exp(-uDt / max(uFade, 0.01));
  fresh *= exp(-uDt / max(uFade * 0.3, 0.01));
  // The face keeps drawing ink where it is.
  float source = texture2D(uSource, vUv).r;
  ink = max(ink, source);
  fresh = max(fresh, clamp(source * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(ink, fresh, v);
}
`;

const waterFragment = /* glsl */ `
uniform sampler2D uState, uSource;
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
        float ink = texture2D(uState, uv).r;
        mirror += uInkColor * (1.0 - exp(-ink * uThickness)) * 0.75 + vec3(0.2, 0.24, 0.28) * texture2D(uSource, uv).a * 0.25;
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

const faceFragment = /* glsl */ `
uniform float uTime, uFaceShow, uFaceLight, uCaustics, uCausticSize, uCausticSpeed;
uniform vec3 uLightColor, uWaterColor;
varying vec3 vNormal, vView, vFace;
${noise}
${caustics}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  if (dot(n, v) < 0.0) n = -n;
  // Light comes down through the surface, rippling into caustics on the skin.
  float above = max(dot(n, normalize(vec3(-0.2, 0.85, 0.45))), 0.0);
  float c = caustic(vec2(vFace.x, vFace.z + vFace.y * 0.3) * 40.0 * uCausticSize, uTime * 0.5 * uCausticSpeed);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 skin = vec3(0.42, 0.52, 0.62);
  vec3 color = skin * uLightColor * (0.05 + above * uFaceLight * 0.5)
    + uLightColor * c * above * uCaustics * 0.35
    + uLightColor * rim * 0.12;
  // Water between you and the face takes a little of its light.
  color = mix(uWaterColor, color, 0.85);
  gl_FragColor = vec4(color * uFaceShow, uFaceShow);
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
  // The ink's slopes give it a surface to light, so it billows like cloud lit from above.
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
  float cover = 1.0 - exp(-ink * uThickness);
  vec3 lit = color * (0.3 + 0.9 * light) * (1.0 + c * uCaustics * 0.35);
  // Thin ink cools toward the water's blue; fresh ink is the brightest.
  lit = mix(lit * vec3(0.55, 0.7, 0.92), lit, smoothstep(0.05, 0.6, cover)) * (0.85 + 0.35 * state.g);
  float glow = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    vec2 ring = vec2(cos(a), sin(a));
    glow += texture2D(uState, vUv + ring * uTexel * 9.0).r + 0.6 * texture2D(uState, vUv + ring * uTexel * 22.0).r;
  }
  glow = 1.0 - exp(-glow / 12.8 * uThickness);
  vec3 shown = lit * cover + color * glow * uGlow * 0.3;
  float alpha = clamp(cover + glow * uGlow * 0.08, 0.0, 1.0);
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

const bubbleVertex = /* glsl */ `
uniform sampler2D uFacePoints;
uniform float uFaceCount, uTime, uScale, uSize, uSpeech, uTrickle, uSurfaceY, uMouthSize;
uniform mat4 uHead;
uniform vec3 uMouth;
attribute vec3 aRandom;
varying float vShown;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float life = mix(2.5, 4.5, aRandom.x);
  float clock = uTime + aRandom.y * life;
  float cycle = floor(clock / life);
  float age = fract(clock / life);
  float s = age * life;
  // Most bubbles come out of the mouth while speaking; now and then one rises off the face.
  float fromMouth = step(hash(cycle * 1.7 + aRandom.z * 31.0), uSpeech);
  float trickle = step(hash(cycle * 5.3 + aRandom.x * 17.0), uTrickle);
  vec3 start;
  if (fromMouth > 0.5) {
    start = uMouth + (vec3(hash(cycle + aRandom.x * 3.0), hash(cycle * 2.0 + aRandom.y), hash(cycle * 3.0 + aRandom.z)) - 0.5) * uMouthSize;
  } else {
    float pick = floor(hash(aRandom.z * 77.0 + cycle) * uFaceCount);
    start = (uHead * vec4(texture2D(uFacePoints, vec2((pick + 0.5) / uFaceCount, 0.5)).xyz, 1.0)).xyz;
  }
  float radius = mix(0.0008, 0.0026, aRandom.z) * uSize;
  vec3 p = start;
  // Bigger bubbles rise faster, and every bubble wobbles as it goes.
  p.y += s * (0.045 + radius * 14.0);
  p.x += sin(s * 6.0 + aRandom.x * 20.0) * radius * 1.8 + s * 0.004 * (aRandom.y - 0.5);
  p.z += cos(s * 5.0 + aRandom.y * 20.0) * radius;
  float alive = max(fromMouth, trickle) * step(p.y, uSurfaceY) * smoothstep(0.0, 0.08, age);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, radius * 2.0 * uScale / -mv.z) * step(0.001, alive);
  vShown = alive * smoothstep(uSurfaceY, uSurfaceY - 0.015, p.y);
}
`;

const bubbleFragment = /* glsl */ `
uniform vec3 uLightColor;
varying float vShown;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  // A bubble is mostly see-through: a bright rim where light bends around its edge, and a glint.
  float rim = smoothstep(0.3, 0.46, d) * (1.0 - smoothstep(0.46, 0.5, d));
  float glint = smoothstep(0.12, 0.0, length(c - vec2(-0.15, -0.15)));
  float body = 0.06;
  float a = clamp(rim * 0.8 + glint + body, 0.0, 1.0) * vShown;
  gl_FragColor = vec4(uLightColor * (rim * 0.9 + glint * 1.2 + body) * vShown, a);
}
`;

function randoms(count: number) {
  const values = new Float32Array(count * 3);
  for (let i = 0; i < values.length; i++) values[i] = Math.random();
  return values;
}

function particles(count: number) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aRandom", new BufferAttribute(randoms(count), 3));
  return geometry;
}

export function createInk(parts: LookParts): Look {
  const uniforms = parts.scene.uniforms;
  const surface = lookSurface(parts);
  const mouthPoints = openings(parts.data).mouth;
  const facePoints = new FacePoints(parts);

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
  const surfaceY = { value: 0.135 };
  const thickness = { value: 2 };
  // See-through materials whose colors are already multiplied by their opacity.
  const layered = { transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false };

  // 1. Where the face gives off ink.
  const sourceMaterial = createLookMaterial(uniforms, sourceFragment, {
    uEdgeInk: { value: 1 },
    uRimInk: { value: 1 },
    uFeatureInk: { value: 1 },
    uFaceInk: { value: 0 },
    uAmount: { value: 0 },
  });
  const sourceScene = new Scene();
  const sourceMesh = new Mesh(surface, sourceMaterial);
  sourceMesh.frustumCulled = false;
  sourceScene.add(sourceMesh);

  // 2. The water's state, fed back into itself.
  const state = new Pass(
    new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: waterStateFragment,
      uniforms: {
        uPrev: { value: null },
        uSource: { value: null },
        uTexel: { value: new Vector2() },
        uPointer: { value: new Vector2(-1, -1) },
        uPointerVelocity: { value: new Vector2() },
        uMouth: { value: new Vector2(-1, -1) },
        uClicks: { value: [new Vector3(0, 0, -1), new Vector3(0, 0, -1), new Vector3(0, 0, -1)] },
        uAspect: { value: 1 },
        uDt: { value: 0 },
        uTime: uniforms.uTime,
        uSwirl: { value: 0 },
        uSwirlSize: { value: 1 },
        uSwirlSpeed: { value: 1 },
        uDrift: { value: 0 },
        uMomentum: { value: 1 },
        uFade: { value: 1 },
        uSoftness: { value: 1 },
        uPointerStir: { value: 0 },
        uClickPush: { value: 0 },
        uPuff: { value: 0 },
        uMouthRadius: { value: 0.05 },
        uSurfaceLine: { value: 0.9 },
        uCenterX: { value: 0.5 },
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  let pictures: { source: WebGLRenderTarget; a: WebGLRenderTarget; b: WebGLRenderTarget } | undefined;
  let pictureKey = "";

  // 3. On screen, back to front.
  const waterMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: waterFragment,
    uniforms: {
      ...camera,
      ...colors,
      uState: { value: null },
      uSource: { value: null },
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

  const faceMaterial = createLookMaterial(
    uniforms,
    faceFragment,
    { ...colors, ...light, uFaceShow: { value: 0.5 }, uFaceLight: { value: 1 } },
    { ...layered, depthWrite: true },
  );
  const face = new Mesh(surface, faceMaterial);
  face.frustumCulled = false;
  face.renderOrder = 1;

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
  const speckGeometry = particles(SPECK_COUNT);
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

  const bubbleGeometry = particles(BUBBLE_COUNT);
  const bubbleMaterial = new ShaderMaterial({
    vertexShader: bubbleVertex,
    fragmentShader: bubbleFragment,
    uniforms: {
      ...colors,
      uFacePoints: { value: facePoints.texture },
      uFaceCount: { value: facePoints.count },
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uHead: uniforms.uHead,
      uSize: { value: 1 },
      uSpeech: { value: 0 },
      uTrickle: { value: 0 },
      uSurfaceY: surfaceY,
      uMouth: { value: new Vector3() },
      uMouthSize: { value: 0.02 },
    },
    ...layered,
  });
  const bubbles = new Points(bubbleGeometry, bubbleMaterial);
  bubbles.frustumCulled = false;
  bubbles.renderOrder = 4;

  const object = new Group();
  object.add(water, face, ink, specks, bubbles);

  const pointer = { uv: new Vector2(-1, -1), velocity: new Vector2(), seen: false };
  const scratch = {
    v: new Vector3(),
    edge: new Vector3(),
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
    pictures = { source: hiddenPicture(w, h), a: hiddenPicture(w, h), b: hiddenPicture(w, h) };
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

      // The mouth: its middle (turned with the head) and size on screen, for the voice's puffs.
      scratch.v.set(0, 0, 0);
      for (const i of mouthPoints) scratch.v.add(scratch.edge.fromArray(frame.positions, i * 3));
      scratch.v.divideScalar(Math.max(1, mouthPoints.length));
      let mouthSize = 0;
      for (const i of mouthPoints) mouthSize = Math.max(mouthSize, scratch.edge.fromArray(frame.positions, i * 3).distanceTo(scratch.v));
      scratch.v.applyMatrix4(frame.headMatrix);
      const su = state.material.uniforms;
      const mouthUv = screenUv(scratch.v, cam, scratch.uv);
      su.uMouth.value.copy(mouthUv);
      screenUv(scratch.edge.copy(scratch.v).setX(scratch.v.x + Math.max(mouthSize, 0.01) * 0.7), cam, scratch.other);
      su.uMouthRadius.value = Math.abs(scratch.other.x - mouthUv.x) * aspect;
      bubbleMaterial.uniforms.uMouth.value.copy(scratch.v);
      bubbleMaterial.uniforms.uMouthSize.value = Math.max(mouthSize, 0.01) * 1.2;

      // Where the surface meets the face's plane on screen, and the face's middle.
      su.uSurfaceLine.value = screenUv(scratch.edge.set(0, f.surfaceHeight, 0), cam, scratch.other).y;
      const center = screenUv(scratch.edge.set(0, 0, 0).applyMatrix4(frame.headMatrix), cam, scratch.other);
      su.uCenterX.value = center.x;
      waterMaterial.uniforms.uCenter.value.copy(center);

      // Clicks: the face's ripples (Face.tsx) start where a click lands; each sends out a pulse.
      uniforms.uRipples.value.forEach((r, i) => {
        const age = frame.now - r.w;
        const slot = su.uClicks.value[i];
        if (r.w < 0 || age < 0 || age > CLICK_SECONDS) slot.set(0, 0, -1);
        else {
          const at = screenUv(scratch.edge.set(r.x, r.y, r.z).applyMatrix4(frame.headMatrix), cam, scratch.other);
          slot.set(at.x, at.y, age);
        }
      });

      // 1. Where the face gives off ink.
      facePoints.update(frame.positions);
      const ou = sourceMaterial.uniforms;
      ou.uEdgeInk.value = f.edgeInk;
      ou.uRimInk.value = f.rimInk;
      ou.uFeatureInk.value = f.featureInk;
      ou.uFaceInk.value = f.faceInk;
      ou.uAmount.value = f.amount * frame.intro * frame.brightness;
      gl.setRenderTarget(p.source);
      gl.clear();
      gl.render(sourceScene, cam);

      // 2. The water's state: read one picture, write the other, then swap.
      su.uPrev.value = p.a.texture;
      su.uSource.value = p.source.texture;
      su.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      su.uPointer.value.copy(pointer.uv);
      su.uPointerVelocity.value.copy(pointer.velocity);
      su.uAspect.value = aspect;
      su.uDt.value = dt;
      su.uSwirl.value = f.swirl;
      su.uSwirlSize.value = f.swirlSize;
      su.uSwirlSpeed.value = f.swirlSpeed * calm;
      su.uDrift.value = f.drift * calm;
      su.uMomentum.value = f.momentum;
      su.uFade.value = f.fade;
      su.uSoftness.value = f.softness;
      su.uPointerStir.value = f.pointerStir;
      su.uClickPush.value = f.clickPush;
      su.uPuff.value = f.puff * frame.loudness;
      state.render(gl, p.b);
      [p.a, p.b] = [p.b, p.a];
      gl.setRenderTarget(null);
      gl.setClearColor(scratch.clear, clearAlpha);

      // 3. On screen.
      const wu = waterMaterial.uniforms;
      wu.uState.value = p.a.texture;
      wu.uSource.value = p.source.texture;
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

      faceMaterial.uniforms.uFaceShow.value = f.faceShow * frame.intro;
      faceMaterial.uniforms.uFaceLight.value = f.faceLight * frame.brightness;

      const iu = inkMaterial.uniforms;
      iu.uState.value = p.a.texture;
      iu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      iu.uBillow.value = f.billow;
      iu.uGlow.value = f.glow;

      speckMaterial.uniforms.uShare.value = f.specks;
      speckMaterial.uniforms.uSize.value = f.speckSize;
      const bu = bubbleMaterial.uniforms;
      bu.uSize.value = f.bubbleSize;
      bu.uSpeech.value = frame.reduced ? 0 : Math.min(1, frame.loudness * f.bubbles * 0.8);
      bu.uTrickle.value = frame.reduced ? 0 : f.bubbles * 0.02;

      // Eyes: bright rings, in the ink's color.
      eyes.glow = f.eyeGlow * frame.intro;
      eyes.color.copy(colors.uInkColor.value).lerp(colors.uTint.value, colors.uTintAmount.value);
    },
    dispose() {
      if (pictures) for (const t of Object.values(pictures)) t.dispose();
      state.dispose();
      sourceMaterial.dispose();
      for (const m of [water, ink]) m.geometry.dispose();
      for (const m of [waterMaterial, faceMaterial, inkMaterial, speckMaterial, bubbleMaterial]) m.dispose();
      speckGeometry.dispose();
      bubbleGeometry.dispose();
      facePoints.dispose();
    },
  };
}

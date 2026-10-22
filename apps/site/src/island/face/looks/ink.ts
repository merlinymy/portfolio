/**
 * The ink-in-water look (docs/face-looks-plan.md, "Ink in water"): your face sculpted out of ink,
 * seen underwater. The face keeps its shape and is lit like a sculpture, with thicker and thinner
 * ink swirled across it. From the outline inward it frays and breaks up, and the broken edge peels
 * away in wisps that unfurl into the water, the way ink does when it's dropped into water. The
 * camera sits just below the surface, which shows along the top from underneath, mirroring the
 * face and wisps, with light shafts, caustics and drifting specks.
 *
 * Each frame:
 * 1. The face is drawn into a hidden picture of what it sheds: ink where its edge is breaking up,
 *    the direction to push that ink (outward, off the face), and where the face still holds.
 * 2. The water's state (wisp ink, how fresh it is, and the water's movement) is moved along the
 *    water's own current in two steps. A first guess, then a correction: the guess is sent back
 *    the other way and half the difference fixed, within the range it came from. That keeps fine
 *    wisps crisp, where moving once would blur them a little every frame.
 * 3. On screen: the water and its surface, the ink face, the wisps, then the specks.
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
  type Texture,
  Vector2,
  Vector3,
  Vector4,
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

/**
 * The ink the face is made of, shared by the face on screen and the picture of what it sheds, so
 * the two always agree on where it has broken up.
 */
const faceInk = /* glsl */ `
uniform float uTime, uFlowSize, uFlowSpeed, uMarbling, uStreaks, uStrands;
uniform float uDissolve, uDissolveTop, uDissolveSide, uEdgeSoftness;
// The face's middle and half its width and height, before the head turns.
uniform vec4 uFaceBox;
varying vec3 vNormal, vView, vFace;
varying float vExpressive, vEdge, vExtra;
${noise}
float fbm3(vec3 p) {
  return snoise(p) * 0.57 + snoise(p * 2.03 + vec3(1.7, 9.2, 3.1)) * 0.29 + snoise(p * 4.12 + vec3(8.3, 2.8, 4.4)) * 0.14;
}
struct Ink {
  float density; // how much ink: thicker and thinner swirls, brighter along the strands
  float streak;  // 1 along a strand's thin line
  float strand;  // the strand pattern, roughly -1 to 1
  float keep;    // 1 where the face holds together, 0 where it has broken up into the water
  float fringe;  // 1 just past the broken edge, where ink is peeling away
};
Ink faceInk() {
  Ink ink;
  float t = uTime * uFlowSpeed * 0.12;
  vec3 p = vFace * 18.0 * uFlowSize;
  // Swirled ink: soft clouds of thicker and thinner ink, bent by more noise the way ink folds into
  // itself.
  vec3 q = p + vec3(0.0, 0.0, t);
  vec2 warp = vec2(snoise(q * 0.6), snoise(q * 0.6 + vec3(5.2, 1.3, 2.8)));
  float field = fbm3(vec3(p.xy * 0.5 + warp * 1.2, t * 0.7 + 3.0));

  // Strands: noise stretched outward from the face's middle, so the edge breaks into strands that
  // stream away like hair or smoke. Picked by direction, so there's no seam all the way round.
  vec2 f = (vFace.xy - uFaceBox.xy) / uFaceBox.zw;
  float r = length(f);
  vec2 around = f / max(r, 1e-3);
  vec3 s = vec3(around * uStrands + warp * 0.35, r * 1.6 - t * 2.5);
  ink.strand = snoise(s) * 0.7 + snoise(s * 2.1 + vec3(3.7, 1.1, 6.3)) * 0.3;

  // How broken up each spot is: most at the outline, and more toward the top or one side if asked.
  float reach = r + max(f.y, 0.0) * uDissolveTop + f.x * uDissolveSide * 0.5;
  float d = max(smoothstep(1.0 - uDissolve, 1.15, reach), vExtra * vExtra * min(uDissolve * 4.0, 1.0));
  // Strand lines show only where the face is breaking up. The ink thins out toward the edge.
  ink.streak = pow(1.0 - abs(ink.strand), 9.0) * d * d;
  ink.density = mix(1.0, 0.55 + 0.6 * smoothstep(-0.5, 0.5, field), uMarbling) * (1.0 - d * 0.6) + ink.streak * uStreaks;
  // The broken edge follows the swirls, and the strands a little, so it billows rather than
  // cutting clean.
  float e = clamp(0.5 + 0.5 * (ink.strand * 0.15 + field * 0.85), 0.0, 1.0);
  float cut = d * 1.2 - 0.12;
  // The scan's own outline always fades away, whatever the dissolve, so its edge never shows.
  float outline = smoothstep(0.9, 0.2, vExtra);
  ink.keep = smoothstep(cut, cut + uEdgeSoftness, e) * outline;
  ink.fringe = smoothstep(cut - 0.4, cut, e) * (1.0 - smoothstep(cut, cut + uEdgeSoftness, e)) * smoothstep(0.0, 0.3, d) * outline;
  return ink;
}
`;

/** Step 1: what the face sheds into the water, and which way. */
const shedFragment = /* glsl */ `
uniform float uSurfaceShed, uPush;
${faceInk}
void main() {
  Ink ink = faceInk();
  vec3 n = normalize(vNormal);
  if (dot(n, normalize(-vView)) < 0.0) n = -n;
  // Ink peels off in fine streaks along the strands, not as one sheet, so the water draws it out
  // into thin wisps.
  float strands = smoothstep(-0.2, 0.6, ink.strand);
  vec2 f = (vFace.xy - uFaceBox.xy) / uFaceBox.zw;
  float r = length(f);
  float fine = snoise(vec3(f / max(r, 1e-3) * uStrands * 4.0, r * 6.0 - uTime * uFlowSpeed * 0.9));
  float shed = ink.fringe * smoothstep(0.0, 0.7, fine) * (0.3 + strands) + ink.keep * ink.streak * uSurfaceShed;
  // Ink peels away along the surface's direction on screen: outward at the face's edges, barely at
  // all in the middle, where the face looks straight at you. Strands go faster than the gaps
  // between them, which draws them out into tendrils.
  gl_FragColor = vec4(shed, ink.keep, n.xy * uPush * (0.4 + strands));
}
`;

/** The face on screen: ink lit like a sculpture, fraying into the water from the outline in. */
const faceFragment = /* glsl */ `
uniform float uSolid, uShow, uContrast, uFill, uRim, uHollows, uCaustics, uCausticSize, uCausticSpeed, uTintAmount;
uniform vec3 uLightDirection, uInkColor, uLightColor, uTint;
${faceInk}
${caustics}
void main() {
  Ink ink = faceInk();
  float alpha = ink.keep * uSolid * uShow * clamp(0.55 + 0.45 * ink.density, 0.0, 1.0);
  if (alpha < 0.004) discard;
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  if (dot(n, v) < 0.0) n = -n;
  // A soft main light shapes the face; the water's own light fills the shadows from below, and a
  // rim of it outlines the face where it turns away.
  float key = pow(max(dot(n, uLightDirection), 0.0), uContrast);
  float fill = (0.55 - 0.45 * n.y) * uFill;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * uRim;
  float hollow = 1.0 - vEdge * uHollows;
  vec3 color = mix(uInkColor, uTint, uTintAmount);
  // Caustics dance over the parts that face up toward the surface.
  float c = caustic(vec2(vView.x, vView.y * 0.8 + vView.z * 0.5) * 28.0 * uCausticSize, uTime * 0.5 * uCausticSpeed);
  vec3 lit = color * (0.02 + key) * ink.density * (1.0 + c * uCaustics * 0.6 * clamp(n.y + 0.4, 0.0, 1.0));
  lit = (lit + uLightColor * fill * 0.3 * ink.density) * hollow + uLightColor * rim * 0.5;
  gl_FragColor = vec4((1.0 - exp(-lit * 1.25)) * alpha, alpha);
}
`;

/** Step 2a: the first guess at where everything moves, and the water's new movement. */
const moveFragment = /* glsl */ `
uniform sampler2D uState, uShed;
uniform vec2 uTexel, uPointer, uPointerVelocity, uMouth, uCenter;
uniform vec3 uClicks[3];
uniform float uAspect, uDt, uTime, uSwirl, uSwirlSize, uSwirlSpeed, uDrift, uSpread, uMomentum, uSoftness;
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

  // The current: two sizes of swirl (eddies and fine wisps), the push off the face, the wisps
  // unfurling outward, and an optional drift up or down.
  vec2 c = q - vec2(uCenter.x * uAspect, uCenter.y);
  vec2 current = (curl(q * uSwirlSize, uTime * uSwirlSpeed * 0.2)
    + curl(q * uSwirlSize * 2.7 + 3.1, uTime * uSwirlSpeed * 0.33) * 0.4) * uSwirl * 0.025;
  current += texture2D(uShed, vUv).ba * 0.08;
  current += c * uSpread + vec2(0.0, uDrift);
  // Just under the surface, water moving up turns and spreads sideways, away from the middle. The
  // turn eases across the middle, so the two sides don't tear apart there.
  float under = smoothstep(uSurfaceLine - 0.08, uSurfaceLine, vUv.y);
  current.x += c.x / (abs(c.x) + 0.08) * under * max(current.y, 0.0);
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
  v += normalize(m + 1e-5) * mouth * uPuff * 1.2 * uDt;
  gl_FragColor = vec4(carried, clamp(v, -0.6, 0.6));
}
`;

/** Step 2b: correct the guess, fade, then add the ink the face sheds. */
const settleFragment = /* glsl */ `
uniform sampler2D uState, uGuess, uShed;
uniform vec2 uTexel, uMouth;
uniform float uAspect, uDt, uSharpness, uFade, uShedRate, uPuff, uMouthRadius;
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
  ink = max(ink, mouth * uPuff * 0.4);
  fresh = max(fresh, mouth * min(uPuff, 1.0));
  // Fresh ink peels off the face's broken edge. It tops the ink up to what's shed rather than
  // adding to it, so ink lingering at the edge never piles up into a solid sheet.
  float shed = texture2D(uShed, vUv).r;
  ink = max(ink, shed * uShedRate);
  fresh = max(fresh, clamp(shed * 2.0, 0.0, 1.0));
  gl_FragColor = vec4(ink, fresh, guess.ba);
}
`;

const waterFragment = /* glsl */ `
uniform sampler2D uState, uShed;
uniform mat4 uViewProjection;
uniform float uTime, uSurfaceY, uReach, uWaveSize, uWaveSpeed, uWaveTilt, uShimmer, uMirror;
uniform float uShafts, uShaftSpeed, uThickness, uAspect, uSpread, uSolid;
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
      // What the mirror shows: the face and wisps where the bounced ray meets the face's plane.
      vec3 seen = hit + bounce * (-hit.z / bounce.z);
      vec4 clip = uViewProjection * vec4(seen, 1.0);
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
        float shown = max(1.0 - exp(-texture2D(uState, uv).r * uThickness), texture2D(uShed, uv).g * uSolid * 0.6);
        mirror += uInkColor * shown * 0.75;
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

const wispFragment = /* glsl */ `
uniform sampler2D uState, uShed;
uniform vec2 uTexel;
uniform float uTime, uThickness, uBillow, uGlow, uVeil, uSolid, uCaustics, uCausticSize, uCausticSpeed, uTintAmount;
uniform vec3 uInkColor, uTint;
varying vec2 vUv;
${noise}
${caustics}
${viewRay}
void main() {
  vec4 state = texture2D(uState, vUv);
  float ink = state.r;
  // Light from the surface passes through the ink above each spot first: the more ink in the way,
  // the darker the spot. That rounds the wisps, lit where the light reaches them and shadowed
  // inside, the way smoke and ink look.
  vec2 toLight = normalize(vec2(-0.25, 1.0)) * uTexel * 5.0;
  float between = 0.0;
  for (int i = 1; i <= 4; i++) between += texture2D(uState, vUv + toLight * float(i)).r;
  float light = exp(-between * uBillow * 0.5);
  // Caustics where the ink is, at the face's plane.
  vec3 dir = viewRay(vUv);
  vec3 w = uCameraPosition + dir * (-uCameraPosition.z / dir.z);
  float c = caustic(w.xy * 28.0 * uCausticSize, uTime * 0.5 * uCausticSpeed);
  vec3 color = mix(uInkColor, uTint, uTintAmount);
  // Thin ink is see-through; overlapping wisps add up.
  float cover = 1.0 - exp(-ink * uThickness);
  vec3 lit = color * (0.25 + 0.95 * light) * (1.0 + c * uCaustics * 0.35);
  // The thinnest wisps cool toward the water's blue; fresh ink is the brightest.
  lit = mix(lit * vec3(0.6, 0.72, 0.92), lit, smoothstep(0.02, 0.5, cover)) * (0.8 + 0.4 * state.g);
  float glow = 0.0;
  for (int i = 0; i < 6; i++) {
    float a = float(i) * 1.0472;
    glow += texture2D(uState, vUv + vec2(cos(a), sin(a)) * uTexel * 12.0).r;
  }
  glow = 1.0 - exp(-glow / 6.0 * uThickness);
  // Over the face, only "wisps in front" of them show; the rest drift behind it.
  float front = mix(1.0, uVeil, texture2D(uShed, vUv).g * uSolid);
  vec3 shown = (lit * cover + color * glow * uGlow * 0.25) * front;
  float alpha = clamp(cover * 0.9 + glow * uGlow * 0.05, 0.0, 1.0) * front;
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

/** The face's middle and half its width and height, before the head turns. */
function faceBox(base: Float32Array) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < base.length; i += 3) {
    minX = Math.min(minX, base[i]);
    maxX = Math.max(maxX, base[i]);
    minY = Math.min(minY, base[i + 1]);
    maxY = Math.max(maxY, base[i + 1]);
  }
  return new Vector4((minX + maxX) / 2, (minY + maxY) / 2, Math.max((maxX - minX) / 2, 1e-4), Math.max((maxY - minY) / 2, 1e-4));
}

export function createInk(parts: LookParts): Look {
  const uniforms = parts.scene.uniforms;
  const surface = lookSurface(parts);
  // The outline always breaks up; the eyes and lips sink into shadow.
  const holes = openings(parts.data);
  surface.setAttribute("aExtra", new BufferAttribute(ringWeights(parts.data, holes.outline, 5), 1));
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
  // The face's ink, the same in the face on screen and in the picture of what it sheds.
  const ink = {
    uFlowSize: { value: 1 },
    uFlowSpeed: { value: 1 },
    uMarbling: { value: 0 },
    uStreaks: { value: 0 },
    uStrands: { value: 6 },
    uDissolve: { value: 0 },
    uDissolveTop: { value: 0 },
    uDissolveSide: { value: 0 },
    uEdgeSoftness: { value: 0.1 },
    uFaceBox: { value: faceBox(parts.data.base) },
  };
  const solid = { value: 1 };
  const surfaceY = { value: 0.155 };
  const thickness = { value: 1 };
  const mouthAt = { uMouth: { value: new Vector2(-1, -1) }, uMouthRadius: { value: 0.05 } };
  const puff = { value: 0 };
  const shedPicture = { value: null as Texture | null };
  // See-through materials whose colors are already multiplied by their opacity.
  const layered = { transparent: true, premultipliedAlpha: true, blending: NormalBlending, depthWrite: false };

  // 1. What the face sheds.
  const shedMaterial = createLookMaterial(uniforms, shedFragment, {
    ...ink,
    uSurfaceShed: { value: 0 },
    uPush: { value: 1 },
  });
  const shedScene = new Scene();
  const shedMesh = new Mesh(surface, shedMaterial);
  shedMesh.frustumCulled = false;
  shedScene.add(shedMesh);

  // 2. The water's state, moved in two steps.
  const move = new Pass(
    new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: moveFragment,
      uniforms: {
        ...mouthAt,
        uState: { value: null },
        uShed: shedPicture,
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
        uShed: shedPicture,
        uTexel: { value: new Vector2() },
        uAspect: { value: 1 },
        uDt: { value: 0 },
        uSharpness: { value: 1 },
        uFade: { value: 1 },
        uShedRate: { value: 0 },
        uPuff: puff,
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  let pictures: { shed: WebGLRenderTarget; guess: WebGLRenderTarget; a: WebGLRenderTarget; b: WebGLRenderTarget } | undefined;
  let pictureKey = "";

  // 3. On screen, back to front.
  const waterMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: waterFragment,
    uniforms: {
      ...camera,
      ...colors,
      uState: { value: null },
      uShed: shedPicture,
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
      uSolid: solid,
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
    {
      ...ink,
      ...colors,
      ...light,
      uSolid: solid,
      uShow: { value: 0 },
      uContrast: { value: 1 },
      uFill: { value: 0 },
      uRim: { value: 0 },
      uHollows: { value: 0 },
      uLightDirection: { value: new Vector3(0, 0, 1) },
    },
    { transparent: true, premultipliedAlpha: true, blending: NormalBlending },
  );
  const face = new Mesh(surface, faceMaterial);
  face.frustumCulled = false;
  face.renderOrder = 1;

  const wispMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: wispFragment,
    uniforms: {
      ...camera,
      ...colors,
      ...light,
      uState: { value: null },
      uShed: shedPicture,
      uTexel: { value: new Vector2() },
      uTime: uniforms.uTime,
      uThickness: thickness,
      uBillow: { value: 1 },
      uGlow: { value: 0 },
      uVeil: { value: 0 },
      uSolid: solid,
    },
    ...layered,
    depthTest: false,
  });
  const wisps = fullscreen(wispMaterial);
  wisps.renderOrder = 2;

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
  object.add(water, face, wisps, specks);

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
    pictures = { shed: hiddenPicture(w, h), guess: hiddenPicture(w, h), a: hiddenPicture(w, h), b: hiddenPicture(w, h) };
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
      ink.uFlowSize.value = f.flowSize;
      ink.uFlowSpeed.value = f.flowSpeed * calm;
      ink.uMarbling.value = f.marbling;
      ink.uStreaks.value = f.streaks;
      ink.uStrands.value = f.strands;
      ink.uDissolve.value = f.dissolve;
      ink.uDissolveTop.value = f.dissolveTop;
      ink.uDissolveSide.value = f.dissolveSide;
      ink.uEdgeSoftness.value = f.edgeSoftness;
      solid.value = f.solid;
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

      // 1. What the face sheds.
      const su = shedMaterial.uniforms;
      su.uSurfaceShed.value = f.surfaceShed;
      su.uPush.value = f.push * calm;
      gl.setRenderTarget(p.shed);
      gl.clear();
      gl.render(shedScene, cam);
      shedPicture.value = p.shed.texture;

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
      mu.uMomentum.value = f.momentum;
      mu.uSoftness.value = f.softness;
      mu.uPointerStir.value = f.pointerStir;
      mu.uClickPush.value = f.clickPush;
      move.render(gl, p.guess);
      const tu = settle.material.uniforms;
      tu.uState.value = p.a.texture;
      tu.uGuess.value = p.guess.texture;
      tu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      tu.uAspect.value = aspect;
      tu.uDt.value = dt;
      tu.uSharpness.value = f.sharpness;
      tu.uFade.value = f.fade;
      tu.uShedRate.value = f.shed * frame.intro * frame.brightness;
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

      const fu = faceMaterial.uniforms;
      fu.uShow.value = frame.intro * Math.min(frame.brightness, 1);
      fu.uContrast.value = f.contrast;
      fu.uFill.value = f.fill;
      fu.uRim.value = f.rim;
      fu.uHollows.value = f.hollows;
      const above = f.lightAbove * DEG;
      const side = f.lightSide * DEG;
      fu.uLightDirection.value.set(Math.sin(side) * Math.cos(above), Math.sin(above), Math.cos(side) * Math.cos(above));

      const iu = wispMaterial.uniforms;
      iu.uState.value = p.a.texture;
      iu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      iu.uBillow.value = f.billow;
      iu.uGlow.value = f.glow;
      iu.uVeil.value = f.veil;

      speckMaterial.uniforms.uShare.value = f.specks;
      speckMaterial.uniforms.uSize.value = f.speckSize;

      // Eye rings are off unless asked for: the shading draws the eyes.
      eyes.glow = f.eyeGlow * frame.intro;
      eyes.color.copy(colors.uInkColor.value).lerp(colors.uTint.value, colors.uTintAmount.value);
    },
    dispose() {
      if (pictures) for (const t of Object.values(pictures)) t.dispose();
      move.dispose();
      settle.dispose();
      for (const m of [shedMaterial, faceMaterial, waterMaterial, wispMaterial, speckMaterial]) m.dispose();
      for (const m of [water, wisps]) m.geometry.dispose();
      speckGeometry.dispose();
    },
  };
}

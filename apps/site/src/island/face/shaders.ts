/**
 * The graphics-chip side of the face (plan §5.3, §5.6): every effect runs here, on top of the
 * expression-mixed positions the CPU uploads each frame. Points, lines and eye rings share one
 * vertex shader and one set of uniforms, so they always move together.
 */
import { AdditiveBlending, Color, ShaderMaterial, Vector3, Vector4 } from "three";

export function createUniforms() {
  return {
    uTime: { value: 0 },
    /** Drawing-buffer pixels per meter at one meter away, for sizing points. */
    uScale: { value: 1000 },
    /** Point diameter in meters. */
    uSize: { value: 0.0011 },
    uColor: { value: new Color() },
    uGlitchColor: { value: new Color("#ff3b3b") },
    uBrightness: { value: 1 },
    uWind: { value: 0 },
    uWindSpeed: { value: 1 },
    /** Up to three ripples: origin in face space (xyz) and start time (w, negative when unused). */
    uRipples: { value: [new Vector4(0, 0, 0, -1), new Vector4(0, 0, 0, -1), new Vector4(0, 0, 0, -1)] },
    uRipple: { value: 0 },
    uRippleSpeed: { value: 1 },
    uSweep: { value: 0 },
    uSweepSpeed: { value: 1 },
    uPulse: { value: 0 },
    uGlitch: { value: 0 },
    uGlitchSpeed: { value: 1 },
    uDust: { value: 0 },
    uBreath: { value: 0 },
    uBreathSpeed: { value: 1 },
    uScan: { value: 0 },
    uScanSpeed: { value: 1 },
    uMagnetPos: { value: new Vector3() },
    uMagnet: { value: 0 },
    uDepth: { value: 0 },
    uShimmer: { value: 0 },
    uShimmerSpeed: { value: 1 },
    uTwinkle: { value: 0 },
    uTwinkleSpeed: { value: 1 },
    /** 0 while the points are scattered, 1 once the face has assembled. */
    uAssemble: { value: 1 },
  };
}
export type FaceUniforms = ReturnType<typeof createUniforms>;

const vertexShader = /* glsl */ `
uniform float uTime, uScale, uSize, uBrightness, uOpacity, uSizeScale, uGain;
uniform vec3 uColor, uGlitchColor;
uniform float uWind, uWindSpeed;
uniform vec4 uRipples[3];
uniform float uRipple, uRippleSpeed;
uniform float uSweep, uSweepSpeed;
uniform float uPulse;
uniform float uGlitch, uGlitchSpeed;
uniform float uDust;
uniform float uBreath, uBreathSpeed;
uniform float uScan, uScanSpeed;
uniform vec3 uMagnetPos;
uniform float uMagnet;
uniform float uDepth;
uniform float uShimmer, uShimmerSpeed;
uniform float uTwinkle, uTwinkleSpeed;
uniform float uAssemble;

attribute float aSeed;     // random 0-1 per vertex
attribute vec3 aScatter;   // random offset, for dust and the intro
attribute float aFade;     // 1, or less for eye rings behind a closing eyelid

varying vec3 vColor;
varying float vAlpha;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec3 p = position;
  // Outward from the middle of the head, for pushing points off the surface.
  vec3 n = normalize(position - vec3(0.0, 0.0, -0.04));
  float glow = 0.0;
  float alpha = aFade;
  float red = 0.0;
  float t = uTime;

  if (uWind > 0.0) {
    float s = t * uWindSpeed;
    p += vec3(
      sin(position.y * 38.0 + s * 1.3 + aSeed * 6.283),
      sin(position.x * 33.0 + s * 1.1 + aSeed * 3.1),
      sin((position.x + position.y) * 29.0 + s * 0.9)
    ) * 0.0012 * uWind;
  }

  for (int i = 0; i < 3; i++) {
    vec4 r = uRipples[i];
    float age = t - r.w;
    if (r.w >= 0.0 && age >= 0.0 && age < 3.0) {
      float x = distance(position, r.xyz) - age * 0.11 * uRippleSpeed;
      float wave = sin(x * 220.0) * exp(-x * x * 3000.0) * exp(-age * 1.2);
      p += n * wave * 0.004 * uRipple;
      glow += abs(wave) * uRipple;
    }
  }

  if (uSweep > 0.0) {
    float y = -0.11 + fract(t * 0.35 * uSweepSpeed) * 0.24;
    float b = exp(-pow((position.y - y) / 0.012, 2.0));
    p += n * b * 0.0025 * uSweep;
    glow += b * uSweep * 0.9;
  }

  p += n * uPulse * 0.003;
  glow += uPulse * 0.6;

  if (uGlitch > 0.0) {
    float tick = floor(t * 14.0 * uGlitchSpeed);
    float band = floor(position.y * 70.0);
    float r = hash(band * 7.13 + tick * 1.71);
    float tear = step(0.82, r) * (r - 0.82) / 0.18;
    p.x += (hash(band + tick) - 0.5) * 0.05 * tear * uGlitch;
    red = clamp(0.35 * uGlitch + tear * uGlitch, 0.0, 1.0);
  }

  if (uMagnet != 0.0) {
    vec2 d = position.xy - uMagnetPos.xy;
    float f = exp(-dot(d, d) / 0.0009);
    p.xy += normalize(d + 1e-5) * f * 0.012 * uMagnet;
    glow += f * abs(uMagnet) * 0.4;
  }

  float breath = 1.0 + uBreath * 0.45 * sin(t * 1.1 * uBreathSpeed);
  p += n * uBreath * 0.0006 * sin(t * 1.1 * uBreathSpeed);

  if (uScan > 0.0) {
    float y = 0.11 - fract(t * 0.25 * uScanSpeed) * 0.24;
    glow += exp(-pow((position.y - y) / 0.004, 2.0)) * uScan * 2.0;
  }

  alpha *= mix(1.0, 0.25 + 0.75 * smoothstep(-0.02, 0.06, position.z), uDepth);

#ifdef POINTS
  float twinkle = step(0.97, hash(aSeed * 91.7 + floor(t * 2.5 * uTwinkleSpeed + aSeed * 13.0)));
  glow += twinkle * uTwinkle * 2.0;
#endif
#ifdef LINES
  alpha *= 1.0 - uShimmer * 0.7 * (0.5 + 0.5 * sin(t * 7.0 * uShimmerSpeed + aSeed * 40.0));
#endif

  if (uDust > 0.0) {
    float k = clamp(uDust * 1.5 - aSeed * 0.5, 0.0, 1.0);
    k *= k;
    // Drifts up and to the side, but stays in view: the face stays scattered while locked.
    p += (aScatter * 0.08 + vec3(0.04, 0.03, 0.0)) * k;
    alpha *= 1.0 - k * 0.4;
#ifdef LINES
    // Lines between scattered points would draw a tangled web, so they fade out entirely.
    alpha *= 1.0 - k;
#endif
  }

  if (uAssemble < 1.0) {
    float k = clamp(uAssemble * 1.4 - aSeed * 0.4, 0.0, 1.0);
    k = 1.0 - pow(1.0 - k, 3.0);
    p = mix(aScatter * 0.35, p, k);
    alpha *= k;
#ifdef LINES
    // Lines appear only as the points arrive, for the same reason.
    alpha *= k * k * k;
#endif
  }

  vColor = mix(uColor, uGlitchColor, red) * uBrightness * uGain * breath * (1.0 + glow);
  vAlpha = alpha * uOpacity;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
#ifdef POINTS
  gl_PointSize = max(1.5, uSize * uSizeScale * uScale / -mv.z);
#endif
}
`;

const pointFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.5, 0.15, d));
}
`;

const lineFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/**
 * A material for points or lines. Each gets its own opacity, size and brightness (so the eye rings
 * can stand out); every other uniform is shared.
 */
export function createMaterial(uniforms: FaceUniforms, kind: "points" | "lines", opacity: number) {
  return new ShaderMaterial({
    uniforms: { ...uniforms, uOpacity: { value: opacity }, uSizeScale: { value: 1 }, uGain: { value: 1 } },
    vertexShader,
    fragmentShader: kind === "points" ? pointFragment : lineFragment,
    defines: kind === "points" ? { POINTS: "" } : { LINES: "" },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

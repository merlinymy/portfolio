/**
 * The graphics-chip side of the face (plan §5.3, §5.6): every effect runs here, on top of the
 * expression-mixed positions the CPU uploads each frame. Points, lines and eye rings share one
 * vertex shader and one set of uniforms, so they always move together.
 */
import { AdditiveBlending, Color, DoubleSide, Matrix4, NormalBlending, ShaderMaterial, Vector2, Vector3, Vector4 } from "three";

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
    /** The camera's distance to the face, so depth fade measures from the face's front. */
    uDepthCenter: { value: 0.5 },
    uShimmer: { value: 0 },
    uShimmerSpeed: { value: 1 },
    uTwinkle: { value: 0 },
    uTwinkleSpeed: { value: 1 },
    /** 0 while the points are scattered, 1 once the face has assembled. */
    uAssemble: { value: 1 },
    /** The head's turn about the top of the neck, applied by each point's aHeadWeight. */
    uHead: { value: new Matrix4() },
    uPivot: { value: new Vector3() },
    /** How far the hair's ends trail the head's turn: pitch (x) and yaw (y), in radians. */
    uLag: { value: new Vector2() },
    uHairSway: { value: 0 },
  };
}
export type FaceUniforms = ReturnType<typeof createUniforms>;

const vertexShader = /* glsl */ `
uniform float uTime, uScale, uSize, uBrightness, uOpacity, uSizeScale, uGain, uPhoto;
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
uniform float uDepth, uDepthCenter;
uniform float uShimmer, uShimmerSpeed;
uniform float uTwinkle, uTwinkleSpeed;
uniform float uAssemble;
uniform mat4 uHead;
uniform vec3 uPivot;
uniform vec2 uLag;
uniform float uHairSway;

attribute float aSeed;     // random 0-1 per vertex
attribute vec3 aScatter;   // random offset, for dust and the intro
attribute float aFade;     // 1, or less for eye rings behind a closing eyelid
attribute float aHeadWeight; // 1 turns fully with the head; 0 for the shoulders
attribute vec3 aColor;     // the photo's color at this point (plan §5.8)
#ifdef HAIR
attribute float aAlong;    // 0 at a strand's root, 1 at its end
#endif

varying vec3 vColor;
varying float vAlpha;
#ifdef SOLID
attribute vec3 aSolid;     // the head's own color in realistic mode: skin, hair or shirt
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSolid;
#endif

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

#ifdef HAIR
  // Ends trail the head's turn a moment (a small rotation about the neck) and sway in the wind.
  float k = aAlong * aAlong;
  vec3 r = p - uPivot;
  r += k * vec3(uLag.y * r.z, -uLag.x * r.z, -uLag.y * r.x + uLag.x * r.y);
  p = uPivot + r;
  p += k * uHairSway * 0.006 * vec3(
    sin(t * 1.3 + aSeed * 6.283 + position.y * 20.0),
    0.3 * sin(t * 0.9 + aSeed * 3.1),
    0.6 * sin(t * 1.1 + aSeed * 4.2)
  );
#endif
  p = mix(p, (uHead * vec4(p, 1.0)).xyz, aHeadWeight);
#ifdef SOLID
  vUv = uv;
  vSolid = aSolid;
  // The surface's direction, turned with the head and seen from the camera, for lighting.
  vNormal = normalize(mat3(viewMatrix) * mix(normal, mat3(uHead) * normal, aHeadWeight));
#endif

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // Depth fade, measured from the camera: points farther back than the face's front dim, so a
  // turned head's near ear stays bright and the far side recedes.
  float behind = -mv.z - uDepthCenter;
  alpha *= mix(1.0, 1.0 - 0.75 * smoothstep(-0.02, 0.1, behind), uDepth);

  vColor = mix(mix(uColor, aColor, uPhoto), uGlitchColor, red) * uBrightness * uGain * breath * (1.0 + glow);
  vAlpha = alpha * uOpacity;
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

const solidFragment = /* glsl */ `
uniform sampler2D uMap;
uniform float uUseMap, uOpacity, uBrightness2;
uniform vec3 uSkin, uLight;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vSolid;
void main() {
  vec3 base = uUseMap > 0.5 ? texture2D(uMap, vUv).rgb : vSolid;
  float light = max(dot(normalize(vNormal), uLight), 0.0);
  // Soft: plenty of fill light, so the photo's own shading isn't doubled into harsh shadows.
  gl_FragColor = vec4(base * (0.55 + 0.55 * light) * uBrightness2, uOpacity);
}
`;

/**
 * Realistic mode's solid surface (plan §5.8): the face wrapped in the photo skin image, or the
 * head in a flat skin tone, softly lit. It runs the same vertex shader as the points, so it moves
 * with every expression and turn. Its depth is pushed back slightly so the points and lines on
 * the surface stay visible while the two are blended.
 */
export function createSolid(uniforms: FaceUniforms) {
  return new ShaderMaterial({
    uniforms: {
      ...uniforms,
      uOpacity: { value: 0 },
      uSizeScale: { value: 1 },
      uGain: { value: 1 },
      uPhoto: { value: 0 },
      uMap: { value: null },
      uUseMap: { value: 0 },
      uSkin: { value: new Color(0.8, 0.62, 0.52) },
      uLight: { value: new Vector3(0.3, 0.4, 0.86).normalize() },
      uBrightness2: { value: 1 },
    },
    vertexShader,
    fragmentShader: solidFragment,
    defines: { SOLID: "" },
    transparent: true,
    depthWrite: true,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
}

/**
 * An invisible copy of the face and head surface, drawn first, that hides points, lines and hair
 * behind it (a bun at the back shouldn't show through the forehead). It runs the same vertex
 * shader, so it moves with every expression, turn and effect. Its depth is pushed back slightly so
 * the points and lines on the surface itself stay visible.
 */
export function createOccluder(uniforms: FaceUniforms) {
  return new ShaderMaterial({
    uniforms: { ...uniforms, uOpacity: { value: 1 }, uSizeScale: { value: 1 }, uGain: { value: 1 }, uPhoto: { value: 0 } },
    vertexShader,
    fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
    colorWrite: false,
    depthWrite: true,
    // The generated head's triangles don't all wind the same way, so hide from both sides.
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
}

/**
 * Realistic mode's hair: the same strands drawn as dark lines with ordinary blending (glowing
 * additive lines can't be dark).
 */
export function createRealHair(uniforms: FaceUniforms) {
  const material = createMaterial(uniforms, "hair", 0);
  material.blending = NormalBlending;
  material.uniforms.uPhoto.value = 1;
  return material;
}

/**
 * A material for points, lines or hair strands. Each gets its own opacity, size, brightness (so
 * the eye rings can stand out) and photo-color blend; every other uniform is shared.
 */
export function createMaterial(uniforms: FaceUniforms, kind: "points" | "lines" | "hair", opacity: number) {
  const defines = { points: { POINTS: "" }, lines: { LINES: "" }, hair: { LINES: "", HAIR: "" } }[kind];
  return new ShaderMaterial({
    uniforms: {
      ...uniforms,
      uOpacity: { value: opacity },
      uSizeScale: { value: 1 },
      uGain: { value: 1 },
      uPhoto: { value: 0 },
    },
    vertexShader,
    fragmentShader: kind === "points" ? pointFragment : lineFragment,
    defines,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

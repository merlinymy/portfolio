/**
 * Shader code the looks share: noise (smooth randomness that flames, ink and sand are shaped by)
 * and the fire color ramp.
 */

/**
 * 3D simplex noise: a smooth random value in [-1, 1] that changes gradually from place to place.
 * From "webgl-noise" by Ian McEwan and Stefan Gustavson (Ashima Arts), MIT license:
 * https://github.com/ashima/webgl-noise
 */
export const noise = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

/** Layers of noise at finer and finer sizes, for detail. Roughly [-1, 1]. */
float fbm(vec3 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * snoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}

/**
 * Curl noise: a swirling flow made from the noise's slopes. It never piles up or thins out
 * anywhere, which is what makes smoke, ink and flames swirl naturally.
 */
vec2 curl(vec2 p, float t) {
  const float e = 0.01;
  float n1 = snoise(vec3(p.x, p.y + e, t));
  float n2 = snoise(vec3(p.x, p.y - e, t));
  float n3 = snoise(vec3(p.x + e, p.y, t));
  float n4 = snoise(vec3(p.x - e, p.y, t));
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}
`;

/**
 * Fire colors by heat: black, deep red, orange, yellow, then white-hot. `tint` pulls the middle of
 * the range toward another color (the face state's), by `amount`.
 */
export const fireRamp = /* glsl */ `
vec3 fireRamp(float h, vec3 tint, float amount) {
  h = max(h, 0.0);
  vec3 red = mix(vec3(0.55, 0.04, 0.01), tint * 0.6, amount * 0.6);
  vec3 orange = mix(vec3(1.0, 0.34, 0.04), tint, amount);
  vec3 yellow = mix(vec3(1.0, 0.78, 0.28), mix(tint, vec3(1.0), 0.5), amount * 0.6);
  vec3 c = mix(vec3(0.0), red, smoothstep(0.0, 0.25, h));
  c = mix(c, orange, smoothstep(0.2, 0.55, h));
  c = mix(c, yellow, smoothstep(0.5, 0.9, h));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(0.9, 1.6, h));
  // Past white-hot it keeps brightening, so the glow can bloom.
  return c * (1.0 + max(h - 1.2, 0.0) * 0.6);
}
`;

/**
 * Caustics: the moving net of bright lines that sunlight makes underwater once ripples have bent
 * it. Two layers of noise ridges cross to make the net. Needs `noise` before it.
 */
export const caustics = /* glsl */ `
float caustic(vec2 p, float t) {
  float a = 1.0 - abs(snoise(vec3(p, t)));
  float b = 1.0 - abs(snoise(vec3(p * 1.37 + vec2(4.1, 1.7), -t * 0.83)));
  return pow(a, 7.0) + pow(b, 7.0) + pow(a * b, 3.0) * 0.5;
}
`;

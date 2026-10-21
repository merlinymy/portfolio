/**
 * Grows the hair in the browser from settings (plan §5.8), so the lab can switch styles and
 * lengths live. A fixed seed makes the same hair on every visit.
 *
 * Strands start on the scalp of the fitted head and step outward and down, pushed out of the
 * head (its real scalp shape, looked up by direction from the head's center), the neck (a
 * cylinder) and the shoulders (a dome), so they drape instead of passing through. Two styles:
 *   - loose: strands fall from a part, over the head and down the back and shoulders, ending at
 *     a cut line, then gather loosely into locks;
 *   - bun: strands run over the scalp to a gathering point at the back, and a coil of strands
 *     forms the bun.
 */

export type HairStyle = "loose" | "bun";

export interface HairSettings {
  style: HairStyle;
  count: number;
  /** Loose: how far below the chin the ends hang, in meters. */
  length: number;
  /** 0 for a center part; positive moves it toward the viewer's right, in meters. */
  part: number;
  /** Bun: 0 at the nape, 1 at the crown. */
  bunHeight: number;
  /** Bun: overall diameter in meters. */
  bunSize: number;
  /** How strongly strands gather into locks, 0–1. */
  clump: number;
}

export interface Ellipsoid {
  center: number[];
  radii: number[];
}

export interface HeadShape {
  /** Scalp triangles, as vertex positions: x, y, z for each corner. */
  scalp: Float32Array;
  skull: Ellipsoid;
  torso: Ellipsoid;
  neck: { center: number[]; radius: number; top: number; bottom: number };
  chinY: number;
}

export interface Hair {
  positions: Float32Array;
  /** 0 at a strand's root, 1 at its end: tips sway and trail more than roots. */
  along: Float32Array;
  /** One random number per strand, shared by all its points. */
  seeds: Float32Array;
  /** Pairs of point indices, one pair per line segment. */
  index: Uint32Array;
}

type Vec = [number, number, number];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec): Vec => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A repeatable random sequence (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The scalp's distance from the skull's center, by direction: a grid over the sphere of
 * directions, filled by casting a ray from the center through each grid point onto the scalp's
 * triangles. Directions with no scalp (the face, the nape) fall back to the skull ellipsoid.
 */
class SkullMap {
  private static readonly ROWS = 48;
  private static readonly COLUMNS = 96;
  private readonly radius: Float32Array;

  constructor(
    private readonly shape: HeadShape,
  ) {
    const { ROWS, COLUMNS } = SkullMap;
    this.radius = new Float32Array(ROWS * COLUMNS);
    const c = shape.skull.center as Vec;
    const t = shape.scalp;
    for (let row = 0; row < ROWS; row++) {
      for (let column = 0; column < COLUMNS; column++) {
        const d = SkullMap.direction(row, column);
        let best = 0;
        for (let i = 0; i < t.length; i += 9) {
          const hit = rayTriangle(c, d, [t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]);
          if (hit > best) best = hit;
        }
        this.radius[row * COLUMNS + column] = best || this.ellipsoidRadius(d);
      }
    }
  }

  private static direction(row: number, column: number): Vec {
    const polar = ((row + 0.5) / SkullMap.ROWS) * Math.PI;
    const azimuth = (column / SkullMap.COLUMNS) * Math.PI * 2;
    return [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
  }

  private ellipsoidRadius(d: Vec) {
    const r = this.shape.skull.radii;
    return 1 / Math.hypot(d[0] / r[0], d[1] / r[1], d[2] / r[2]);
  }

  /** The scalp's distance from the center along unit direction d, smoothly interpolated. */
  at(d: Vec): number {
    const { ROWS, COLUMNS } = SkullMap;
    const polar = Math.acos(Math.max(-1, Math.min(1, d[1])));
    const azimuth = (Math.atan2(d[2], d[0]) + Math.PI * 2) % (Math.PI * 2);
    const row = Math.min(ROWS - 1.001, Math.max(0, (polar / Math.PI) * ROWS - 0.5));
    const column = (azimuth / (Math.PI * 2)) * COLUMNS;
    const r0 = Math.floor(row);
    const c0 = Math.floor(column) % COLUMNS;
    const c1 = (c0 + 1) % COLUMNS;
    const fr = row - r0;
    const fc = column - Math.floor(column);
    const get = (r: number, col: number) => this.radius[r * COLUMNS + col];
    const top = get(r0, c0) * (1 - fc) + get(r0, c1) * fc;
    const bottom = get(r0 + 1, c0) * (1 - fc) + get(r0 + 1, c1) * fc;
    return top * (1 - fr) + bottom * fr;
  }

  /** The point on the scalp in direction d from the center, raised by `lift` meters. */
  surface(d: Vec, lift = 0): Vec {
    return add(this.shape.skull.center as Vec, mul(d, this.at(d) + lift));
  }

  /** Pushes p out to `pad` above the scalp; returns the outward direction if it was inside. */
  pushOut(p: Vec, pad: number): Vec | undefined {
    const offset = sub(p, this.shape.skull.center as Vec);
    const distance = Math.hypot(offset[0], offset[1], offset[2]);
    const d = mul(offset, 1 / (distance || 1));
    const r = this.at(d) + pad;
    if (distance >= r) return undefined;
    const out = this.surface(d, pad);
    for (let k = 0; k < 3; k++) p[k] = out[k];
    return d;
  }
}

/** Distance along the ray from o in direction d to triangle abc, or 0 for a miss (Möller–Trumbore). */
function rayTriangle(o: Vec, d: Vec, a: Vec, b: Vec, c: Vec): number {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return 0;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return 0;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return 0;
  const t = dot(e2, q) * inv;
  return t > 0 ? t : 0;
}

/** Pushes p out of an ellipsoid grown by `pad`; returns the outward direction if it was inside. */
function pushOut(p: Vec, e: Ellipsoid, pad: number): Vec | undefined {
  const r: Vec = [e.radii[0] + pad, e.radii[1] + pad, e.radii[2] + pad];
  const q: Vec = [(p[0] - e.center[0]) / r[0], (p[1] - e.center[1]) / r[1], (p[2] - e.center[2]) / r[2]];
  const d = Math.hypot(q[0], q[1], q[2]);
  if (d >= 1) return undefined;
  const s = 1 / (d || 1);
  for (let k = 0; k < 3; k++) p[k] = e.center[k] + q[k] * s * r[k];
  return norm([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
}

function collide(p: Vec, dir: Vec, shape: HeadShape, skullMap: SkullMap, pad: number) {
  const normals: Vec[] = [];
  const skull = skullMap.pushOut(p, pad);
  if (skull) normals.push(skull);
  if (p[1] < shape.neck.top) {
    const torso = pushOut(p, shape.torso, pad);
    if (torso) normals.push(torso);
    const dx = p[0] - shape.neck.center[0];
    const dz = p[2] - shape.neck.center[1];
    const d = Math.hypot(dx, dz);
    const r = shape.neck.radius + pad;
    if (d < r && p[1] > shape.neck.bottom - 0.02) {
      p[0] = shape.neck.center[0] + (dx / (d || 1)) * r;
      p[2] = shape.neck.center[1] + (dz / (d || 1)) * r;
      normals.push(norm([dx, 0, dz]));
    }
  }
  // Slide along the surface instead of into it.
  for (const n of normals) {
    const into = dot(dir, n);
    if (into < 0) for (let k = 0; k < 3; k++) dir[k] -= n[k] * into;
  }
}

/** Area-weighted random points on the scalp, with outward normals. */
function sampleRoots(shape: HeadShape, count: number, next: () => number) {
  const t = shape.scalp;
  const areas: number[] = [];
  let total = 0;
  for (let i = 0; i < t.length; i += 9) {
    const a: Vec = [t[i], t[i + 1], t[i + 2]];
    const b: Vec = [t[i + 3], t[i + 4], t[i + 5]];
    const c: Vec = [t[i + 6], t[i + 7], t[i + 8]];
    const area = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    total += area;
    areas.push(total);
  }
  const roots: { at: Vec; normal: Vec }[] = [];
  for (let n = 0; n < count; n++) {
    const pick = next() * total;
    let lo = 0;
    let hi = areas.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (areas[m] < pick) lo = m + 1;
      else hi = m;
    }
    const i = lo * 9;
    const a: Vec = [t[i], t[i + 1], t[i + 2]];
    const b: Vec = [t[i + 3], t[i + 4], t[i + 5]];
    const c: Vec = [t[i + 6], t[i + 7], t[i + 8]];
    let u = next();
    let v = next();
    if (u + v > 1) [u, v] = [1 - u, 1 - v];
    const at = add(a, add(mul(sub(b, a), u), mul(sub(c, a), v)));
    let normal = norm(cross(sub(b, a), sub(c, a)));
    if (dot(normal, sub(at, shape.skull.center as Vec)) < 0) normal = mul(normal, -1);
    roots.push({ at, normal });
  }
  return roots;
}

interface Strand {
  points: Vec[];
}

function looseStrands(shape: HeadShape, skull: SkullMap, s: HairSettings, next: () => number): Strand[] {
  const seg = 0.007;
  const endY = shape.chinY - s.length;
  return sampleRoots(shape, s.count, next).map(({ at, normal }) => {
    // Comb away from the part and back, then let gravity take over.
    const side = Math.sign(at[0] - s.part) || 1;
    let dir = norm(add(mul(normal, 0.6), [side * 0.5, 0.1, -0.7]));
    // Each strand lies at its own depth in the hair's volume.
    const layer = 0.002 + next() * 0.008;
    const cut = endY + (next() - 0.5) * 0.03;
    const p: Vec = add(at, mul(normal, layer * 0.5));
    const points: Vec[] = [[...p]];
    for (let step = 0; step < 160 && p[1] > cut; step++) {
      const wobble: Vec = [(next() - 0.5) * 0.15, 0, (next() - 0.5) * 0.15];
      dir = norm(add(add(dir, [0, -0.28, 0]), wobble));
      for (let k = 0; k < 3; k++) p[k] += dir[k] * seg;
      collide(p, dir, shape, skull, layer);
      points.push([...p]);
    }
    return { points };
  });
}

function bunStrands(shape: HeadShape, skull: SkullMap, s: HairSettings, next: () => number): Strand[] {
  const c = shape.skull.center;
  // The gathering point: on the back of the skull, from the nape (0) up to the crown (1).
  const angle = (-25 + s.bunHeight * 95) * (Math.PI / 180);
  const toward: Vec = norm([0, Math.sin(angle), -Math.cos(angle)]);
  const gather = skull.surface(toward);
  const outward = norm(sub(gather, c as Vec));
  const bunCenter = add(gather, mul(outward, s.bunSize * 0.35));

  const strands: Strand[] = [];
  // Strands over the scalp, pulled tight toward the bun.
  for (const { at } of sampleRoots(shape, Math.round(s.count * 0.75), next)) {
    const from = norm(sub(at, c as Vec));
    const lift = 0.002 + next() * 0.004;
    const points: Vec[] = [];
    const steps = 18;
    for (let i = 0; i <= steps; i++) {
      const d = norm(add(mul(from, 1 - i / steps), mul(toward, i / steps)));
      points.push(skull.surface(d, lift));
    }
    strands.push({ points });
  }
  // The bun: strands coiled around a ring that faces outward from the head.
  const a = norm(cross(outward, [0, 1, 0]));
  const b = cross(outward, a);
  const ring = s.bunSize * 0.3;
  const tube = s.bunSize * 0.2;
  for (let n = 0; n < Math.round(s.count * 0.25); n++) {
    const start = next() * Math.PI * 2;
    const turns = 1.5 + next();
    const depth = 0.6 + next() * 0.4;
    const points: Vec[] = [];
    const steps = 36;
    for (let i = 0; i <= steps; i++) {
      const u = start + (i / steps) * turns * Math.PI * 2;
      const v = u * 2.3;
      const radial = ring + Math.cos(v) * tube * depth;
      const p = add(bunCenter, add(add(mul(a, Math.cos(u) * radial), mul(b, Math.sin(u) * radial)), mul(outward, Math.sin(v) * tube * depth)));
      points.push(p);
    }
    strands.push({ points });
  }
  return strands;
}

/** Pulls each strand toward the nearest of a few guide strands, more toward the ends, to form locks. */
function clumpStrands(strands: Strand[], amount: number, next: () => number) {
  if (amount <= 0 || strands.length < 24) return;
  const guides = Array.from({ length: Math.max(8, Math.round(strands.length / 14)) }, () => strands[Math.floor(next() * strands.length)]);
  for (const strand of strands) {
    const root = strand.points[0];
    let guide = guides[0];
    let best = Infinity;
    for (const g of guides) {
      const d = sub(g.points[0], root);
      const dd = dot(d, d);
      if (dd < best) {
        best = dd;
        guide = g;
      }
    }
    if (guide === strand) continue;
    const n = strand.points.length;
    for (let i = 1; i < n; i++) {
      const g = guide.points[Math.min(i, guide.points.length - 1)];
      const t = (i / (n - 1)) * amount;
      // Keep the strand's own root offset, so locks don't all start from one point.
      const target = add(g, mul(sub(root, guide.points[0]), 1 - t));
      strand.points[i] = add(mul(strand.points[i], 1 - t), mul(target, t));
    }
  }
}

export function growHair(shape: HeadShape, settings: HairSettings, seed = 1): Hair {
  const next = random(seed);
  const skull = new SkullMap(shape);
  const strands =
    settings.style === "bun" ? bunStrands(shape, skull, settings, next) : looseStrands(shape, skull, settings, next);
  if (settings.style === "loose") clumpStrands(strands, settings.clump, next);

  const total = strands.reduce((n, s) => n + s.points.length, 0);
  const positions = new Float32Array(total * 3);
  const along = new Float32Array(total);
  const seeds = new Float32Array(total);
  const index: number[] = [];
  let v = 0;
  for (const strand of strands) {
    const seedValue = next();
    const n = strand.points.length;
    strand.points.forEach((p, i) => {
      positions.set(p, (v + i) * 3);
      along[v + i] = n > 1 ? i / (n - 1) : 0;
      seeds[v + i] = seedValue;
      if (i > 0) index.push(v + i - 1, v + i);
    });
    v += n;
  }
  return { positions, along, seeds, index: new Uint32Array(index) };
}

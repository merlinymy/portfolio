/**
 * Generates the head, neck, shoulders and ears around the scanned face (plan §5.8). Run
 * `npm run head` after `npm run face`.
 *
 * Reads knowledge/faceScan/ (face.json, texture.json and the three photos) and writes
 * apps/site/public/face/head.glb, which also opens in Blender. The steps:
 *   1. Describe the shape as a signed distance field (for any point, how far it is from the
 *      surface, negative inside): a smooth blend of a skull, a jaw block, a neck, the shoulders and
 *      two ears, which near the face gives way to the scan itself so the surface flows out of the
 *      scan's edge.
 *   2. Turn it into triangles with surface nets (one point per grid cell the surface crosses), then
 *      even the spacing out.
 *   3. Cut away the part the scan covers and snap the hole's edge onto the scan's outline.
 *   4. Weights: which points follow the face's expressions (the seam) and how much each point
 *      turns with the head (the neck blends into still shoulders).
 *   5. The scalp and the simple body shapes the browser grows and drapes the hair on.
 * Sizes come from the photos where they can (head width and top from the front photo, the ears
 * from the turned ones); typical proportions fill in the rest, and lab sliders correct by eye.
 * The scanned face itself is never changed: the site draws it from face.glb.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accessor, Document, NodeIO, Primitive, VertexLayout } from "@gltf-transform/core";
import jpeg from "jpeg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN = join(ROOT, "knowledge/faceScan");
const OUT = join(ROOT, "apps/site/public/face/head.glb");

/** Grid spacing for building the surface, in meters: about the scan's own point spacing. */
const CELL = 0.0065;
/** The region the surface is built in: head, neck and shoulders, cut off at the upper chest. */
const BOUNDS = { min: [-0.25, -0.29, -0.19], max: [0.25, 0.2, 0.12] };
const CHEST_CUT = -0.275;
/** Head points within this distance of the scan's edge follow its expressions (meters). */
const SEAM = 0.03;

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec) => Math.sqrt(dot(a, a));
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec): Vec => mul(a, 1 / (len(a) || 1));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- scan

interface Scan {
  positions: Vec[];
  triangles: [number, number, number][];
  normals: Vec[];
  eyes: { left: Vec; right: Vec; radius: number };
  /** The scan's outer edge, as a loop of vertex indices. */
  outline: number[];
  eyeY: number;
  chinY: number;
  topY: number;
}

function boundaryLoops(triangles: [number, number, number][]): number[][] {
  const count = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const t of triangles) for (let k = 0; k < 3; k++) {
    const e = key(t[k], t[(k + 1) % 3]);
    count.set(e, (count.get(e) ?? 0) + 1);
  }
  const next = new Map<number, number[]>();
  for (const [e, n] of count) {
    if (n !== 1) continue;
    const [a, b] = e.split(",").map(Number);
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let previous = -1;
    let current = start;
    for (;;) {
      const step = (next.get(current) ?? []).find((n) => n !== previous && !seen.has(n));
      if (step === undefined) break;
      loop.push(step);
      seen.add(step);
      previous = current;
      current = step;
    }
    loops.push(loop);
  }
  return loops;
}

async function loadScan(): Promise<Scan> {
  const face = JSON.parse(await readFile(join(SCAN, "face.json"), "utf8"));
  const positions: Vec[] = [];
  for (let i = 0; i < face.vertices.length; i += 3) positions.push(face.vertices.slice(i, i + 3) as Vec);
  const triangles: [number, number, number][] = [];
  for (let i = 0; i < face.triangles.length; i += 3) triangles.push(face.triangles.slice(i, i + 3));
  // Face normals, flipped if needed so they point out of the face (toward +z on average).
  let facing = 0;
  const normals = triangles.map(([a, b, c]) => {
    const n = norm(cross(sub(positions[b], positions[a]), sub(positions[c], positions[a])));
    facing += n[2];
    return n;
  });
  if (facing < 0) normals.forEach((n, i) => (normals[i] = mul(n, -1)));
  const outline = boundaryLoops(triangles).sort((a, b) => b.length - a.length)[0];
  const ys = positions.map((p) => p[1]);
  return {
    positions,
    triangles,
    normals,
    eyes: face.eyes,
    outline,
    eyeY: (face.eyes.left[1] + face.eyes.right[1]) / 2,
    chinY: Math.min(...ys),
    topY: Math.max(...ys),
  };
}

/** The closest point to p on triangle abc (Ericson, Real-Time Collision Detection, 5.1.5). */
function closestOnTriangle(p: Vec, a: Vec, b: Vec, c: Vec): Vec {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(mul(ab, vb * denom), mul(ac, vc * denom)));
}

/** Finds the scan's nearest point quickly, by bucketing its triangles into 1 cm cells. */
class ScanIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly scan: Scan;
  private static readonly SIZE = 0.01;
  constructor(scan: Scan) {
    this.scan = scan;
    scan.triangles.forEach((t, i) => {
      const lo = [0, 1, 2].map((k) => Math.min(...t.map((v) => scan.positions[v][k])));
      const hi = [0, 1, 2].map((k) => Math.max(...t.map((v) => scan.positions[v][k])));
      const s = ScanIndex.SIZE;
      for (let x = Math.floor(lo[0] / s); x <= Math.floor(hi[0] / s); x++)
        for (let y = Math.floor(lo[1] / s); y <= Math.floor(hi[1] / s); y++)
          for (let z = Math.floor(lo[2] / s); z <= Math.floor(hi[2] / s); z++) {
            const key = ScanIndex.key(x, y, z);
            if (!this.cells.has(key)) this.cells.set(key, []);
            this.cells.get(key)!.push(i);
          }
    });
  }

  private static key(x: number, y: number, z: number) {
    return ((x + 500) * 1000 + (y + 500)) * 1000 + (z + 500);
  }

  /** The nearest point within `reach` meters, its triangle's outward normal, and the distance. */
  nearest(p: Vec, reach: number): { point: Vec; normal: Vec; distance: number } | undefined {
    const s = ScanIndex.SIZE;
    const r = Math.ceil(reach / s);
    const [cx, cy, cz] = p.map((v) => Math.floor(v / s));
    let best: { point: Vec; normal: Vec; distance: number } | undefined;
    const seen = new Set<number>();
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++)
        for (let z = cz - r; z <= cz + r; z++) {
          for (const i of this.cells.get(ScanIndex.key(x, y, z)) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            const [a, b, c] = this.scan.triangles[i];
            const q = closestOnTriangle(p, this.scan.positions[a], this.scan.positions[b], this.scan.positions[c]);
            const d = len(sub(p, q));
            if (d <= reach && (!best || d < best.distance)) best = { point: q, normal: this.scan.normals[i], distance: d };
          }
        }
    return best;
  }
}

/** The scan's front surface height (z) over a 2 mm grid in x and y, for quick depth checks. */
class FrontHeight {
  private static readonly SIZE = 0.002;
  private readonly z = new Map<number, number>();
  constructor(scan: Scan) {
    const s = FrontHeight.SIZE;
    for (const [a, b, c] of scan.triangles) {
      const [pa, pb, pc] = [scan.positions[a], scan.positions[b], scan.positions[c]];
      const x0 = Math.floor(Math.min(pa[0], pb[0], pc[0]) / s);
      const x1 = Math.ceil(Math.max(pa[0], pb[0], pc[0]) / s);
      const y0 = Math.floor(Math.min(pa[1], pb[1], pc[1]) / s);
      const y1 = Math.ceil(Math.max(pa[1], pb[1], pc[1]) / s);
      const det = (pb[1] - pc[1]) * (pa[0] - pc[0]) + (pc[0] - pb[0]) * (pa[1] - pc[1]);
      if (Math.abs(det) < 1e-12) continue;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const px = x * s;
        const py = y * s;
        const u = ((pb[1] - pc[1]) * (px - pc[0]) + (pc[0] - pb[0]) * (py - pc[1])) / det;
        const v = ((pc[1] - pa[1]) * (px - pc[0]) + (pa[0] - pc[0]) * (py - pc[1])) / det;
        if (u < -0.01 || v < -0.01 || u + v > 1.01) continue;
        const z = u * pa[2] + v * pb[2] + (1 - u - v) * pc[2];
        const key = x * 100_000 + y;
        this.z.set(key, Math.max(this.z.get(key) ?? -Infinity, z));
      }
    }
  }
  at(x: number, y: number): number | undefined {
    const s = FrontHeight.SIZE;
    return this.z.get(Math.round(x / s) * 100_000 + Math.round(y / s));
  }
}

/** Signed distance (x, y only) from the scan's outline seen from the front: negative inside. */
function outlineDistance2D(p: Vec, loop: Vec[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    const ex = xj - xi;
    const ey = yj - yi;
    const t = clamp01(((p[0] - xi) * ex + (p[1] - yi) * ey) / (ex * ex + ey * ey || 1));
    best = Math.min(best, Math.hypot(p[0] - (xi + ex * t), p[1] - (yi + ey * t)));
  }
  return inside ? -best : best;
}

/** The closest point on the scan's outline, and the outline vertex nearest it. */
function closestOnOutline(p: Vec, scan: Scan): { point: Vec; vertex: number; distance: number } {
  let best = { point: scan.positions[scan.outline[0]], vertex: scan.outline[0], distance: Infinity };
  const n = scan.outline.length;
  for (let k = 0; k < n; k++) {
    const ia = scan.outline[k];
    const ib = scan.outline[(k + 1) % n];
    const a = scan.positions[ia];
    const b = scan.positions[ib];
    const ab = sub(b, a);
    const t = clamp01(dot(sub(p, a), ab) / dot(ab, ab));
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (d < best.distance) best = { point: q, vertex: t < 0.5 ? ia : ib, distance: d };
  }
  return best;
}

// ---------------------------------------------------------------- photos

interface Shot {
  name: string;
  image: string;
  cameraInFace: number[];
  pixels: number[];
}

interface Photo {
  shot: Shot;
  width: number;
  height: number;
  data: Uint8Array;
  /** Face space to pixels: a full perspective camera fitted from the scan's points. */
  project: (p: Vec) => [number, number];
  /** The view ray through a pixel: where the camera is and which way the ray points. */
  ray: (u: number, v: number) => { from: Vec; toward: Vec };
}

/** Solves a small dense linear system (Gaussian elimination with partial pivoting). */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(m[k][i]) > Math.abs(m[pivot][i])) pivot = k;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = i; j <= n; j++) m[k][j] -= f * m[i][j];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * The camera that took a photo, from the scan's points and where each landed in it: the direct
 * linear transform (DLT), solved on centered, scaled coordinates for accuracy. Unlike a flat
 * projection it stays right for points well behind the face, such as the ears and the back of
 * the head.
 */
function fitCamera(points: Vec[], pixels: [number, number][]) {
  const n = points.length;
  const c3 = mul(points.reduce(add, [0, 0, 0]), 1 / n);
  const s3 = Math.sqrt(3) / (points.reduce((s, p) => s + len(sub(p, c3)), 0) / n);
  const c2 = [pixels.reduce((s, p) => s + p[0], 0) / n, pixels.reduce((s, p) => s + p[1], 0) / n];
  const s2 = Math.SQRT2 / (pixels.reduce((s, p) => s + Math.hypot(p[0] - c2[0], p[1] - c2[1]), 0) / n);
  const ata = Array.from({ length: 11 }, () => new Array(11).fill(0));
  const atb = new Array(11).fill(0);
  const addRow = (row: number[], value: number) => {
    for (let i = 0; i < 11; i++) {
      for (let j = 0; j < 11; j++) ata[i][j] += row[i] * row[j];
      atb[i] += row[i] * value;
    }
  };
  points.forEach((p, i) => {
    const [x, y, z] = mul(sub(p, c3), s3);
    const u = (pixels[i][0] - c2[0]) * s2;
    const v = (pixels[i][1] - c2[1]) * s2;
    addRow([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z], u);
    addRow([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z], v);
  });
  const q = solveLinear(ata, atb);
  const P = [
    [q[0], q[1], q[2], q[3]],
    [q[4], q[5], q[6], q[7]],
    [q[8], q[9], q[10], 1],
  ];
  const normalizedPoint = (p: Vec) => mul(sub(p, c3), s3);
  const project = (p: Vec): [number, number] => {
    const [x, y, z] = normalizedPoint(p);
    const w = P[2][0] * x + P[2][1] * y + P[2][2] * z + P[2][3];
    const u = (P[0][0] * x + P[0][1] * y + P[0][2] * z + P[0][3]) / w;
    const v = (P[1][0] * x + P[1][1] * y + P[1][2] * z + P[1][3]) / w;
    return [u / s2 + c2[0], v / s2 + c2[1]];
  };
  // The camera's center is where P maps to nothing: solve M·c = −p4 for the left 3 × 3 block M.
  const M = P.map((row) => row.slice(0, 3));
  const centerN = solveLinear(M, P.map((row) => -row[3]));
  const from = add(mul(centerN as Vec, 1 / s3), c3);
  const ray = (u: number, v: number) => {
    const target = solveLinear(M, [(u - c2[0]) * s2 - P[0][3], (v - c2[1]) * s2 - P[1][3], 1 - P[2][3]]);
    const point = add(mul(target as Vec, 1 / s3), c3);
    return { from, toward: norm(sub(point, from)) };
  };
  return { project, ray };
}

async function loadPhotos(scan: Scan): Promise<Photo[]> {
  const texture = JSON.parse(await readFile(join(SCAN, "texture.json"), "utf8")) as { shots: Shot[] };
  return Promise.all(
    texture.shots.map(async (shot) => {
      const image = jpeg.decode(await readFile(join(SCAN, shot.image)), { useTArray: true });
      const pixels = scan.positions.map((_, i) => [shot.pixels[i * 2], shot.pixels[i * 2 + 1]] as [number, number]);
      const camera = fitCamera(scan.positions, pixels);
      return { shot, width: image.width, height: image.height, data: image.data, ...camera };
    }),
  );
}

function pixel(photo: Photo, p: Vec): [number, number, number] | undefined {
  const [u, v] = photo.project(p).map(Math.round);
  if (u < 0 || v < 0 || u >= photo.width || v >= photo.height) return undefined;
  const k = (v * photo.width + u) * 4;
  return [photo.data[k], photo.data[k + 1], photo.data[k + 2]];
}
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const isSkin = (c: [number, number, number]) => {
  const [r, g, b] = c;
  return r > 90 && r > g && g > b * 0.9 && r - Math.min(g, b) > 15 && luminance(c) > 70;
};

/**
 * The head's width and top, from the front photo, where the hair is tied back. From the scan's
 * edge, walk outward through the dark hair until three light samples in a row (the wall).
 */
function measureHead(scan: Scan, front: Photo): { halfWidth: number; top: number } | undefined {
  const walk = (start: Vec, step: Vec, limit = 0.12) => {
    let dark = 0;
    let light = 0;
    for (let t = 0; t < limit; t += 0.001) {
      const c = pixel(front, add(start, mul(step, t)));
      if (!c) return undefined;
      const l = luminance(c);
      if (dark < 3) {
        dark = l < 70 ? dark + 1 : 0;
        continue;
      }
      light = l > 125 ? light + 1 : 0;
      if (light === 3) return t - 0.002;
    }
    return undefined;
  };
  const top = scan.positions.reduce((a, b) => (b[1] > a[1] ? b : a));
  const rise = walk(top, [0, 1, 0]);
  const temple = scan.eyeY + 0.025;
  const edge = (side: 1 | -1) =>
    scan.outline
      .map((i) => scan.positions[i])
      .filter((p) => Math.abs(p[1] - temple) < 0.006 && Math.sign(p[0]) === side)
      .reduce((a, b) => (Math.abs(b[0]) > Math.abs(a[0]) ? b : a), [0, temple, 0] as Vec);
  const widths = ([1, -1] as const).flatMap((side) => {
    const start = edge(side);
    const out = walk(start, [side, 0, 0]);
    return out === undefined ? [] : [Math.abs(start[0]) + out];
  });
  if (rise === undefined || widths.length === 0) return undefined;
  return { halfWidth: Math.max(...widths), top: top[1] + rise };
}

interface Ear {
  center: Vec;
  /** Half-height and half-width (front to back), in meters. */
  halfHeight: number;
  halfWidth: number;
  measured: boolean;
}

/** The turned photo that sees a point on one side of the head most squarely. */
function photoFacing(side: 1 | -1, at: Vec, photos: Photo[]): Photo | undefined {
  const sideways: Vec = [side, 0, 0];
  let best: Photo | undefined;
  let bestFacing = -Infinity;
  for (const p of photos) {
    if (p.shot.name === "front") continue;
    const facing = dot(sideways, norm(sub(p.shot.cameraInFace as Vec, at)));
    if (facing > bestFacing) [best, bestFacing] = [p, facing];
  }
  return best;
}

/**
 * Finds an ear in the turned photo that sees that side best. Your hair is pulled back, so walking
 * back along the side of the head at ear height there's skin from the cheek onto the ear, then
 * dark hair behind it: that change is the ear's back edge. Just in front of it, walking up, the
 * hair above the ear marks its top. Falls back to typical proportions.
 */
function findEar(side: 1 | -1, scan: Scan, photos: Photo[], sideX: number, eyeZ: number): Ear {
  const typical: Ear = {
    center: [side * sideX, scan.eyeY - 0.012, eyeZ - 0.085],
    halfHeight: 0.03,
    halfWidth: 0.017,
    measured: false,
  };
  const photo = photoFacing(side, typical.center, photos);
  if (!photo) return typical;
  const y = typical.center[1];
  let skin = 0;
  let dark = 0;
  let back: number | undefined;
  for (let z = eyeZ - 0.04; z > eyeZ - 0.15 && back === undefined; z -= 0.001) {
    const c = pixel(photo, [side * sideX, y, z]);
    if (!c) break;
    if (isSkin(c)) {
      skin++;
      dark = 0;
    } else if (luminance(c) < 60 && skin > 10) {
      if (++dark === 3) back = z + 0.002;
    } else dark = 0;
  }
  if (process.env.HEAD_DEBUG) console.log(`  ear ${side}, ${photo.shot.name} photo: back edge ${back === undefined ? "not found" : ((eyeZ - back) * 100).toFixed(1) + " cm behind the eyes"}`);
  if (back === undefined || back > eyeZ - 0.06 || back < eyeZ - 0.13) return typical;
  let top: number | undefined;
  dark = 0;
  for (let t = 0; t < 0.06 && top === undefined; t += 0.001) {
    const c = pixel(photo, [side * sideX, y + t, back + 0.01]);
    if (!c) break;
    if (luminance(c) < 60) {
      if (++dark === 3) top = y + t - 0.002;
    } else dark = 0;
  }
  if (top === undefined || top < scan.eyeY - 0.005 || top > scan.eyeY + 0.035) return typical;
  return {
    center: [side * sideX, top - typical.halfHeight, back + typical.halfWidth],
    halfHeight: typical.halfHeight,
    halfWidth: typical.halfWidth,
    measured: true,
  };
}

/**
 * How far back the head reaches, from the turned photos. Each shows the back of the head against
 * the wall: walking in the photo from the side of the head toward the back, past the hair, the
 * wall starts at the head's outline. That outline is where the camera's line of sight just grazes
 * the head, so the skull's depth is the one at which the line of sight through that pixel touches
 * its ellipsoid. Measured at temple height, above where a ponytail is tied.
 */
function measureBack(
  scan: Scan,
  photos: Photo[],
  outer: { halfWidth: number; top: number },
  front: number,
  centerY: number,
  eyeZ: number,
): number | undefined {
  const temple = scan.eyeY + 0.03;
  const depths: number[] = [];
  for (const side of [1, -1] as const) {
    const start: Vec = [side * (outer.halfWidth - 0.015), temple, eyeZ - 0.07];
    const photo = photoFacing(side, start, photos);
    if (!photo) continue;
    const [u0, v0] = photo.project(start);
    const [u1, v1] = photo.project(add(start, [0, 0, -0.01]));
    const step = Math.hypot(u1 - u0, v1 - v0) || 1;
    const du = (u1 - u0) / step;
    const dv = (v1 - v0) / step;
    let dark = 0;
    let light = 0;
    let edge: [number, number] | undefined;
    for (let t = 0; t < 600 && !edge; t++) {
      const u = Math.round(u0 + du * t);
      const v = Math.round(v0 + dv * t);
      if (u < 0 || v < 0 || u >= photo.width || v >= photo.height) break;
      const k = (v * photo.width + u) * 4;
      const l = luminance([photo.data[k], photo.data[k + 1], photo.data[k + 2]]);
      if (dark < 3) dark = l < 70 ? dark + 1 : 0;
      else if ((light = l > 125 ? light + 1 : 0) === 3) edge = [u0 + du * (t - 2), v0 + dv * (t - 2)];
    }
    if (!edge) continue;
    const { from, toward } = photo.ray(...edge);
    const rx = outer.halfWidth;
    const ry = outer.top - centerY;
    // How close the line of sight comes to the ellipsoid, in units of its radii (1 = touching).
    const closeness = (rz: number) => {
      const c: Vec = [0, centerY, front - rz];
      const a: Vec = [toward[0] / rx, toward[1] / ry, toward[2] / rz];
      const b: Vec = [(from[0] - c[0]) / rx, (from[1] - c[1]) / ry, (from[2] - c[2]) / rz];
      const t = -dot(a, b) / dot(a, a);
      return len(add(b, mul(a, t)));
    };
    let lo = 0.07;
    let hi = 0.14;
    if (closeness(lo) < 1 || closeness(hi) > 1) continue;
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (closeness(m) > 1) lo = m;
      else hi = m;
    }
    const depth = (lo + hi) / 2;
    if (process.env.HEAD_DEBUG) console.log(`  back of head, ${photo.shot.name} photo: ${(depth * 200).toFixed(1)} cm`);
    depths.push(depth);
  }
  return depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : undefined;
}

/** The neck's half-width, from the front photo: below the chin, from the middle out to where skin ends. */
function measureNeck(scan: Scan, front: Photo): number | undefined {
  const y = scan.chinY - 0.045;
  const widths: number[] = [];
  for (const side of [1, -1] as const) {
    let other = 0;
    for (let x = 0; x < 0.1; x += 0.001) {
      const c = pixel(front, [side * x, y, 0]);
      if (!c) break;
      other = isSkin(c) ? 0 : other + 1;
      if (other === 3) {
        widths.push(x - 0.002);
        break;
      }
    }
  }
  const half = widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : undefined;
  return half !== undefined && half > 0.04 && half < 0.08 ? half : undefined;
}

// ---------------------------------------------------------------- shape

/** iq's ellipsoid distance estimate: exact on the surface, close nearby. */
function ellipsoid(p: Vec, c: Vec, r: Vec): number {
  const q = sub(p, c);
  const k0 = Math.hypot(q[0] / r[0], q[1] / r[1], q[2] / r[2]);
  const k1 = Math.hypot(q[0] / (r[0] * r[0]), q[1] / (r[1] * r[1]), q[2] / (r[2] * r[2]));
  return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
}

/** A vertical rounded column with an elliptical cross-section, from y0 up to y1. */
function column(p: Vec, cx: number, cz: number, rx: number, rz: number, y0: number, y1: number): number {
  const across = Math.hypot((p[0] - cx) / rx, (p[2] - cz) / rz) - 1;
  const radius = Math.min(rx, rz);
  const below = y0 - p[1];
  const above = p[1] - y1;
  const side = across * radius;
  const cap = Math.max(below, above);
  return cap > 0 ? Math.hypot(Math.max(side, 0), cap) + Math.min(Math.max(side, cap), 0) : side;
}

/** Smooth minimum: joins two shapes with a fillet about k meters wide. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

interface Body {
  skull: { center: Vec; radii: Vec };
  jaw: { center: Vec; radii: Vec };
  neck: { cx: number; cz: number; rx: number; rz: number; bottom: number; top: number };
  torso: { center: Vec; radii: Vec };
  shoulders: { center: Vec; radii: Vec }[];
}

/** Where the skull's front sits: just inside the forehead's top edge. */
const skullFront = (scan: Scan) => scan.positions.reduce((a, b) => (b[1] > a[1] ? b : a))[2] + 0.012;
const skullCenterY = (scan: Scan) => scan.eyeY + 0.03;
/** Tied-back hair still adds a little thickness over the skull. */
const HAIR = 0.006;

function designBody(
  scan: Scan,
  head: { halfWidth: number; top: number },
  measured: { halfLength?: number; neckHalfWidth?: number },
): Body {
  const halfWidth = head.halfWidth - HAIR;
  const top = head.top - HAIR;
  // A typical head is about 19.5 cm from the brow to the back.
  const halfLength = (measured.halfLength ?? 0.096 + HAIR) - HAIR;
  const skullCenter: Vec = [0, skullCenterY(scan), skullFront(scan) - halfLength];
  const neckX = measured.neckHalfWidth ?? 0.053;
  const chinY = scan.chinY;
  const neckZ = skullCenter[2] + 0.01;
  // Set against the three texture photos (HEAD_OVERLAY): the shirt's shoulders start just below
  // the collar and run past the photos' edges.
  const shoulderTop = chinY - 0.04;
  return {
    skull: { center: skullCenter, radii: [halfWidth, top - skullCenter[1], halfLength] },
    jaw: { center: [0, chinY + 0.04, skullCenter[2] + 0.03], radii: [halfWidth * 0.82, 0.055, 0.08] },
    neck: { cx: 0, cz: neckZ, rx: neckX, rz: neckX * 1.1, bottom: shoulderTop - 0.06, top: scan.eyeY - 0.02 },
    torso: { center: [0, shoulderTop - 0.1, neckZ - 0.005], radii: [0.205, 0.105, 0.115] },
    shoulders: ([1, -1] as const).map((s) => ({
      center: [s * 0.175, shoulderTop - 0.05, neckZ - 0.01] as Vec,
      radii: [0.07, 0.055, 0.06] as Vec,
    })),
  };
}

/** The body's signed distance: the blend of simple shapes, before the scan takes over. */
function bodyDistance(p: Vec, b: Body): number {
  let d = ellipsoid(p, b.skull.center, b.skull.radii);
  d = smin(d, ellipsoid(p, b.jaw.center, b.jaw.radii), 0.03);
  const n = b.neck;
  d = smin(d, column(p, n.cx, n.cz, n.rx, n.rz, n.bottom, n.top), 0.03);
  d = smin(d, ellipsoid(p, b.torso.center, b.torso.radii), 0.05);
  for (const s of b.shoulders) d = smin(d, ellipsoid(p, s.center, s.radii), 0.04);
  return d;
}

/**
 * The full signed distance. Near the face the scan takes over: inside its outline (seen from the
 * front) and close to it, the distance is to the scan's surface, fading back to the body over
 * 3 cm outside the outline, so the surface leaves the scan's edge smoothly.
 */
function makeDistance(scan: Scan, index: ScanIndex, body: Body) {
  const loop = scan.outline.map((i) => scan.positions[i]);
  const front = new FrontHeight(scan);
  return (p: Vec): number => {
    const shapes = bodyDistance(p, body);
    // The cheap checks first: most of the grid is nowhere near the face.
    const outside = outlineDistance2D(p, loop);
    if (outside > 0.03) return shapes;
    const surfaceZ = front.at(p[0], p[1]) ?? closestOnOutline(p, scan).point[2];
    // Only in front: deep behind the face the body takes over again.
    const w = (1 - smoothstep(0, 0.03, outside)) * smoothstep(surfaceZ - 0.05, surfaceZ - 0.025, p[2]);
    if (w <= 0) return shapes;
    // Distance along the nearest triangle's normal: past the scan's edge this continues the
    // surface in the direction it was heading, instead of curling around the edge (a crease).
    const near = index.nearest(p, 0.03);
    const scanDistance = near ? dot(sub(p, near.point), near.normal) : p[2] > surfaceZ ? 0.03 : -0.03;
    return shapes * (1 - w) + scanDistance * w;
  };
}

/**
 * A simple ear, built on its own at a finer spacing than the head (an ear is thinner than the
 * head's grid): a shallow cup whose rim stands out from the head, more at the back and top, with a
 * rolled edge. It sits on the head's side, tilted back a little like real ears.
 */
function earMesh(ear: Ear, baseX: number): { positions: Vec[]; triangles: [number, number, number][] } {
  const side = Math.sign(ear.center[0]);
  const base: Vec = [side * baseX, ear.center[1], ear.center[2]];
  const out = norm([side, 0, -0.3]);
  const up = norm([0, 1, -0.12]);
  const forward = norm(cross(up, out));
  const facing = side > 0 ? 1 : -1;
  const rings = [0, 0.35, 0.65, 0.85, 1, 0.92];
  const lift = [0.002, 0.004, 0.008, 0.012, 0.016, 0.018];
  const segments = 20;
  const positions: Vec[] = [];
  for (let r = 0; r < rings.length; r++) {
    for (let s = 0; s < segments; s++) {
      const t = (s / segments) * Math.PI * 2;
      const across = Math.sin(t) * facing;
      // The back and top of the rim stand out farther than the front, where the ear meets the cheek.
      const flare = 0.55 + 0.45 * smoothstep(-1, 1, -across * 0.7 + Math.cos(t) * 0.3);
      const k = rings[r];
      positions.push(
        add(
          base,
          add(
            add(mul(up, Math.cos(t) * ear.halfHeight * k), mul(forward, Math.sin(t) * ear.halfWidth * k)),
            mul(out, lift[r] * (r === 0 ? 1 : flare)),
          ),
        ),
      );
    }
  }
  const triangles: [number, number, number][] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * segments + s;
      const b = r * segments + ((s + 1) % segments);
      const c = (r + 1) * segments + ((s + 1) % segments);
      const d = (r + 1) * segments + s;
      triangles.push([a, b, c], [a, c, d]);
    }
  }
  return { positions, triangles };
}

// ---------------------------------------------------------------- meshing

/** Surface nets: one point per grid cell the surface crosses, joined into quads, split into triangles. */
function surfaceNets(distance: (p: Vec) => number) {
  const n = [0, 1, 2].map((k) => Math.round((BOUNDS.max[k] - BOUNDS.min[k]) / CELL) + 1);
  const at = (i: number, j: number, k: number): Vec => [
    BOUNDS.min[0] + i * CELL,
    BOUNDS.min[1] + j * CELL,
    BOUNDS.min[2] + k * CELL,
  ];
  const field = new Float32Array(n[0] * n[1] * n[2]);
  const idx = (i: number, j: number, k: number) => (k * n[1] + j) * n[0] + i;
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) field[idx(i, j, k)] = distance(at(i, j, k));

  const cellVertex = new Int32Array((n[0] - 1) * (n[1] - 1) * (n[2] - 1)).fill(-1);
  const cidx = (i: number, j: number, k: number) => (k * (n[1] - 1) + j) * (n[0] - 1) + i;
  const positions: Vec[] = [];
  const corners: [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (let k = 0; k < n[2] - 1; k++) for (let j = 0; j < n[1] - 1; j++) for (let i = 0; i < n[0] - 1; i++) {
    const values = corners.map(([a, b, c]) => field[idx(i + a, j + b, k + c)]);
    if (values.every((v) => v < 0) || values.every((v) => v >= 0)) continue;
    let sum: Vec = [0, 0, 0];
    let count = 0;
    for (const [a, b] of edges) {
      if (values[a] < 0 === values[b] < 0) continue;
      const t = values[a] / (values[a] - values[b]);
      const pa = at(i + corners[a][0], j + corners[a][1], k + corners[a][2]);
      const pb = at(i + corners[b][0], j + corners[b][1], k + corners[b][2]);
      sum = add(sum, add(pa, mul(sub(pb, pa), t)));
      count++;
    }
    cellVertex[cidx(i, j, k)] = positions.push(mul(sum, 1 / count)) - 1;
  }

  const triangles: [number, number, number][] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    // Split along the shorter diagonal, for better-shaped triangles.
    if (len(sub(positions[a], positions[c])) < len(sub(positions[b], positions[d]))) {
      triangles.push([a, b, c], [a, c, d]);
    } else triangles.push([a, b, d], [b, c, d]);
  };
  for (let k = 1; k < n[2] - 1; k++) for (let j = 1; j < n[1] - 1; j++) for (let i = 1; i < n[0] - 1; i++) {
    const inside = field[idx(i, j, k)] < 0;
    // An edge along x from (i, j, k) crossing the surface joins the four cells around it.
    if (i < n[0] - 1 && inside !== field[idx(i + 1, j, k)] < 0) {
      quad(cellVertex[cidx(i, j - 1, k - 1)], cellVertex[cidx(i, j, k - 1)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i, j - 1, k)], inside);
    }
    if (j < n[1] - 1 && inside !== field[idx(i, j + 1, k)] < 0) {
      quad(cellVertex[cidx(i - 1, j, k - 1)], cellVertex[cidx(i - 1, j, k)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i, j, k - 1)], inside);
    }
    if (k < n[2] - 1 && inside !== field[idx(i, j, k + 1)] < 0) {
      quad(cellVertex[cidx(i - 1, j - 1, k)], cellVertex[cidx(i, j - 1, k)], cellVertex[cidx(i, j, k)], cellVertex[cidx(i - 1, j, k)], inside);
    }
  }
  return { positions, triangles };
}

/** Evens the spacing out (each point moves toward its neighbors' average), then back onto the surface. */
function relax(mesh: { positions: Vec[]; triangles: [number, number, number][] }, distance: (p: Vec) => number, rounds = 4) {
  const neighbors = mesh.positions.map(() => new Set<number>());
  for (const [a, b, c] of mesh.triangles) {
    neighbors[a].add(b).add(c);
    neighbors[b].add(a).add(c);
    neighbors[c].add(a).add(b);
  }
  const h = 0.0005;
  for (let round = 0; round < rounds; round++) {
    const next = mesh.positions.map((p, i) => {
      if (neighbors[i].size === 0) return p;
      let avg: Vec = [0, 0, 0];
      for (const j of neighbors[i]) avg = add(avg, mesh.positions[j]);
      return add(mul(p, 0.5), mul(avg, 0.5 / neighbors[i].size));
    });
    mesh.positions = next.map((p) => {
      const d = distance(p);
      const g: Vec = [
        distance(add(p, [h, 0, 0])) - distance(add(p, [-h, 0, 0])),
        distance(add(p, [0, h, 0])) - distance(add(p, [0, -h, 0])),
        distance(add(p, [0, 0, h])) - distance(add(p, [0, 0, -h])),
      ];
      const gl = len(g) / (2 * h);
      // Where the field bends sharply the step can overshoot, so never move more than a cell.
      if (gl < 1e-6) return p;
      const step = Math.max(-CELL, Math.min(CELL, d / gl));
      return sub(p, mul(norm(g), step));
    });
  }
}

/** Keeps the largest connected piece, dropping specks the grid leaves behind. */
function largestPiece(positions: Vec[], triangles: [number, number, number][]) {
  const parent = positions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b, c] of triangles) {
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  const size = new Map<number, number>();
  for (const [a] of triangles) size.set(find(a), (size.get(find(a)) ?? 0) + 1);
  const biggest = [...size.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  return triangles.filter(([a]) => find(a) === biggest);
}

// ---------------------------------------------------------------- main

function uniqueEdges(triangles: number[][]): Uint16Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  for (const f of triangles) for (let k = 0; k < f.length; k++) {
    const a = Math.min(f[k], f[(k + 1) % f.length]);
    const b = Math.max(f[k], f[(k + 1) % f.length]);
    if (!seen.has(a * 65_536 + b)) {
      seen.add(a * 65_536 + b);
      edges.push(a, b);
    }
  }
  return new Uint16Array(edges);
}

async function main() {
  const scan = await loadScan();
  const index = new ScanIndex(scan);
  const photos = await loadPhotos(scan);
  const front = photos.find((p) => p.shot.name === "front");
  const measured = front ? measureHead(scan, front) : undefined;
  const head = measured ?? { halfWidth: 0.083, top: scan.topY + 0.06 };

  // The ears sit on the side of the head; find them in the turned photos.
  const eyeZ = (scan.eyes.left[2] + scan.eyes.right[2]) / 2;
  const sideX = head.halfWidth - 0.012;
  const ears = ([1, -1] as const).map((side) => findEar(side, scan, photos, sideX, eyeZ));
  const halfLength = measureBack(scan, photos, head, skullFront(scan), skullCenterY(scan), eyeZ);
  const neckHalfWidth = front ? measureNeck(scan, front) : undefined;
  const body = designBody(scan, head, { halfLength, neckHalfWidth });
  const distance = makeDistance(scan, index, body);

  const mesh = surfaceNets(distance);
  relax(mesh, distance);

  // Cut away the face (where the scan covers the surface) and the open chest below the cut. A
  // point is covered if it's inside the outline seen from the front and just behind the scan's
  // front surface; the underside of the chin is farther back, so it stays and joins the neck.
  const loop = scan.outline.map((i) => scan.positions[i]);
  const frontHeight = new FrontHeight(scan);
  const covered = mesh.positions.map((p) => {
    if (p[1] < CHEST_CUT) return true;
    if (outlineDistance2D(p, loop) > 0) return false;
    const z = frontHeight.at(p[0], p[1]);
    // In the eye and mouth openings there's no front surface; drop what's close to the scan there.
    if (z === undefined) return index.nearest(p, 0.012) !== undefined;
    return p[2] > z - 0.012;
  });
  let triangles = mesh.triangles.filter((t) => !t.some((i) => covered[i]));
  triangles = largestPiece(mesh.positions, triangles);
  // Snap the hole's edge onto the scan's outline, so the head starts exactly where the face ends.
  const used = new Set(triangles.flat());
  const edgeOfHole = new Set<number>();
  for (const t of mesh.triangles) if (t.some((i) => covered[i])) for (const i of t) if (used.has(i) && !covered[i]) edgeOfHole.add(i);
  for (const i of edgeOfHole) {
    const p = mesh.positions[i];
    if (p[1] < CHEST_CUT + 0.02) continue;
    const near = closestOnOutline(p, scan);
    if (near.distance < 0.015) mesh.positions[i] = near.point;
  }
  // Renumber to the points still in use.
  const renumber = new Map<number, number>();
  const positions: Vec[] = [];
  for (const t of triangles) for (const i of t) if (!renumber.has(i)) renumber.set(i, positions.push(mesh.positions[i]) - 1);
  const faces = triangles.map((t) => t.map((i) => renumber.get(i)!) as [number, number, number]);
  // The ears go on the head's surface: find it by walking out from the middle of the head.
  for (const ear of ears) {
    const side = Math.sign(ear.center[0]);
    let x = 0;
    while (x < 0.15 && distance([side * x, ear.center[1], ear.center[2]]) < 0) x += 0.001;
    const piece = earMesh(ear, x - 0.002);
    const offset = positions.length;
    positions.push(...piece.positions);
    for (const [a, b, c] of piece.triangles) faces.push([a + offset, b + offset, c + offset]);
  }
  if (positions.length >= 65_536) throw new Error(`${positions.length} points is too many for 16-bit indices; raise CELL`);

  // Seam: points near the scan's edge follow the outline vertex nearest them.
  const seamIndex: number[] = [];
  const seamWeight: number[] = [];
  for (const p of positions) {
    const near = closestOnOutline(p, scan);
    seamIndex.push(near.vertex);
    seamWeight.push(near.distance < SEAM ? 1 - smoothstep(0, SEAM, near.distance) : 0);
  }

  // The head turns about the top of the neck, a little below and in front of the ears' middle;
  // the neck blends from the jaw down into still shoulders.
  const earMid = mul(add(ears[0].center, ears[1].center), 0.5);
  const pivot: Vec = [0, earMid[1] - 0.015, earMid[2] + 0.015];
  const neckBaseY = body.neck.bottom + 0.06;
  const headWeight = positions.map((p) => smoothstep(neckBaseY, scan.chinY, p[1]));

  // Scalp: points behind and above the face, away from the face's edge and the ears.
  const nearEar = (p: Vec) => ears.some((e) => len(sub(p, e.center)) < e.halfHeight + 0.006);
  const isScalp = (i: number) => {
    const p = positions[i];
    if (headWeight[i] < 1 || seamWeight[i] > 0.5 || nearEar(p)) return false;
    return p[1] > scan.eyeY + 0.02 || (p[2] < earMid[2] + 0.005 && p[1] > earMid[1] - 0.045);
  };
  const scalp = faces.filter((t) => t.every(isScalp)).flat();

  // Colors from the photos: each point takes the color of the photo that sees it most squarely,
  // through that photo's camera. Points no photo sees (the back of the head, under the chin) fall
  // back to dark hair above the neck and a white shirt below. Stored linear, as glTF expects.
  const normals = positions.map(() => [0, 0, 0] as Vec);
  for (const [a, b, c] of faces) {
    const n = cross(sub(positions[b], positions[a]), sub(positions[c], positions[a]));
    for (const i of [a, b, c]) normals[i] = add(normals[i], n);
  }
  const outward = (i: number) => {
    // Triangles from surface nets don't all wind the same way: point the normal away from the body's middle.
    const n = norm(normals[i]);
    const p = positions[i];
    const middle: Vec = p[1] > body.neck.bottom + 0.06 ? body.skull.center : [0, p[1], body.neck.cz];
    return dot(n, sub(p, middle)) < 0 ? mul(n, -1) : n;
  };
  const toLinear = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const colors = new Float32Array(positions.length * 3);
  let seen = 0;
  positions.forEach((p, i) => {
    const n = outward(i);
    let total = 0;
    const sum = [0, 0, 0];
    for (const photo of photos) {
      const facing = dot(n, norm(sub(photo.shot.cameraInFace as Vec, p)));
      if (facing <= 0.2) continue;
      const c = pixel(photo, p);
      if (!c) continue;
      const w = facing ** 3;
      total += w;
      for (let k = 0; k < 3; k++) sum[k] += w * toLinear(c[k]);
    }
    let rgb: number[];
    if (total > 0) {
      rgb = sum.map((s) => s / total);
      seen++;
    } else rgb = p[1] < neckBaseY - 0.01 ? [0.66, 0.66, 0.64] : [0.006, 0.004, 0.003];
    colors.set(rgb, i * 3);
  });

  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type: Accessor.Type, array: Float32Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const position = accessor(Accessor.Type.VEC3, new Float32Array(positions.flat()));
  const attributes = {
    COLOR_0: accessor(Accessor.Type.VEC3, colors),
    _HEAD_WEIGHT: accessor(Accessor.Type.SCALAR, new Float32Array(headWeight)),
    _SEAM_INDEX: accessor(Accessor.Type.SCALAR, new Float32Array(seamIndex)),
    _SEAM_WEIGHT: accessor(Accessor.Type.SCALAR, new Float32Array(seamWeight)),
  };
  const edges = uniqueEdges(faces);
  const surface = doc
    .createPrimitive()
    .setMode(Primitive.Mode.TRIANGLES)
    .setIndices(accessor(Accessor.Type.SCALAR, new Uint16Array(faces.flat())))
    .setAttribute("POSITION", position);
  const lines = doc
    .createPrimitive()
    .setMode(Primitive.Mode.LINES)
    .setIndices(accessor(Accessor.Type.SCALAR, edges))
    .setAttribute("POSITION", position);
  for (const [name, a] of Object.entries(attributes)) {
    surface.setAttribute(name, a);
    lines.setAttribute(name, a);
  }
  const t = body.torso;
  const node = doc
    .createNode("Head")
    .setMesh(doc.createMesh("Head").addPrimitive(surface).addPrimitive(lines))
    .setExtras({
      units: "m",
      source: "Generated around the scan by tools/head/build.ts",
      pivot,
      eyeY: scan.eyeY,
      scalp,
      torso: { center: t.center, radii: t.radii.map((r) => r + 0.004) },
      neck: { center: [body.neck.cx, body.neck.cz], radius: Math.max(body.neck.rx, body.neck.rz) + 0.004, top: scan.chinY, bottom: neckBaseY },
      ears: ears.map((e) => ({ center: e.center, halfHeight: e.halfHeight, halfWidth: e.halfWidth })),
      measured: { head: measured ?? null, ears: ears.map((e) => e.measured), halfLength: halfLength ?? null, neckHalfWidth: neckHalfWidth ?? null },
    });
  doc.createScene("Head").addChild(node);
  doc.getRoot().getAsset().generator = "portfolio tools/head/build.ts";
  await writeFile(OUT, await new NodeIO().setVertexLayout(VertexLayout.SEPARATE).writeBinary(doc));

  // HEAD_OVERLAY=<folder> draws the head (green) and the scan (red) over each texture photo, through
  // that photo's camera, to compare their outlines. The images are private: write them outside the repo.
  if (process.env.HEAD_OVERLAY) {
    for (const photo of photos) {
      const out = new Uint8Array(photo.data);
      const dot2 = (p: Vec, rgb: [number, number, number]) => {
        const [u, v] = photo.project(p).map(Math.round);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const x = u + dx;
          const y = v + dy;
          if (x < 0 || y < 0 || x >= photo.width || y >= photo.height) continue;
          const k = (y * photo.width + x) * 4;
          [out[k], out[k + 1], out[k + 2]] = rgb;
        }
      };
      positions.forEach((p, i) => i % 2 === 0 && dot2(p, [40, 255, 60]));
      scan.positions.forEach((p) => dot2(p, [255, 40, 40]));
      const file = join(process.env.HEAD_OVERLAY, `overlay-${photo.shot.name}.jpg`);
      await writeFile(file, jpeg.encode({ data: out, width: photo.width, height: photo.height }, 80).data);
      console.log(`  ${file}`);
    }
  }

  console.log(`${positions.length} points, ${faces.length} triangles, ${edges.length / 2} lines, ${scalp.length / 3} scalp triangles`);
  console.log(`Colors: ${seen} of ${positions.length} points seen in a photo; the rest use hair or shirt colors`);
  console.log(
    measured
      ? `Head from the front photo: half-width ${(measured.halfWidth * 100).toFixed(1)} cm, top ${(measured.top * 100).toFixed(1)} cm`
      : "Couldn't measure the head in the front photo; used typical proportions.",
  );
  console.log(
    halfLength
      ? `Back of the head from the turned photos: ${((halfLength * 2) * 100).toFixed(1)} cm from brow to back, with hair`
      : "Couldn't find the back of the head in the turned photos; used a typical length.",
  );
  console.log(neckHalfWidth ? `Neck from the front photo: ${(neckHalfWidth * 200).toFixed(1)} cm wide` : "Couldn't measure the neck; used a typical width.");
  ears.forEach((e, i) =>
    console.log(
      `${i === 0 ? "Left" : "Right"} ear: ${e.measured ? "found in a turned photo" : "typical position (not found in the photos)"}, ` +
        `${(e.halfHeight * 200).toFixed(1)} × ${(e.halfWidth * 200).toFixed(1)} cm`,
    ),
  );
  console.log(`  ${OUT.slice(ROOT.length + 1)}`);
}

await main();

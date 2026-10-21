/**
 * Builds the head, neck and shoulders around the scanned face (plan §5.8), from MakeHuman's base
 * body (CC0: free for any use, no credit needed). Run `npm run head` after `npm run face`.
 *
 * Reads knowledge/faceScan/ (face.json, texture.json, texture-front.jpg) and writes
 * apps/site/public/face/head.glb, which also opens in Blender. The steps:
 *   1. Line up the base with the scan by the eye centers and the nose tip.
 *   2. Reshape the base's face onto the scan, fading the change out across the head.
 *   3. Cut the base's face away where the scan covers it, and snap the hole's edge to the scan's.
 *   4. Size the head from the front photo, where the hair is tied back.
 *   5. Weights: which points follow the face's expressions (the seam) and how much each point
 *      turns with the head (the neck blends into still shoulders).
 *   6. The scalp and simple body shapes the browser grows and drapes the hair on.
 * The scanned face itself is never changed: the site draws it from face.glb, as before.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accessor, Document, NodeIO, Primitive, VertexLayout } from "@gltf-transform/core";
import jpeg from "jpeg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN = join(ROOT, "knowledge/faceScan");
const OUT = join(ROOT, "apps/site/public/face/head.glb");
const CACHE = join(ROOT, "tools/head/.cache");

/** MakeHuman's base mesh, pinned to the last commit that changed it, and checked on download. */
const BASE_URL =
  "https://raw.githubusercontent.com/makehumancommunity/makehuman/3c701a8e52f09e69922e8b598d23be2d7dfc49e3/makehuman/data/3dobjs/base.obj";
const BASE_SHA256 = "8e761e6624b8f54536409135d1636da63b32486a90d4897f84e121d144f6fb4c";

/** The base is in decimeters with its feet at y = -8.2; keep everything above the upper chest. */
const CROP = { minY: 4.7, maxAbsX: 2.1 };
/** How far the reshaping reaches from the face, and how near the scan a base point must be to count. */
const RESHAPE = { sigma: 0.016, reach: 0.03, iterations: 3 };
/** Head points within this distance of the scan's edge follow its expressions (meters). */
const SEAM = 0.03;

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec) => Math.sqrt(dot(a, a));
const mid = (a: Vec, b: Vec): Vec => mul(add(a, b), 0.5);
const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- base mesh

async function baseObj(): Promise<string> {
  const file = join(CACHE, "base.obj");
  if (!existsSync(file)) {
    console.log("Downloading MakeHuman's base mesh (CC0)…");
    const response = await fetch(BASE_URL);
    if (!response.ok) throw new Error(`${BASE_URL}: HTTP ${response.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = await readFile(file);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== BASE_SHA256) throw new Error(`${file} doesn't match the pinned base mesh; delete it and re-run`);
  return bytes.toString("utf8");
}

interface Base {
  positions: Vec[];
  /** Quads (and a few triangles), as indices into positions. */
  faces: number[][];
  /** Joint positions: the centers of the small marker cubes MakeHuman places at each joint. */
  joints: Record<string, Vec>;
}

function parseBase(text: string): Base {
  const all: Vec[] = [];
  const groups = new Map<string, number[][]>();
  let group = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) {
      const [x, y, z] = line.split(/\s+/).slice(1, 4).map(Number);
      all.push([x, y, z]);
    } else if (line.startsWith("g ")) group = line.slice(2).trim();
    else if (line.startsWith("f ")) {
      const face = line
        .split(/\s+/)
        .slice(1)
        .filter(Boolean)
        .map((token) => Number.parseInt(token, 10) - 1);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(face);
    }
  }
  const joints: Record<string, Vec> = {};
  for (const [name, faces] of groups) {
    if (!name.startsWith("joint-")) continue;
    const ids = [...new Set(faces.flat())];
    joints[name.slice("joint-".length)] = mul(ids.map((i) => all[i]).reduce(add, [0, 0, 0]), 1 / ids.length);
  }
  // Crop the body to the head, neck and shoulders, and renumber its points.
  const keep = (i: number) => all[i][1] > CROP.minY && Math.abs(all[i][0]) < CROP.maxAbsX;
  const faces = (groups.get("body") ?? []).filter((f) => f.every(keep));
  const renumber = new Map<number, number>();
  const positions: Vec[] = [];
  for (const f of faces) for (const i of f) if (!renumber.has(i)) renumber.set(i, positions.push(all[i]) - 1);
  return { positions, faces: faces.map((f) => f.map((i) => renumber.get(i)!)), joints };
}

// ---------------------------------------------------------------- scan

interface Scan {
  positions: Vec[];
  triangles: [number, number, number][];
  eyes: { left: Vec; right: Vec; radius: number };
  /** The scan's outer edge, as a loop of vertex indices. */
  outline: number[];
  noseTip: Vec;
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
  // The longest edge loop is the outline; the shorter ones are the eye and mouth openings.
  const outline = boundaryLoops(triangles).sort((a, b) => b.length - a.length)[0];
  const noseTip = positions.reduce((a, b) => (b[2] > a[2] ? b : a));
  return { positions, triangles, eyes: face.eyes, outline, noseTip };
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

function closestOnScan(p: Vec, scan: Scan): Vec {
  let best: Vec = scan.positions[0];
  let bestD = Infinity;
  for (const [i, j, k] of scan.triangles) {
    const q = closestOnTriangle(p, scan.positions[i], scan.positions[j], scan.positions[k]);
    const d = len(sub(p, q));
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Is p inside the scan's outline, seen from the front (along z)? */
function insideOutline(p: Vec, scan: Scan): boolean {
  let inside = false;
  const loop = scan.outline.map((i) => scan.positions[i]);
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i];
    const [xj, yj] = loop[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / dot(ab, ab)));
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (d < best.distance) best = { point: q, vertex: t < 0.5 ? ia : ib, distance: d };
  }
  return best;
}

// ---------------------------------------------------------------- fitting

/** Step 1: scale by eye spacing, move eye midpoints together, and tip to match the nose's angle. */
function lineUp(base: Base, scan: Scan): (p: Vec) => Vec {
  const baseL = base.joints["l-eye"];
  const baseR = base.joints["r-eye"];
  const baseMid = mid(baseL, baseR);
  const baseNose = base.positions
    .filter((p) => Math.abs(p[0]) < 0.05 && p[1] > baseMid[1] - 0.6 && p[1] < baseMid[1])
    .reduce((a, b) => (b[2] > a[2] ? b : a));
  const scanMid = mid(scan.eyes.left, scan.eyes.right);
  const scale = (scan.eyes.left[0] - scan.eyes.right[0]) / (baseL[0] - baseR[0]);
  const angle = (from: Vec, to: Vec) => Math.atan2(to[2] - from[2], -(to[1] - from[1]));
  const pitch = angle(scanMid, scan.noseTip) - angle(baseMid, baseNose);
  const [c, s] = [Math.cos(pitch), Math.sin(pitch)];
  return (p) => {
    const [x, y, z] = mul(sub(p, baseMid), scale);
    // Rotate about x so the eye-to-nose direction matches.
    return add(scanMid, [x, y * c + z * s, -y * s + z * c]);
  };
}

/** Step 2: pull base points near the scan onto it, and spread the change smoothly, fading with distance. */
function reshape(positions: Vec[], scan: Scan): void {
  for (let iteration = 0; iteration < RESHAPE.iterations; iteration++) {
    const anchors: { at: Vec; move: Vec }[] = [];
    for (const p of positions) {
      if (!insideOutline(p, scan)) continue;
      const q = closestOnScan(p, scan);
      if (len(sub(q, p)) < RESHAPE.reach) anchors.push({ at: p, move: sub(q, p) });
    }
    const twoSigma2 = 2 * RESHAPE.sigma * RESHAPE.sigma;
    // A constant weight for "don't move" makes points far from every anchor stay put.
    const stay = 0.05;
    const moved = positions.map((p) => {
      let total = stay;
      let shift: Vec = [0, 0, 0];
      for (const a of anchors) {
        const d = sub(p, a.at);
        const w = Math.exp(-dot(d, d) / twoSigma2);
        if (w < 1e-4) continue;
        total += w;
        shift = add(shift, mul(a.move, w));
      }
      return add(p, mul(shift, 1 / total));
    });
    moved.forEach((p, i) => (positions[i] = p));
  }
}

/** Step 3: drop base faces where the scan covers them; snap the hole's edge onto the scan's outline. */
function cutFace(base: { positions: Vec[]; faces: number[][] }, scan: Scan): { positions: Vec[]; faces: number[][] } {
  const covered = base.positions.map((p) => insideOutline(p, scan) && len(sub(closestOnScan(p, scan), p)) < 0.012);
  const faces = base.faces.filter((f) => !f.some((i) => covered[i]));
  const edgeOfHole = new Set<number>();
  for (const f of base.faces) if (f.some((i) => covered[i])) for (const i of f) if (!covered[i]) edgeOfHole.add(i);
  const positions = base.positions.map((p) => [...p] as Vec);
  for (const i of edgeOfHole) {
    const near = closestOnOutline(positions[i], scan);
    if (near.distance < 0.025) positions[i] = near.point;
  }
  // Renumber, dropping points no face uses any more.
  const renumber = new Map<number, number>();
  const kept: Vec[] = [];
  for (const f of faces) for (const i of f) if (!renumber.has(i)) renumber.set(i, kept.push(positions[i]) - 1);
  return { positions: kept, faces: faces.map((f) => f.map((i) => renumber.get(i)!)) };
}

// ---------------------------------------------------------------- photo

interface Shot {
  name: string;
  image: string;
  width: number;
  height: number;
  pixels: number[];
}

/**
 * Step 4: measure the head's width and top in the front photo. A straight-on photo is close to a
 * flat projection, so a least-squares fit from the scan's points to their pixels maps face space
 * to the photo. From the scan's edge the script walks outward until dark hair gives way to the
 * lighter wall.
 */
async function measureHead(scan: Scan): Promise<{ halfWidth: number; top: number } | undefined> {
  const texture = JSON.parse(await readFile(join(SCAN, "texture.json"), "utf8")) as { shots: Shot[] };
  const shot = texture.shots.find((s) => s.name === "front");
  if (!shot) return undefined;
  const photo = jpeg.decode(await readFile(join(SCAN, shot.image)), { useTArray: true });

  // Fit u and v each as a·x + b·y + c·z + d (normal equations, 4 × 4).
  const rows = scan.positions.map((p) => [p[0], p[1], p[2], 1]);
  const solve = (target: number[]) => {
    const m = Array.from({ length: 4 }, () => new Array(5).fill(0));
    rows.forEach((r, n) => {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) m[i][j] += r[i] * r[j];
        m[i][4] += r[i] * target[n];
      }
    });
    for (let i = 0; i < 4; i++) {
      const pivot = m[i][i];
      for (let j = i; j < 5; j++) m[i][j] /= pivot;
      for (let k = 0; k < 4; k++) if (k !== i) {
        const f = m[k][i];
        for (let j = i; j < 5; j++) m[k][j] -= f * m[i][j];
      }
    }
    return m.map((row) => row[4]);
  };
  const cu = solve(scan.positions.map((_, i) => shot.pixels[i * 2]));
  const cv = solve(scan.positions.map((_, i) => shot.pixels[i * 2 + 1]));
  const luminance = (p: Vec) => {
    const u = Math.round(cu[0] * p[0] + cu[1] * p[1] + cu[2] * p[2] + cu[3]);
    const v = Math.round(cv[0] * p[0] + cv[1] * p[1] + cv[2] * p[2] + cv[3]);
    if (u < 0 || v < 0 || u >= photo.width || v >= photo.height) return undefined;
    const k = (v * photo.width + u) * 4;
    return 0.2126 * photo.data[k] + 0.7152 * photo.data[k + 1] + 0.0722 * photo.data[k + 2];
  };
  // Walk from a start point in steps of 1 mm: first into dark hair (skin is light too, so a light
  // pixel only counts after the hair), then out until three samples in a row are light.
  const walk = (start: Vec, step: Vec, limit = 0.12) => {
    let dark = 0;
    let light = 0;
    for (let t = 0; t < limit; t += 0.001) {
      const l = luminance(add(start, mul(step, t)));
      if (l === undefined) return undefined;
      if (dark < 3) {
        dark = l < 70 ? dark + 1 : 0;
        continue;
      }
      light = l > 125 ? light + 1 : 0;
      if (light === 3) return t - 0.002;
    }
    return undefined;
  };
  const eyeY = (scan.eyes.left[1] + scan.eyes.right[1]) / 2;
  const top = scan.positions.reduce((a, b) => (b[1] > a[1] ? b : a));
  const rise = walk(top, [0, 1, 0]);
  // At temple height, start from the scan's edge on each side.
  const temple = eyeY + 0.025;
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

/** Scale the cranium (above the ears) to the measured width and top, leaving the seam and neck alone. */
function sizeHead(positions: Vec[], seamWeight: number[], measured: { halfWidth: number; top: number }, eyeY: number) {
  const temple = eyeY + 0.025;
  const band = positions.filter((p) => Math.abs(p[1] - temple) < 0.006);
  const baseHalfWidth = Math.max(...band.map((p) => Math.abs(p[0])));
  const baseTop = Math.max(...positions.map((p) => p[1]));
  // Tied-back hair still adds a little thickness over the skull.
  const hair = 0.006;
  const clampScale = (k: number) => Math.min(1.2, Math.max(0.85, k));
  const kx = clampScale((measured.halfWidth - hair) / baseHalfWidth);
  const ky = clampScale((measured.top - hair - eyeY) / (baseTop - eyeY));
  positions.forEach((p, i) => {
    const free = 1 - seamWeight[i];
    // Full effect above the eyes, fading out down to the jaw.
    const k = free * smoothstep(eyeY - 0.06, eyeY, p[1]);
    p[0] *= 1 + (kx - 1) * k;
    if (p[1] > eyeY) p[1] = eyeY + (p[1] - eyeY) * (1 + (ky - 1) * k);
  });
  return { kx, ky, baseHalfWidth, baseTop };
}

// ---------------------------------------------------------------- output

function quadEdges(faces: number[][]): Uint16Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  for (const f of faces) for (let k = 0; k < f.length; k++) {
    const a = f[k];
    const b = f[(k + 1) % f.length];
    const key = Math.min(a, b) * 65_536 + Math.max(a, b);
    if (!seen.has(key)) {
      seen.add(key);
      edges.push(Math.min(a, b), Math.max(a, b));
    }
  }
  return new Uint16Array(edges);
}

/** An axis-aligned ellipsoid around points, grown by `pad` meters. */
function ellipsoid(points: Vec[], pad: number) {
  const lo: Vec = [Infinity, Infinity, Infinity];
  const hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  return { center: mid(lo, hi), radii: mul(sub(hi, lo), 0.5).map((r) => r + pad) as Vec };
}

async function main() {
  const base = parseBase(await baseObj());
  const scan = await loadScan();
  const eyeY = (scan.eyes.left[1] + scan.eyes.right[1]) / 2;

  const toScan = lineUp(base, scan);
  const aligned = base.positions.map(toScan);
  const joints = Object.fromEntries(Object.entries(base.joints).map(([k, v]) => [k, toScan(v)])) as Record<string, Vec>;
  reshape(aligned, scan);
  const head = cutFace({ positions: aligned, faces: base.faces }, scan);

  // Seam: points near the scan's edge follow the outline vertex nearest them.
  const seamIndex: number[] = [];
  const seamWeight: number[] = [];
  for (const p of head.positions) {
    const near = closestOnOutline(p, scan);
    seamIndex.push(near.vertex);
    seamWeight.push(near.distance < SEAM ? 1 - smoothstep(0, SEAM, near.distance) : 0);
  }

  const measured = await measureHead(scan);
  const sizing = measured ? sizeHead(head.positions, seamWeight, measured, eyeY) : undefined;

  // The head turns about the top of the neck; the neck blends from the jaw down into still shoulders.
  const pivot = joints.head;
  const chinY = Math.min(...scan.positions.map((p) => p[1]));
  const neckBaseY = joints.neck[1];
  const headWeight = head.positions.map((p) => smoothstep(neckBaseY, chinY, p[1]));

  // Scalp: cranium points behind and above the face, but not the ears or the face's edge.
  const earY = eyeY - 0.015;
  const isScalp = (i: number) => {
    const p = head.positions[i];
    if (headWeight[i] < 1 || seamWeight[i] > 0.5) return false;
    const ear = Math.abs(p[0]) > 0.06 && p[1] < eyeY + 0.01 && p[1] > eyeY - 0.06;
    if (ear) return false;
    return p[1] > eyeY + 0.02 || (p[2] < pivot[2] + 0.02 && p[1] > earY - 0.05);
  };
  const triangles: number[] = [];
  const scalp: number[] = [];
  for (const f of head.faces) {
    const tris = f.length === 4 ? [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] : [f];
    for (const t of tris) {
      triangles.push(...t);
      if (t.every(isScalp)) scalp.push(...t);
    }
  }
  const scalpPoints = [...new Set(scalp)].map((i) => head.positions[i]);
  // Shoulders: a dome that slopes down from the neck like real shoulders do (a box-shaped fit
  // would have a flat top that hair piles onto). It's as wide as the shoulders and as deep as
  // the upper chest, with its top just above the neck's base.
  const chest = head.positions.filter((p) => p[1] < neckBaseY);
  const zs = chest.map((p) => p[2]);
  const shoulderHalfWidth = Math.abs(joints["l-shoulder"][0]) + 0.045;
  const domeHeight = 0.17;
  const torso = {
    center: [0, neckBaseY + 0.015 - domeHeight, (Math.min(...zs) + Math.max(...zs)) / 2],
    radii: [shoulderHalfWidth, domeHeight, (Math.max(...zs) - Math.min(...zs)) / 2 + 0.004],
  };
  // The neck's radius from its own ring of points: at neck height the shoulders' tops start too,
  // and they're farther out, so take the median of the nearer points.
  const neckDistances = head.positions
    .filter((p) => p[1] < chinY && p[1] > neckBaseY)
    .map((p) => Math.hypot(p[0] - pivot[0], p[2] - pivot[2]))
    .filter((d) => d < 0.09)
    .sort((a, b) => a - b);
  const neckRadius = neckDistances[Math.floor(neckDistances.length / 2)] ?? 0.055;

  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type: Accessor.Type, array: Float32Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const position = accessor(Accessor.Type.VEC3, new Float32Array(head.positions.flat()));
  const attributes = {
    _HEAD_WEIGHT: accessor(Accessor.Type.SCALAR, new Float32Array(headWeight)),
    _SEAM_INDEX: accessor(Accessor.Type.SCALAR, new Float32Array(seamIndex)),
    _SEAM_WEIGHT: accessor(Accessor.Type.SCALAR, new Float32Array(seamWeight)),
  };
  const surface = doc
    .createPrimitive()
    .setMode(Primitive.Mode.TRIANGLES)
    .setIndices(accessor(Accessor.Type.SCALAR, new Uint16Array(triangles)))
    .setAttribute("POSITION", position);
  const lines = doc
    .createPrimitive()
    .setMode(Primitive.Mode.LINES)
    .setIndices(accessor(Accessor.Type.SCALAR, quadEdges(head.faces)))
    .setAttribute("POSITION", position);
  for (const [name, a] of Object.entries(attributes)) {
    surface.setAttribute(name, a);
    lines.setAttribute(name, a);
  }
  const mesh = doc.createMesh("Head").addPrimitive(surface).addPrimitive(lines);
  const node = doc
    .createNode("Head")
    .setMesh(mesh)
    .setExtras({
      units: "m",
      source: "MakeHuman base mesh hm08 (CC0), fitted to the scan by tools/head/build.ts",
      pivot,
      eyeY,
      scalp,
      skull: ellipsoid(scalpPoints, 0.004),
      torso,
      neck: { center: [pivot[0], pivot[2]], radius: neckRadius + 0.004, top: chinY, bottom: neckBaseY },
      shoulders: { left: joints["l-shoulder"], right: joints["r-shoulder"] },
    });
  doc.createScene("Head").addChild(node);
  doc.getRoot().getAsset().generator = "portfolio tools/head/build.ts";
  await writeFile(OUT, await new NodeIO().setVertexLayout(VertexLayout.SEPARATE).writeBinary(doc));

  const edges = quadEdges(head.faces).length / 2;
  console.log(`${head.positions.length} points, ${edges} lines, ${scalp.length / 3} scalp triangles; neck radius ${(neckRadius * 100).toFixed(1)} cm`);
  if (measured && sizing) {
    console.log(
      `Head from the front photo: half-width ${(measured.halfWidth * 100).toFixed(1)} cm, top ${(measured.top * 100).toFixed(1)} cm; ` +
        `scaled the base ${sizing.kx.toFixed(2)}× wide and ${sizing.ky.toFixed(2)}× tall above the eyes`,
    );
  } else console.log("Couldn't measure the head in the front photo; kept the base's proportions.");
  console.log(`  ${OUT.slice(ROOT.length + 1)}`);
}

await main();

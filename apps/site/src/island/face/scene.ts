/**
 * Builds the scene's geometry and materials (plan §5.3, §5.8): the scanned face as points and
 * lines, the eye rings, the fitted head, neck and shoulders, and the hair. Every point carries the
 * attributes the shared shader expects; the render loop in Face.tsx updates them each frame.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { FaceData, HeadData } from "./data";
import type { Hair, HeadShape } from "./hair";
import { settings, type Settings } from "./settings";
import { createMaterial, createOccluder, createRealHair, createSolid, createUniforms } from "./shaders";

/** A repeatable random sequence, so the scatter and twinkle look the same on every visit. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-point random numbers and scatter offsets, for twinkle, dust and the intro. */
function scatterAttributes(count: number, seed: number) {
  const next = random(seed);
  const seeds = new Float32Array(count);
  const scatter = new Float32Array(count * 3);
  const direction = new Vector3();
  for (let i = 0; i < count; i++) {
    seeds[i] = next();
    direction.set(next() * 2 - 1, next() * 2 - 1, next() * 2 - 1).normalize().multiplyScalar(0.5 + next() * 0.5);
    direction.toArray(scatter, i * 3);
  }
  return { seeds, scatter };
}

/**
 * Points around each pupil, just in front of the eyeball's surface (so the eyelid's edge doesn't
 * hide them): an iris ring and a pupil ring.
 */
function eyeRing(radius: number): Float32Array {
  const rings = [
    { r: radius * 0.48, n: 20 },
    { r: radius * 0.2, n: 10 },
  ];
  const points: number[] = [];
  for (const { r, n } of rings) {
    const z = Math.sqrt(radius * radius - r * r) + 0.0025;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      points.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
  }
  return new Float32Array(points);
}

const filled = (count: number, value: number) => new Float32Array(count).fill(value);

function colorsOf(count: number, color: Color) {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) color.toArray(out, i * 3);
  return out;
}

/** The attributes every point needs, apart from its position. */
function standardAttributes(
  geometry: BufferGeometry,
  count: number,
  seed: number,
  extra: { headWeight?: Float32Array; colors?: Float32Array; fade?: BufferAttribute } = {},
) {
  const { seeds, scatter } = scatterAttributes(count, seed);
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));
  geometry.setAttribute("aScatter", new BufferAttribute(scatter, 3));
  geometry.setAttribute("aFade", extra.fade ?? new BufferAttribute(filled(count, 1), 1));
  geometry.setAttribute("aHeadWeight", new BufferAttribute(extra.headWeight ?? filled(count, 1), 1));
  geometry.setAttribute("aColor", new BufferAttribute(extra.colors ?? colorsOf(count, new Color(0.5, 0.5, 0.5)), 3));
  return seeds;
}

/** The average of the face's photo colors, which tints the rest of the head. */
function averageColor(colors: Float32Array | undefined) {
  if (!colors) return new Color(0.55, 0.42, 0.36);
  const sum = [0, 0, 0];
  for (let i = 0; i < colors.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += colors[i + k];
  const n = colors.length / 3;
  return new Color(sum[0] / n, sum[1] / n, sum[2] / n);
}

/**
 * Applies the lab's head-size corrections to the fitted head: wider, taller above the eyes and
 * deeper behind the face. The face's edge (the seam) and the shoulders stay put.
 */
export function shapeHead(head: HeadData, s: Settings["head"], out: Float32Array) {
  const { pivot, eyeY } = head;
  const back = pivot[2] + 0.04;
  for (let i = 0; i < head.vertexCount; i++) {
    let x = head.base[i * 3];
    let y = head.base[i * 3 + 1];
    let z = head.base[i * 3 + 2];
    const t = Math.min(1, Math.max(0, (y - (eyeY - 0.06)) / 0.06));
    const k = (1 - head.seamWeight[i]) * head.headWeight[i] * t * t * (3 - 2 * t);
    x *= 1 + (s.width - 1) * k;
    if (y > eyeY) y = eyeY + (y - eyeY) * (1 + (s.height - 1) * k);
    if (z < back) z = back + (z - back) * (1 + (s.depth - 1) * k);
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
}

/** What the hair grows on and drapes over: the shaped scalp and simple body shapes. */
export function hairShape(head: HeadData, shaped: Float32Array, chinY: number): HeadShape {
  const scalp = new Float32Array(head.scalp.length * 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  head.scalp.forEach((v, i) => {
    for (let k = 0; k < 3; k++) {
      const value = shaped[v * 3 + k];
      scalp[i * 3 + k] = value;
      lo[k] = Math.min(lo[k], value);
      hi[k] = Math.max(hi[k], value);
    }
  });
  // The hair follows the scalp's real shape (hair.ts); this ellipsoid only fills in where there's
  // no scalp to follow, such as the nape.
  return {
    scalp,
    skull: { center: lo.map((l, k) => (l + hi[k]) / 2), radii: lo.map((l, k) => (hi[k] - l) / 2) },
    torso: head.torso,
    neck: head.neck,
    chinY,
  };
}

export function buildScene(data: FaceData) {
  const uniforms = createUniforms();
  const look = settings.look;
  const materials = {
    points: createMaterial(uniforms, "points", look.pointOpacity),
    lines: createMaterial(uniforms, "lines", look.lineOpacity),
    eyes: createMaterial(uniforms, "points", look.eyeOpacity),
    headPoints: createMaterial(uniforms, "points", settings.head.pointOpacity),
    headLines: createMaterial(uniforms, "lines", settings.head.lineOpacity),
    hair: createMaterial(uniforms, "hair", settings.hair.opacity),
    realHair: createRealHair(uniforms),
    occluder: createOccluder(uniforms),
    solidFace: createSolid(uniforms),
    solidHead: createSolid(uniforms),
    // Eyeballs and the mouth's inside are already turned on the CPU, so they use plain materials.
    eyeballs: new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0 }),
    mouth: new MeshBasicMaterial({ color: new Color(0.06, 0.03, 0.03), transparent: true, opacity: 0, side: DoubleSide }),
  };
  // The eye rings always draw on top: hidden by the eyelids' edges they read poorly, and the
  // irises are what follows the visitor.
  materials.eyes.depthTest = false;
  const ATTRIBUTES = ["position", "aSeed", "aScatter", "aFade", "aHeadWeight", "aColor"];
  /** A geometry that shares another's points but draws them as triangles, for the occluder. */
  const surfaceOf = (geometry: BufferGeometry, triangles: Uint16Array) => {
    const surface = new BufferGeometry();
    for (const name of ATTRIBUTES) surface.setAttribute(name, geometry.getAttribute(name));
    surface.setIndex(new BufferAttribute(triangles, 1));
    return surface;
  };

  // The scanned face: one position buffer shared by its points and lines.
  const positions = new Float32Array(data.base);
  const position = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const points = new BufferGeometry();
  points.setAttribute("position", position);
  standardAttributes(points, data.vertexCount, 7, { colors: data.colors });
  const lines = new BufferGeometry();
  for (const name of ATTRIBUTES) lines.setAttribute(name, points.getAttribute(name));
  lines.setIndex(new BufferAttribute(data.edges, 1));
  const surface = surfaceOf(points, data.triangles);
  // Realistic mode's solid face: the same points, plus where each sits in the skin image, and
  // normals recomputed each frame as the expression changes.
  const solidFace = surfaceOf(points, data.triangles);
  solidFace.setAttribute("uv", new BufferAttribute(data.uvs, 2));
  // Without the skin image (it stays on the Mac that made it), the face's point colors stand in.
  solidFace.setAttribute(
    "aSolid",
    new BufferAttribute(
      data.colors ? data.colors.map((c) => c ** (1 / 2.2)) : new Float32Array(data.vertexCount * 3).fill(0.7),
      3,
    ),
  );
  solidFace.computeVertexNormals();

  // Eye rings: positions and fade are written every frame.
  const ring = eyeRing(data.eyes.radius);
  const ringCount = ring.length / 3;
  const eyePositions = new Float32Array(ringCount * 2 * 3);
  const eyeFade = filled(ringCount * 2, 1);
  const eyes = new BufferGeometry();
  eyes.setAttribute("position", new BufferAttribute(eyePositions, 3).setUsage(DynamicDrawUsage));
  const eyeSeeds = standardAttributes(eyes, ringCount * 2, 11, {
    fade: new BufferAttribute(eyeFade, 1).setUsage(DynamicDrawUsage),
  });
  // One seed per eye, so wind sways each ring as a whole instead of breaking up its circle.
  eyeSeeds.fill(0.31, 0, ringCount).fill(0.67, ringCount);

  // The fitted head, neck and shoulders, if tools/head/build.ts has run.
  const skin = averageColor(data.colors);
  // Realistic mode's head colors, in the skin image's own (sRGB) values: the face's average skin
  // tone, dark hair on the scalp, and a shirt like the one in the photos (white, navy sleeves).
  const skinSrgb = [skin.r, skin.g, skin.b].map((c) => Math.min(1, c ** (1 / 2.2) * 1.05));
  let head:
    | {
        geometry: BufferGeometry;
        lines: BufferGeometry;
        surface: BufferGeometry;
        solid: BufferGeometry;
        positions: Float32Array;
        shaped: Float32Array;
        seam: Uint32Array;
      }
    | undefined;
  if (data.head) {
    const h = data.head;
    const headPositions = new Float32Array(h.base);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(headPositions, 3).setUsage(DynamicDrawUsage));
    standardAttributes(geometry, h.vertexCount, 13, {
      headWeight: h.headWeight,
      colors: h.colors ?? colorsOf(h.vertexCount, skin),
    });
    const headLines = new BufferGeometry();
    for (const name of ATTRIBUTES) headLines.setAttribute(name, geometry.getAttribute(name));
    headLines.setIndex(new BufferAttribute(h.edges, 1));
    const seam = Uint32Array.from({ length: h.vertexCount }, (_, i) => i).filter((i) => h.seamWeight[i] > 0);
    const solidHead = surfaceOf(geometry, h.triangles);
    solidHead.computeVertexNormals();
    const scalp = new Set(h.scalp);
    const solidColors = new Float32Array(h.vertexCount * 3);
    for (let i = 0; i < h.vertexCount; i++) {
      // The photos' colors where tools/head/build.ts sampled them; otherwise skin, hair or shirt.
      let c: number[];
      if (h.colors) c = [0, 1, 2].map((k) => h.colors![i * 3 + k] ** (1 / 2.2));
      else {
        const x = h.base[i * 3];
        const y = h.base[i * 3 + 1];
        c = skinSrgb;
        if (y < h.neck.bottom - 0.01) c = Math.abs(x) > 0.12 ? [0.14, 0.17, 0.27] : [0.84, 0.84, 0.82];
        else if (scalp.has(i)) c = [0.07, 0.055, 0.05];
      }
      solidColors.set(c, i * 3);
    }
    solidHead.setAttribute("aSolid", new BufferAttribute(solidColors, 3));
    head = {
      geometry,
      lines: headLines,
      surface: surfaceOf(geometry, h.triangles),
      solid: solidHead,
      positions: headPositions,
      shaped: new Float32Array(h.base),
      seam,
    };
  }

  // Realistic mode's eyeballs: white spheres with a brown iris and a dark pupil facing forward.
  // Their points are turned with the eyes and the head on the CPU each frame.
  const sphere = new SphereGeometry(data.eyes.radius * 0.97, 24, 16);
  const eyeLocal = sphere.attributes.position.array as Float32Array;
  const eyeCount = eyeLocal.length / 3;
  const eyeballs = new BufferGeometry();
  const eyeballPositions = new Float32Array(eyeCount * 2 * 3);
  const eyeballColors = new Float32Array(eyeCount * 2 * 3);
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < eyeCount; i++) {
      const z = eyeLocal[i * 3 + 2] / data.eyes.radius;
      const c = z > 0.92 ? [0.03, 0.02, 0.02] : z > 0.75 ? [0.25, 0.15, 0.09] : [0.86, 0.83, 0.79];
      eyeballColors.set(c, (side * eyeCount + i) * 3);
    }
  }
  eyeballs.setAttribute("position", new BufferAttribute(eyeballPositions, 3).setUsage(DynamicDrawUsage));
  eyeballs.setAttribute("color", new BufferAttribute(eyeballColors, 3));
  const sphereIndex = sphere.index!.array;
  eyeballs.setIndex(new BufferAttribute(Uint32Array.from([...sphereIndex, ...Array.from(sphereIndex, (v) => v + eyeCount)]), 1));
  sphere.dispose();

  // The inside of the mouth: a dark oval just behind the lips, so an open mouth isn't see-through.
  let mouthCenter = [0, 0, 0];
  {
    // The lips' middle, from the scan's points around the mouth below the nose.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.vertexCount; i++) {
      const x = data.base[i * 3];
      const y = data.base[i * 3 + 1];
      if (Math.abs(x) < 0.025 && y < data.eyes.left[1] - 0.05 && y > data.eyes.left[1] - 0.085) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], data.base[i * 3 + k]);
          hi[k] = Math.max(hi[k], data.base[i * 3 + k]);
        }
      }
    }
    mouthCenter = [0, (lo[1] + hi[1]) / 2, hi[2] - 0.014];
  }
  const mouthLocal: number[] = [];
  const mouthIndex: number[] = [];
  const mouthSegments = 24;
  mouthLocal.push(...mouthCenter);
  for (let i = 0; i < mouthSegments; i++) {
    const a = (i / mouthSegments) * Math.PI * 2;
    mouthLocal.push(mouthCenter[0] + Math.cos(a) * 0.028, mouthCenter[1] + Math.sin(a) * 0.018, mouthCenter[2] - 0.004 * Math.abs(Math.cos(a)));
    mouthIndex.push(0, 1 + i, 1 + ((i + 1) % mouthSegments));
  }
  const mouth = new BufferGeometry();
  const mouthPositions = new Float32Array(mouthLocal.length);
  mouth.setAttribute("position", new BufferAttribute(mouthPositions, 3).setUsage(DynamicDrawUsage));
  mouth.setIndex(mouthIndex);

  let hair = new BufferGeometry();
  // Dark brown-black, for photo color and realistic mode.
  const hairColor = new Color(0.035, 0.028, 0.024);
  /** Replaces the hair with newly grown strands. */
  const setHair = (grown: Hair) => {
    hair.dispose();
    hair = new BufferGeometry();
    hair.setAttribute("position", new BufferAttribute(grown.positions, 3));
    const count = grown.along.length;
    standardAttributes(hair, count, 17, { colors: colorsOf(count, hairColor) });
    // Strands sway as a whole, so all of a strand's points share its seed.
    hair.setAttribute("aSeed", new BufferAttribute(grown.seeds, 1));
    hair.setAttribute("aAlong", new BufferAttribute(grown.along, 1));
    hair.setIndex(new BufferAttribute(grown.index, 1));
    return hair;
  };

  return {
    uniforms,
    materials,
    geometries: { points, lines, eyes, surface, solidFace, eyeballs, mouth },
    eyeLocal,
    eyeballPositions,
    mouthLocal: new Float32Array(mouthLocal),
    mouthPositions,
    positions,
    eyeRing: ring,
    eyePositions,
    eyeFade,
    head,
    setHair,
    get hair() {
      return hair;
    },
    dispose() {
      for (const g of [points, lines, eyes, surface, solidFace, eyeballs, mouth, hair, head?.geometry, head?.lines, head?.surface, head?.solid]) {
        g?.dispose();
      }
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}
export type Scene = ReturnType<typeof buildScene>;

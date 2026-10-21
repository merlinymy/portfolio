/**
 * Loads the face files that tools/face/build.ts writes to public/face/ (formats in
 * tools/face/README.md and plan §5.2).
 */
import { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Mesh, type Object3D } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const CLIP_NAMES = ["idle", "listening", "thinking", "talking", "sleeping"] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

/** Expression offsets for one slider, listing only the vertices it moves. */
export interface Target {
  indices: Uint16Array;
  deltas: Float32Array;
}

export interface Eyes {
  left: [number, number, number];
  right: [number, number, number];
  radius: number;
}

export interface Clip {
  name: ClipName;
  fps: number;
  frames: number;
  /** frames × sliders, as 0–255; multiply by weightScale. */
  weights: Uint8Array;
  /** frames × 3 head angles (Euler XYZ), multiply by angleScale for radians. */
  head: Int16Array;
  /** frames × 6 eye angles: left x, y, z, then right x, y, z. */
  eyes: Int16Array;
  weightScale: number;
  angleScale: number;
}

/** A held look: 52 slider values, the eye angles, and the point both eyes converged on. */
export interface GazePose {
  weights: number[];
  eyes: number[];
  lookAt: number[];
}

/** The head, neck and shoulders fitted around the scan by tools/head/build.ts (plan §5.8). */
export interface HeadData {
  vertexCount: number;
  /** Positions in the same face space and meters as the scan. */
  base: Float32Array;
  /** Pairs of point indices: the base body's four-sided faces, drawn as a grid. */
  edges: Uint16Array;
  /** Triples of point indices: the surface, which hides whatever is behind it. */
  triangles: Uint16Array;
  /** Each point's color from the texture photos (linear RGB), for photo color and realistic mode. */
  colors?: Float32Array;
  /** How much each point turns with the head: 1 for the head, 0 for the shoulders. */
  headWeight: Float32Array;
  /** The scan outline vertex each point follows, and how much (0 away from the face's edge). */
  seamIndex: Uint16Array;
  seamWeight: Float32Array;
  /** Scalp triangles, as point indices, where hair grows. */
  scalp: Uint16Array;
  /** The point the head turns about (the top of the neck). */
  pivot: [number, number, number];
  eyeY: number;
  torso: { center: number[]; radii: number[] };
  neck: { center: number[]; radius: number; top: number; bottom: number };
}

export interface FaceData {
  /** The 52 slider names, in the order every weight list uses. */
  names: string[];
  vertexCount: number;
  /** Neutral positions, x, y, z per vertex, in meters (ARKit face space). */
  base: Float32Array;
  /** Each point's color in the texture photos (linear RGB), if the converter could sample them. */
  colors?: Float32Array;
  targets: Target[];
  /** Pairs of vertex indices, one pair per line. */
  edges: Uint16Array;
  /** Triples of vertex indices: the surface, which hides whatever is behind it. */
  triangles: Uint16Array;
  /** Where each point sits in the skin image (realistic mode), u and v per vertex. */
  uvs: Float32Array;
  eyes: Eyes;
  clips: Record<ClipName, Clip>;
  gaze: Record<"center" | "left" | "right" | "up" | "down", GazePose>;
  /** Viseme id → 52 slider values. */
  visemes: Record<string, number[]>;
  /** Missing until tools/head/build.ts has run; the face then shows on its own. */
  head?: HeadData;
}

const BASE = "/face/";

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

/** x, y, z per vertex. Reads through the attribute, which also handles interleaved storage. */
function positionsOf(attribute: BufferAttribute | InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.getY(i);
    out[i * 3 + 2] = attribute.getZ(i);
  }
  return out;
}

function sparseTarget(dense: ArrayLike<number>): Target {
  const indices: number[] = [];
  const deltas: number[] = [];
  for (let v = 0; v * 3 < dense.length; v++) {
    const [x, y, z] = [dense[v * 3], dense[v * 3 + 1], dense[v * 3 + 2]];
    if (x !== 0 || y !== 0 || z !== 0) {
      indices.push(v);
      deltas.push(x, y, z);
    }
  }
  return { indices: new Uint16Array(indices), deltas: new Float32Array(deltas) };
}

async function loadMesh() {
  const gltf = await new GLTFLoader().loadAsync(`${BASE}face.glb`);
  let triangles: Mesh | undefined;
  let edges: BufferGeometry | undefined;
  let eyes: Eyes | undefined;
  gltf.scene.traverse((object: Object3D) => {
    if (object.userData.eyes) eyes = object.userData.eyes as Eyes;
    if ((object as Mesh).isMesh) triangles = object as Mesh;
    else if ((object as { isLineSegments?: boolean }).isLineSegments) edges = (object as Mesh).geometry;
  });
  if (!triangles?.geometry.index || !edges?.index || !eyes || !triangles.morphTargetDictionary) {
    throw new Error("face.glb: missing the triangles, the lines, the eye positions or the slider names");
  }
  const dictionary = triangles.morphTargetDictionary;
  const names = Object.keys(dictionary).sort((a, b) => dictionary[a] - dictionary[b]);
  const geometry = triangles.geometry;
  const morphs = geometry.morphAttributes.position ?? [];
  const color = geometry.getAttribute("color");
  return {
    names,
    base: positionsOf(geometry.attributes.position),
    triangles: new Uint16Array(geometry.index!.array),
    uvs: Float32Array.from({ length: geometry.attributes.uv.count * 2 }, (_, i) =>
      i % 2 === 0 ? geometry.attributes.uv.getX(i >> 1) : geometry.attributes.uv.getY(i >> 1),
    ),
    colors: color ? positionsOf(color) : undefined,
    targets: morphs.map((attribute) => sparseTarget(positionsOf(attribute))),
    edges: new Uint16Array(edges.index.array),
    eyes,
  };
}

async function loadHead(): Promise<HeadData | undefined> {
  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(`${BASE}head.glb`);
  } catch {
    return undefined;
  }
  let surface: Mesh | undefined;
  let lines: BufferGeometry | undefined;
  let extras: Record<string, unknown> | undefined;
  gltf.scene.traverse((object: Object3D) => {
    if (object.userData.pivot) extras = object.userData;
    if ((object as Mesh).isMesh) surface = object as Mesh;
    else if ((object as { isLineSegments?: boolean }).isLineSegments) lines = (object as Mesh).geometry;
  });
  if (!surface?.geometry.index || !lines?.index || !extras) return undefined;
  const g = surface.geometry;
  // GLTFLoader lowercases custom attribute names.
  const scalar = (name: string) => {
    const a = g.getAttribute(name);
    return Float32Array.from({ length: a.count }, (_, i) => a.getX(i));
  };
  const e = extras as {
    pivot: [number, number, number];
    eyeY: number;
    scalp: number[];
    torso: HeadData["torso"];
    neck: HeadData["neck"];
  };
  return {
    vertexCount: g.attributes.position.count,
    base: positionsOf(g.attributes.position),
    edges: new Uint16Array(lines.index.array),
    triangles: new Uint16Array(g.index!.array),
    colors: g.getAttribute("color") ? positionsOf(g.getAttribute("color")) : undefined,
    headWeight: scalar("_head_weight"),
    seamIndex: Uint16Array.from(scalar("_seam_index")),
    seamWeight: scalar("_seam_weight"),
    scalp: Uint16Array.from(e.scalp),
    pivot: e.pivot,
    eyeY: e.eyeY,
    torso: e.torso,
    neck: e.neck,
  };
}

async function loadClips(): Promise<Record<ClipName, Clip>> {
  const buffer = await (await fetchOk(`${BASE}clips.bin`)).arrayBuffer();
  const view = new DataView(buffer);
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (magic !== "FCLP" || view.getUint32(4, true) !== 1) throw new Error("clips.bin: unexpected format");
  const headerLength = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerLength))) as {
    fps: number;
    names: string[];
    weightScale: number;
    angleScale: number;
    clips: { name: ClipName; frames: number; weights: number; head: number; eyes: number }[];
  };
  // Int16Array reads in the platform's byte order, which is little-endian on every browser platform.
  const clips = {} as Record<ClipName, Clip>;
  for (const c of header.clips) {
    clips[c.name] = {
      name: c.name,
      fps: header.fps,
      frames: c.frames,
      weights: new Uint8Array(buffer, c.weights, c.frames * header.names.length),
      head: new Int16Array(buffer, c.head, c.frames * 3),
      eyes: new Int16Array(buffer, c.eyes, c.frames * 6),
      weightScale: header.weightScale,
      angleScale: header.angleScale,
    };
  }
  return clips;
}

export async function loadFace(): Promise<FaceData> {
  const [mesh, clips, gaze, visemes, head] = await Promise.all([
    loadMesh(),
    loadClips(),
    fetchOk(`${BASE}gaze.json`).then((r) => r.json()),
    fetchOk(`${BASE}visemes.json`).then((r) => r.json()),
    loadHead(),
  ]);
  if (gaze.names.join() !== mesh.names.join() || visemes.names.join() !== mesh.names.join()) {
    throw new Error("gaze.json or visemes.json lists the sliders in a different order from face.glb");
  }
  return { ...mesh, vertexCount: mesh.base.length / 3, clips, gaze: gaze.poses, visemes: visemes.poses, head };
}

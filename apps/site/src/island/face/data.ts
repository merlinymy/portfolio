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

export interface FaceData {
  /** The 52 slider names, in the order every weight list uses. */
  names: string[];
  vertexCount: number;
  /** Neutral positions, x, y, z per vertex, in meters (ARKit face space). */
  base: Float32Array;
  targets: Target[];
  /** Pairs of vertex indices, one pair per line. */
  edges: Uint16Array;
  eyes: Eyes;
  clips: Record<ClipName, Clip>;
  gaze: Record<"center" | "left" | "right" | "up" | "down", GazePose>;
  /** Viseme id → 52 slider values. */
  visemes: Record<string, number[]>;
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
  if (!triangles || !edges?.index || !eyes || !triangles.morphTargetDictionary) {
    throw new Error("face.glb: missing the triangles, the lines, the eye positions or the slider names");
  }
  const dictionary = triangles.morphTargetDictionary;
  const names = Object.keys(dictionary).sort((a, b) => dictionary[a] - dictionary[b]);
  const geometry = triangles.geometry;
  const morphs = geometry.morphAttributes.position ?? [];
  return {
    names,
    base: positionsOf(geometry.attributes.position),
    targets: morphs.map((attribute) => sparseTarget(positionsOf(attribute))),
    edges: new Uint16Array(edges.index.array),
    eyes,
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
  const [mesh, clips, gaze, visemes] = await Promise.all([
    loadMesh(),
    loadClips(),
    fetchOk(`${BASE}gaze.json`).then((r) => r.json()),
    fetchOk(`${BASE}visemes.json`).then((r) => r.json()),
  ]);
  if (gaze.names.join() !== mesh.names.join() || visemes.names.join() !== mesh.names.join()) {
    throw new Error("gaze.json or visemes.json lists the sliders in a different order from face.glb");
  }
  return { ...mesh, vertexCount: mesh.base.length / 3, clips, gaze: gaze.poses, visemes: visemes.poses };
}

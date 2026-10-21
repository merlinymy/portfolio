/**
 * The pieces every look builds on (docs/face-looks-plan.md, "Shared pieces"): what a look is, the
 * face surface with its extra per-point weights, full-screen passes into hidden pictures, and the
 * face's points as a texture that particles launch from.
 */
import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  type Matrix4,
  Mesh,
  NearestFilter,
  type Object3D,
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  type ShaderMaterial,
  type Vector2,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import type { FaceData } from "../data";
import type { Scene as FaceScene } from "../scene";
import type { FaceState } from "../settings";

/** Everything a look needs to know about this frame. */
export interface LookFrame {
  gl: WebGLRenderer;
  camera: PerspectiveCamera;
  /** The canvas size in CSS pixels, and device pixels per CSS pixel. */
  width: number;
  height: number;
  dpr: number;
  dt: number;
  now: number;
  /** The face's points this frame, x, y, z each, before the head turns. */
  positions: Float32Array;
  /** The head's turn this frame. */
  headMatrix: Matrix4;
  state: FaceState;
  /** The face state's color, eased toward as states change (State colors in the lab). */
  color: Color;
  /** The face state's brightness, eased the same way. */
  brightness: number;
  /** 0–1 while speaking: how open the mouth is, standing in for the voice's loudness. */
  loudness: number;
  /** 0 to 1 over the opening intro; 1 afterwards. */
  intro: number;
  /** The pointer in CSS pixels from the canvas's top-left corner. */
  pointer: { x: number; y: number; inside: boolean };
  reduced: boolean;
}

export interface Look {
  /** What the look adds to the scene. */
  object: Object3D;
  /** The glowing eye rings over the look: their brightness (0 hides them) and color. */
  eyes: { glow: number; color: Color };
  update(frame: LookFrame): void;
  dispose(): void;
}

export interface LookParts {
  data: FaceData;
  scene: FaceScene;
}

const weights = new WeakMap<FaceData, { expressive: Float32Array; edge: Float32Array }>();

/** How far each point moves across all your captured expressions, scaled so the liveliest are 1. */
function expressiveness(data: FaceData): Float32Array {
  const total = new Float32Array(data.vertexCount);
  for (const { indices, deltas } of data.targets) {
    for (let k = 0; k < indices.length; k++) {
      total[indices[k]] += Math.hypot(deltas[k * 3], deltas[k * 3 + 1], deltas[k * 3 + 2]);
    }
  }
  const sorted = Float32Array.from(total).sort();
  const top = sorted[Math.floor(sorted.length * 0.95)] || 1;
  return total.map((v) => Math.min(1, v / top));
}

/**
 * 1 on the scan's open edges (its outline and the openings at the eyes and lips), fading to 0 over
 * `rings` steps of neighbouring points inward. An edge is open where only one triangle uses it.
 */
function edgeness(triangles: Uint16Array, count: number, rings = 4): Float32Array {
  const uses = new Map<number, number>();
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = Math.min(a, b) * 65536 + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
      neighbours[a].push(b);
      neighbours[b].push(a);
    }
  }
  const level = new Int32Array(count).fill(-1);
  let ring: number[] = [];
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    for (const v of [Math.floor(key / 65536), key % 65536]) {
      if (level[v] < 0) {
        level[v] = 0;
        ring.push(v);
      }
    }
  }
  for (let r = 1; r <= rings; r++) {
    const next: number[] = [];
    for (const v of ring) {
      for (const w of neighbours[v]) {
        if (level[w] < 0) {
          level[w] = r;
          next.push(w);
        }
      }
    }
    ring = next;
  }
  return Float32Array.from(level, (l) => (l < 0 ? 0 : 1 - l / (rings + 1)));
}

function weightsOf(data: FaceData) {
  let w = weights.get(data);
  if (!w) {
    w = { expressive: expressiveness(data), edge: edgeness(data.triangles, data.vertexCount) };
    weights.set(data, w);
  }
  return w;
}

/**
 * The face surface for a look: the realistic mode's surface (the same points, its normals kept up
 * to date by Face.tsx), plus each point's expressive and edge weights. Its other attributes are
 * shared with that surface, so this geometry is never disposed on its own.
 */
export function lookSurface({ data, scene }: LookParts) {
  const solid = scene.geometries.solidFace;
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(solid.attributes)) geometry.setAttribute(name, attribute);
  geometry.setIndex(solid.getIndex());
  const { expressive, edge } = weightsOf(data);
  geometry.setAttribute("aExpressive", new BufferAttribute(expressive, 1));
  geometry.setAttribute("aEdge", new BufferAttribute(edge, 1));
  return geometry;
}

const holes = new WeakMap<FaceData, { outline: number[]; mouth: number[]; eyes: number[][] }>();

/**
 * The scan's openings, as lists of the points around each: its outline, and the holes at the eyes
 * and the mouth. An opening's edges are the ones only one triangle uses. The biggest is the outline;
 * of the rest, the lowest is the mouth.
 */
export function openings(data: FaceData) {
  let found = holes.get(data);
  if (found) return found;
  const uses = new Map<number, number>();
  const t = data.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = t[i + k];
      const b = t[i + ((k + 1) % 3)];
      const key = Math.min(a, b) * 65536 + Math.max(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const next = new Map<number, number[]>();
  for (const [key, n] of uses) {
    if (n !== 1) continue;
    const a = Math.floor(key / 65536);
    const b = key % 65536;
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      loop.push(v);
      for (const w of next.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    loops.push(loop);
  }
  loops.sort((a, b) => b.length - a.length);
  const height = (loop: number[]) => loop.reduce((sum, v) => sum + data.base[v * 3 + 1], 0) / loop.length;
  const inner = loops.slice(1).sort((a, b) => height(a) - height(b));
  found = { outline: loops[0] ?? [], mouth: inner[0] ?? [], eyes: inner.slice(1) };
  holes.set(data, found);
  return found;
}

const projected = new Vector3();

/** Where a point in the scene appears in the view, from (0, 0) at the bottom left to (1, 1). */
export function screenUv(point: Vector3, camera: PerspectiveCamera, out: Vector2) {
  projected.copy(point).project(camera);
  return out.set((projected.x + 1) / 2, (projected.y + 1) / 2);
}

/** For drawing over the whole view: a vertex shader that ignores the camera. */
export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** A rectangle covering the whole view. */
export function fullscreen(material: ShaderMaterial) {
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  return mesh;
}

/** A hidden picture to draw into, in half-float color so values brighter than white survive. */
export function hiddenPicture(width: number, height: number) {
  return new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  });
}

/** Draws one full-screen material into a hidden picture. */
export class Pass {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: ShaderMaterial;

  constructor(material: ShaderMaterial) {
    this.material = material;
    this.scene.add(fullscreen(material));
  }

  render(gl: WebGLRenderer, target: WebGLRenderTarget) {
    gl.setRenderTarget(target);
    gl.render(this.scene, this.camera);
  }

  dispose() {
    this.material.dispose();
    this.scene.traverse((o) => (o as Mesh).geometry?.dispose());
  }
}

/**
 * The face's points as a one-row texture, updated every frame: x, y, z before the head turns, and
 * each point's expressive weight in the fourth channel. Particles read it to launch from the face.
 */
export class FacePoints {
  readonly count: number;
  readonly texture: DataTexture;
  private readonly values: Float32Array;

  constructor(parts: LookParts) {
    this.count = parts.data.vertexCount;
    this.values = new Float32Array(this.count * 4);
    const { expressive, edge } = weightsOf(parts.data);
    for (let i = 0; i < this.count; i++) this.values[i * 4 + 3] = Math.max(expressive[i], edge[i]);
    this.texture = new DataTexture(this.values, this.count, 1, RGBAFormat, FloatType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
  }

  update(positions: Float32Array) {
    for (let i = 0; i < this.count; i++) {
      this.values[i * 4] = positions[i * 3];
      this.values[i * 4 + 1] = positions[i * 3 + 1];
      this.values[i * 4 + 2] = positions[i * 3 + 2];
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

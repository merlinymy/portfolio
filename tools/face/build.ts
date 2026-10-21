/**
 * Converts the FaceScan app's exports in knowledge/faceScan/ into the files the site loads from
 * apps/site/public/face/ (plan §5.2). Run `npm run face` from the repo root after replacing a
 * capture; the file formats on both sides are in tools/face/README.md.
 *
 *   face.json     → face.glb      the mesh, its 52 expression offsets, the line edges and each
 *                                 point's color from the texture photos (the photos stay private)
 *   <clip>.json   → clips.bin     all five clips, quantized and packed
 *   visemes.json  → visemes.json  copied as is
 *   gaze.json     → gaze.json     copied as is
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accessor, Document, NodeIO, Primitive, VertexLayout } from "@gltf-transform/core";
import jpeg from "jpeg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = join(ROOT, "knowledge/faceScan");
const OUT = join(ROOT, "apps/site/public/face");
const CLIPS = ["idle", "listening", "thinking", "talking", "sleeping"] as const;

/** clips.bin stores slider values as 0–255 and angles as ten-thousandths of a radian. */
const WEIGHT_STEPS = 255;
const ANGLE_STEPS = 10_000;

interface FaceMesh {
  format: "face-mesh";
  version: 1;
  vertices: number[];
  triangles: number[];
  uvs: number[];
  eyes: { left: number[]; right: number[]; radius: number };
  blendshapes: Record<string, { indices: number[]; deltas: number[] }>;
}

interface FaceClip {
  format: "face-clip";
  version: 1;
  name: string;
  fps: number;
  names: string[];
  frames: number[][];
  head: number[][];
  eyes: number[][];
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(SOURCE, name), "utf8")) as T;
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`${message} (in ${SOURCE})`);
}

/** Every distinct triangle side, as pairs of vertex indices, smaller index first. */
function uniqueEdges(triangles: number[]): Uint16Array {
  const seen = new Set<number>();
  const edges: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    for (const [a, b] of [
      [triangles[t], triangles[t + 1]],
      [triangles[t + 1], triangles[t + 2]],
      [triangles[t + 2], triangles[t]],
    ]) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * 65_536 + hi;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(lo, hi);
      }
    }
  }
  return new Uint16Array(edges);
}

interface TextureShot {
  name: string;
  image: string;
  cameraInFace: number[];
  pixels: number[];
}

/**
 * Each point's color in the texture photos, as linear RGB. A point takes its color mostly from
 * the photo that faced it most squarely, so the left and right photos fill in the sides of the
 * face that the front photo sees at a slant.
 */
async function sampleColors(face: FaceMesh): Promise<Float32Array | undefined> {
  let shots: TextureShot[];
  try {
    shots = (await readJson<{ shots: TextureShot[] }>("texture.json")).shots;
  } catch {
    return undefined;
  }
  const photos = await Promise.all(shots.map(async (s) => jpeg.decode(await readFile(join(SOURCE, s.image)), { useTArray: true })));
  const count = face.vertices.length / 3;
  const v = face.vertices;
  // Area-weighted normals from the triangles.
  const normals = new Float32Array(count * 3);
  for (let t = 0; t < face.triangles.length; t += 3) {
    const [a, b, c] = [face.triangles[t], face.triangles[t + 1], face.triangles[t + 2]];
    const e1 = [v[b * 3] - v[a * 3], v[b * 3 + 1] - v[a * 3 + 1], v[b * 3 + 2] - v[a * 3 + 2]];
    const e2 = [v[c * 3] - v[a * 3], v[c * 3 + 1] - v[a * 3 + 1], v[c * 3 + 2] - v[a * 3 + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) normals[i * 3 + k] += n[k];
  }
  // The photos are sRGB; glTF vertex colors are linear.
  const linear = (byte: number) => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const n = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    // Mesh triangles wind so the normals point out of the face, toward the camera.
    let total = 0;
    const sum = [0, 0, 0];
    shots.forEach((shot, s) => {
      const toCamera = [shot.cameraInFace[0] - v[i * 3], shot.cameraInFace[1] - v[i * 3 + 1], shot.cameraInFace[2] - v[i * 3 + 2]];
      const dl = Math.hypot(toCamera[0], toCamera[1], toCamera[2]) || 1;
      const facing = (n[0] * toCamera[0] + n[1] * toCamera[1] + n[2] * toCamera[2]) / (nl * dl);
      if (facing <= 0.15) return;
      const photo = photos[s];
      const x = Math.min(photo.width - 1, Math.max(0, Math.round(shot.pixels[i * 2])));
      const y = Math.min(photo.height - 1, Math.max(0, Math.round(shot.pixels[i * 2 + 1])));
      const k = (y * photo.width + x) * 4;
      const w = facing ** 4;
      total += w;
      for (let c = 0; c < 3; c++) sum[c] += w * linear(photo.data[k + c]);
    });
    for (let c = 0; c < 3; c++) colors[i * 3 + c] = total > 0 ? sum[c] / total : 0.2;
  }
  return colors;
}

async function buildGlb(face: FaceMesh, names: string[]): Promise<{ bytes: Uint8Array; edges: number }> {
  const vertexCount = face.vertices.length / 3;
  check(Number.isInteger(vertexCount), "face.json: vertices isn't a list of x, y, z triples");
  check(face.uvs.length === vertexCount * 2, "face.json: uvs doesn't have one pair per vertex");
  check(face.triangles.every((i) => i < vertexCount), "face.json: a triangle points past the last vertex");
  check(vertexCount < 65_536, "face.json: too many vertices for 16-bit indices");

  const doc = new Document();
  const buffer = doc.createBuffer();
  const accessor = (type: Accessor.Type, array: Float32Array | Uint16Array) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

  const position = accessor(Accessor.Type.VEC3, new Float32Array(face.vertices));
  const uv = accessor(Accessor.Type.VEC2, new Float32Array(face.uvs));
  const sampled = await sampleColors(face);
  const color = sampled && accessor(Accessor.Type.VEC3, sampled);
  const edges = uniqueEdges(face.triangles);

  // One morph target per slider, in the clips' slider order. Most vertices don't move for a given
  // slider, so the targets are stored sparse: only the listed vertices take up space.
  const targets = names.map((name) => {
    const shape = face.blendshapes[name];
    check(shape !== undefined, `face.json: no offsets for slider ${name}`);
    const deltas = new Float32Array(vertexCount * 3);
    shape.indices.forEach((vertex, k) => {
      deltas.set(shape.deltas.slice(k * 3, k * 3 + 3), vertex * 3);
    });
    return doc.createPrimitiveTarget(name).setAttribute("POSITION", accessor(Accessor.Type.VEC3, deltas).setSparse(true));
  });

  // The triangles are for Blender and for picking; the site draws the lines and the points.
  const triangles = doc
    .createPrimitive()
    .setMode(Primitive.Mode.TRIANGLES)
    .setIndices(accessor(Accessor.Type.SCALAR, new Uint16Array(face.triangles)))
    .setAttribute("POSITION", position)
    .setAttribute("TEXCOORD_0", uv);
  const lines = doc
    .createPrimitive()
    .setMode(Primitive.Mode.LINES)
    .setIndices(accessor(Accessor.Type.SCALAR, edges))
    .setAttribute("POSITION", position);
  for (const target of targets) {
    triangles.addTarget(target);
    lines.addTarget(target);
  }
  if (color) {
    triangles.setAttribute("COLOR_0", color);
    lines.setAttribute("COLOR_0", color);
  }

  const mesh = doc
    .createMesh("Face")
    .addPrimitive(triangles)
    .addPrimitive(lines)
    .setWeights(names.map(() => 0))
    .setExtras({ targetNames: names });
  const node = doc.createNode("Face").setMesh(mesh).setExtras({ eyes: face.eyes, units: "m" });
  doc.createScene("Face").addChild(node);
  doc.getRoot().getAsset().generator = "portfolio tools/face/build.ts";

  // Separate blocks per attribute (not interleaved) keep the file simple to read outside three.js.
  const io = new NodeIO().setVertexLayout(VertexLayout.SEPARATE);
  return { bytes: await io.writeBinary(doc), edges: edges.length / 2 };
}

/**
 * Packs the clips into one little-endian file:
 *   "FCLP", uint32 version, uint32 header length, the header as JSON (padded to 4 bytes), then
 *   per clip: slider values (uint8, frames × names), head angles (int16, frames × 3) and eye
 *   angles (int16, frames × 6). The header gives each block's byte offset from the file start.
 */
function packClips(clips: FaceClip[], names: string[]): Uint8Array {
  const align = (n: number, to: number) => Math.ceil(n / to) * to;

  const headerFor = (start: number) => {
    let offset = start;
    const entries = clips.map((clip) => {
      const frames = clip.frames.length;
      const weights = offset;
      const head = align(weights + frames * names.length, 2);
      const eyes = head + frames * 3 * 2;
      offset = align(eyes + frames * 6 * 2, 4);
      return { name: clip.name, frames, weights, head, eyes };
    });
    const json = JSON.stringify({
      fps: clips[0].fps,
      names,
      weightScale: 1 / WEIGHT_STEPS,
      angleScale: 1 / ANGLE_STEPS,
      clips: entries,
    });
    return { json, entries, end: offset };
  };

  // The header holds absolute offsets, which depend on the header's own length: settle it in a
  // few passes (the length stops changing after the first).
  const encoder = new TextEncoder();
  let header = headerFor(0);
  let headerBytes = 0;
  for (let pass = 0; pass < 3; pass++) {
    headerBytes = align(encoder.encode(header.json).length, 4);
    header = headerFor(12 + headerBytes);
  }
  check(align(encoder.encode(header.json).length, 4) === headerBytes, "clips.bin: header length didn't settle");

  const bytes = new Uint8Array(header.end);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("FCLP"), 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, headerBytes, true);
  bytes.fill(0x20, 12, 12 + headerBytes);
  bytes.set(encoder.encode(header.json), 12);

  const angle = (radians: number) => Math.max(-32_768, Math.min(32_767, Math.round(radians * ANGLE_STEPS)));
  header.entries.forEach((entry, c) => {
    const clip = clips[c];
    clip.frames.forEach((weights, f) => {
      weights.forEach((w, s) => {
        bytes[entry.weights + f * names.length + s] = Math.round(Math.min(1, Math.max(0, w)) * WEIGHT_STEPS);
      });
      clip.head[f].forEach((v, k) => view.setInt16(entry.head + (f * 3 + k) * 2, angle(v), true));
      clip.eyes[f].forEach((v, k) => view.setInt16(entry.eyes + (f * 6 + k) * 2, angle(v), true));
    });
  });
  return bytes;
}

async function main() {
  const face = await readJson<FaceMesh>("face.json");
  check(face.format === "face-mesh" && face.version === 1, "face.json: unexpected format or version");
  const clips = await Promise.all(CLIPS.map((name) => readJson<FaceClip>(`${name}.json`)));
  const names = clips[0].names;
  for (const clip of clips) {
    check(clip.format === "face-clip" && clip.version === 1, `${clip.name}.json: unexpected format or version`);
    check(clip.fps === clips[0].fps, `${clip.name}.json: frame rate differs from the other clips`);
    check(clip.names.join() === names.join(), `${clip.name}.json: slider names differ from idle.json`);
    check(
      clip.head.length === clip.frames.length && clip.eyes.length === clip.frames.length,
      `${clip.name}.json: head or eye frames don't match the slider frames`,
    );
  }

  await mkdir(OUT, { recursive: true });
  const glb = await buildGlb(face, names);
  await writeFile(join(OUT, "face.glb"), glb.bytes);
  await writeFile(join(OUT, "clips.bin"), packClips(clips, names));
  await copyFile(join(SOURCE, "visemes.json"), join(OUT, "visemes.json"));
  await copyFile(join(SOURCE, "gaze.json"), join(OUT, "gaze.json"));

  console.log(
    `${face.vertices.length / 3} vertices, ${face.triangles.length / 3} triangles, ${glb.edges} edges, ` +
      `${names.length} sliders; clips: ${clips.map((c) => `${c.name} ${c.frames.length}`).join(", ")} frames`,
  );
  for (const file of ["face.glb", "clips.bin", "visemes.json", "gaze.json"]) {
    console.log(`  ${join("apps/site/public/face", file)}  ${((await stat(join(OUT, file))).size / 1024).toFixed(1)} KB`);
  }
}

await main();

/**
 * The face in the scene: points, lines and eye rings, updated every frame through the motion
 * layers of plan §5.4 (clip, lip-sync, look-at, then the shader effects).
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  Group,
  Matrix4,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import type { FaceData } from "./data";
import { prefersReducedMotion, type LookInput } from "./input";
import { Babbler, ClipBlend, ClipPlayer, Gaze, LipSync, Pose, approach, clamp, mixExpressions } from "./motion";
import { ALWAYS_ON, EFFECTS, STATES, STRIKE_SECONDS, control, settings, type EffectName, type FaceState } from "./settings";
import { createMaterial, createUniforms } from "./shaders";

const DEG = Math.PI / 180;
export const FOV = 30;
/** The area kept in view around the face, in meters (the scan is about 16 × 18 cm). */
const FRAME = { width: 0.21, height: 0.27, centerY: 0, centerZ: 0.02 };
/** How close a click must land to a point to start a ripple, in CSS pixels. */
const CLICK_RADIUS = 36;
const INTRO_SECONDS = 2.4;

/** A repeatable random sequence, so the scatter and twinkle look the same on every visit. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** Points around each pupil, on the eyeball's surface: an iris ring and a pupil ring. */
function eyeRing(radius: number): Float32Array {
  const rings = [
    { r: radius * 0.48, n: 20 },
    { r: radius * 0.2, n: 10 },
  ];
  const points: number[] = [];
  for (const { r, n } of rings) {
    const z = Math.sqrt(radius * radius - r * r);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      points.push(Math.cos(a) * r, Math.sin(a) * r, z);
    }
  }
  return new Float32Array(points);
}

function buildScene(data: FaceData) {
  const uniforms = createUniforms();
  const materials = {
    points: createMaterial(uniforms, "points", settings.look.pointOpacity),
    lines: createMaterial(uniforms, "lines", settings.look.lineOpacity),
    eyes: createMaterial(uniforms, "points", settings.look.eyeOpacity),
  };

  const positions = new Float32Array(data.base);
  const position = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  const { seeds, scatter } = scatterAttributes(data.vertexCount, 7);
  const seed = new BufferAttribute(seeds, 1);
  const scatterAttr = new BufferAttribute(scatter, 3);
  const fade = new BufferAttribute(new Float32Array(data.vertexCount).fill(1), 1);

  const points = new BufferGeometry();
  const lines = new BufferGeometry();
  for (const geometry of [points, lines]) {
    geometry.setAttribute("position", position);
    geometry.setAttribute("aSeed", seed);
    geometry.setAttribute("aScatter", scatterAttr);
    geometry.setAttribute("aFade", fade);
  }
  lines.setIndex(new BufferAttribute(data.edges, 1));

  const ring = eyeRing(data.eyes.radius);
  const ringCount = ring.length / 3;
  const eyePositions = new Float32Array(ringCount * 2 * 3);
  const eyeFade = new Float32Array(ringCount * 2).fill(1);
  const eyeScatter = scatterAttributes(ringCount * 2, 11);
  // One seed per eye, so wind sways each ring as a whole instead of breaking up its circle.
  eyeScatter.seeds.fill(0.31, 0, ringCount).fill(0.67, ringCount);
  const eyes = new BufferGeometry();
  eyes.setAttribute("position", new BufferAttribute(eyePositions, 3).setUsage(DynamicDrawUsage));
  eyes.setAttribute("aSeed", new BufferAttribute(eyeScatter.seeds, 1));
  eyes.setAttribute("aScatter", new BufferAttribute(eyeScatter.scatter, 3));
  eyes.setAttribute("aFade", new BufferAttribute(eyeFade, 1).setUsage(DynamicDrawUsage));

  return {
    uniforms,
    materials,
    geometries: { points, lines, eyes },
    positions,
    eyeRing: ring,
    eyePositions,
    eyeFade,
    dispose() {
      for (const g of [points, lines, eyes]) g.dispose();
      for (const m of Object.values(materials)) m.dispose();
    },
  };
}

function buildRig(data: FaceData) {
  const sliders = data.names.length;
  const players = Object.fromEntries(
    Object.values(data.clips).map((clip) => [clip.name, new ClipPlayer(clip)]),
  ) as Record<keyof FaceData["clips"], ClipPlayer>;
  const levels = Object.fromEntries(Object.keys(EFFECTS).map((name) => [name, 0])) as Record<EffectName, number>;
  return {
    players,
    blend: new ClipBlend(sliders),
    pose: new Pose(sliders),
    gaze: new Gaze(data),
    lip: new LipSync(data),
    babbler: new Babbler(),
    blink: [data.names.indexOf("eyeBlinkLeft"), data.names.indexOf("eyeBlinkRight")] as const,
    levels,
    state: undefined as FaceState | undefined,
    stateSince: 0,
    introStart: -1,
    follow: 0,
    look: { yaw: 0, pitch: 0 },
    head: { yaw: 0, pitch: 0 },
    eye: { yaw: 0, pitch: 0 },
    talk: 0,
    loudness: 0,
    brightness: 1,
    color: new Color(settings.look.baseColor),
    nextRipple: 0,
  };
}

const scratch = {
  v: new Vector3(),
  q: new Quaternion(),
  e: new Euler(),
  color: new Color(),
  stateColor: new Color(),
  ndc: new Vector2(),
  raycaster: new Raycaster(),
  inverse: new Matrix4(),
  plane: new Plane(new Vector3(0, 0, 1), -0.04),
  hit: new Vector3(),
};

export function Face({ data, input }: { data: FaceData; input: LookInput }) {
  const head = useRef<Group>(null);
  const scene = useMemo(() => buildScene(data), [data]);
  const rig = useMemo(() => buildRig(data), [data]);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const size = useThree((s) => s.size);

  useEffect(() => () => scene.dispose(), [scene]);

  // Back the camera off until the face area fits both the width and the height.
  useEffect(() => {
    const t = Math.tan((FOV / 2) * DEG);
    const aspect = size.width / Math.max(1, size.height);
    const distance = Math.max(FRAME.height / 2 / t, FRAME.width / 2 / (t * aspect));
    camera.position.set(0, FRAME.centerY, FRAME.centerZ + distance);
    camera.lookAt(0, FRAME.centerY, FRAME.centerZ);
    camera.updateProjectionMatrix();
  }, [camera, size]);

  useFrame((frame, delta) => {
    const group = head.current;
    if (!group) return;
    const dt = Math.min(delta, 0.05);
    const now = frame.clock.elapsedTime;
    const { pose, levels } = rig;
    const m = settings.motion;
    const reduced = prefersReducedMotion();
    const u = scene.uniforms;

    // State changes pick the base clip; a strike shows briefly, then returns.
    if (control.state === "strike" && rig.state === "strike" && now - rig.stateSince > STRIKE_SECONDS) {
      control.setState(control.previous);
    }
    if (control.state !== rig.state) {
      rig.state = control.state;
      rig.stateSince = now;
      rig.blend.play(rig.players[STATES[rig.state].clip], now);
    }
    const state = STATES[rig.state];

    // 1. Base clip: every slider, the head sway and the eyes.
    rig.blend.sample(now, pose);

    // 2–3. While speaking, the talking clip drives the upper face and lip-sync drives the mouth.
    const speaking = rig.state === "speaking";
    const previewing = control.viseme !== "off";
    if (previewing) rig.lip.setViseme(control.viseme);
    else if (speaking && control.babble) {
      const shape = rig.babbler.update(now);
      if (shape) rig.lip.setViseme(shape);
    } else rig.lip.setViseme("sil");
    rig.lip.update(dt);
    rig.talk = approach(rig.talk, speaking || previewing ? 1 : 0, dt, 0.15);
    rig.lip.apply(pose, rig.talk, m.lipSync);
    rig.loudness = approach(rig.loudness, speaking ? rig.lip.openness : 0, dt, 0.05);

    // 4. Look-at: the head turns part of the way, the eyes the rest, within the captured range.
    const following = input.active ? state.follow : 0;
    rig.follow = approach(rig.follow, following, dt, 0.4);
    const reach = m.reach * DEG * following;
    rig.look.yaw = approach(rig.look.yaw, input.x * reach, dt, input.active ? 0.05 : 0.8);
    rig.look.pitch = approach(rig.look.pitch, input.y * reach * 0.75, dt, input.active ? 0.05 : 0.8);
    const headScale = reduced ? 0.5 : 1;
    const headYaw = clamp(rig.look.yaw * m.headShare, -m.headYaw * DEG, m.headYaw * DEG) * headScale;
    const headPitch = clamp(rig.look.pitch * m.headShare, -m.headPitch * DEG, m.headPitch * DEG) * headScale;
    rig.head.yaw = approach(rig.head.yaw, headYaw, dt, m.headSmoothing);
    rig.head.pitch = approach(rig.head.pitch, headPitch, dt, m.headSmoothing);
    const [eyeYaw, eyePitch] = rig.gaze.limit(rig.look.yaw - rig.head.yaw, rig.look.pitch - rig.head.pitch);
    rig.eye.yaw = approach(rig.eye.yaw, eyeYaw, dt, m.eyeSmoothing);
    rig.eye.pitch = approach(rig.eye.pitch, eyePitch, dt, m.eyeSmoothing);
    rig.gaze.apply(rig.eye.yaw, rig.eye.pitch, rig.follow, pose);

    group.rotation.set(
      pose.head[0] * m.clipHead - rig.head.pitch,
      pose.head[1] * m.clipHead + rig.head.yaw,
      pose.head[2] * m.clipHead,
      "XYZ",
    );
    group.updateMatrixWorld();

    // Expressions are mixed here on the CPU (plan §5.3); the shader adds effects on top.
    mixExpressions(data.base, data.targets, pose.weights, scene.positions);
    scene.geometries.points.attributes.position.needsUpdate = true;

    // Eye rings turn with the recorded or looked-at eye angles and fade as the eyelids close.
    const ringCount = scene.eyeRing.length / 3;
    [data.eyes.left, data.eyes.right].forEach((center, side) => {
      scratch.e.set(pose.eyes[side * 3], pose.eyes[side * 3 + 1], pose.eyes[side * 3 + 2], "XYZ");
      scratch.q.setFromEuler(scratch.e);
      const blink = pose.weights[rig.blink[side]];
      const open = 1 - clamp((blink - 0.35) / 0.4, 0, 1);
      for (let i = 0; i < ringCount; i++) {
        scratch.v.fromArray(scene.eyeRing, i * 3).applyQuaternion(scratch.q);
        scratch.v.x += center[0];
        scratch.v.y += center[1];
        scratch.v.z += center[2];
        scratch.v.toArray(scene.eyePositions, (side * ringCount + i) * 3);
        scene.eyeFade[side * ringCount + i] = open;
      }
    });
    scene.geometries.eyes.attributes.position.needsUpdate = true;
    scene.geometries.eyes.attributes.aFade.needsUpdate = true;

    // 5. Effects: each eases toward on or off, by the state or by a lab override.
    for (const name of Object.keys(levels) as EffectName[]) {
      const effect = settings.effects[name];
      const auto =
        name === "ripple" ? rig.state !== "locked" : ALWAYS_ON.includes(name) || state.effects.includes(name);
      const on = effect.mode === "on" || (effect.mode === "auto" && auto);
      const tau = name === "glitch" ? 0.08 : name === "dust" ? 0.9 : 0.4;
      levels[name] = approach(levels[name], on ? 1 : 0, dt, tau);
    }
    const fx = settings.effects;
    const amount = (name: EffectName) => levels[name] * fx[name].strength;
    // Reduced motion keeps effects that move points to a minimum.
    const calm = reduced ? 0.3 : 1;

    u.uTime.value = now;
    u.uScale.value = (frame.size.height * frame.viewport.dpr) / (2 * Math.tan((FOV / 2) * DEG));
    u.uSize.value = settings.look.pointSize / 1000;
    u.uWind.value = amount("wind") * calm;
    u.uWindSpeed.value = fx.wind.speed;
    u.uRipple.value = amount("ripple") * calm;
    u.uRippleSpeed.value = fx.ripple.speed;
    u.uSweep.value = amount("sweep") * calm;
    u.uSweepSpeed.value = fx.sweep.speed;
    u.uPulse.value = amount("pulse") * rig.loudness * calm;
    u.uGlitch.value = amount("glitch") * calm;
    u.uGlitchSpeed.value = fx.glitch.speed;
    u.uDust.value = levels.dust * clamp(fx.dust.strength, 0, 1);
    u.uBreath.value = amount("breathing");
    u.uBreathSpeed.value = fx.breathing.speed;
    u.uScan.value = amount("scanline");
    u.uScanSpeed.value = fx.scanline.speed;
    u.uDepth.value = amount("depthFade");
    u.uShimmer.value = amount("shimmer") * calm;
    u.uShimmerSpeed.value = fx.shimmer.speed;
    u.uTwinkle.value = amount("twinkle") * calm;
    u.uTwinkleSpeed.value = fx.twinkle.speed;

    // The intro plays once on load (or on request from the lab).
    if (rig.introStart < 0 || control.replayIntro) {
      rig.introStart = now;
      control.replayIntro = false;
    }
    const introOn = fx.assemble.mode !== "off" && !reduced;
    u.uAssemble.value = introOn ? clamp(((now - rig.introStart) * fx.assemble.speed) / INTRO_SECONDS, 0, 1) : 1;

    // The palette shifts toward the state's color, and brightness follows the state.
    const look = settings.look;
    scratch.color.set(look.baseColor);
    scratch.stateColor.set(settings.states[rig.state].color);
    scratch.color.lerp(scratch.stateColor, clamp(amount("stateColor"), 0, 1));
    rig.color.lerp(scratch.color, 1 - Math.exp(-dt / 0.4));
    u.uColor.value.copy(rig.color);
    rig.brightness = approach(rig.brightness, settings.states[rig.state].brightness, dt, 0.4);
    u.uBrightness.value = rig.brightness;
    scene.materials.points.uniforms.uOpacity.value = look.pointOpacity;
    scene.materials.lines.uniforms.uOpacity.value = look.lineOpacity;
    scene.materials.eyes.uniforms.uOpacity.value = look.eyeOpacity;
    scene.materials.eyes.uniforms.uSizeScale.value = look.eyeSize;
    scene.materials.eyes.uniforms.uGain.value = look.eyeGlow;

    // Magnet: where the pointer meets a plane just in front of the face, in face space.
    const magnet = amount("magnet") * calm;
    u.uMagnet.value = 0;
    if (magnet > 0.01 && input.pointerPx.inside) {
      scratch.ndc.set((input.pointerPx.x / frame.size.width) * 2 - 1, -(input.pointerPx.y / frame.size.height) * 2 + 1);
      scratch.raycaster.setFromCamera(scratch.ndc, camera);
      scratch.inverse.copy(group.matrixWorld).invert();
      scratch.raycaster.ray.applyMatrix4(scratch.inverse);
      if (scratch.raycaster.ray.intersectPlane(scratch.plane, scratch.hit)) {
        u.uMagnetPos.value.copy(scratch.hit);
        u.uMagnet.value = magnet;
      }
    }

    // Ripples start at the point nearest a click, if the click landed on the face.
    while (input.clicks.length) {
      const click = input.clicks.shift()!;
      if (levels.ripple < 0.5) continue;
      let best = -1;
      let bestDistance = CLICK_RADIUS * CLICK_RADIUS;
      for (let i = 0; i < data.vertexCount; i++) {
        scratch.v.fromArray(scene.positions, i * 3).applyMatrix4(group.matrixWorld).project(camera);
        const dx = ((scratch.v.x + 1) / 2) * frame.size.width - click.x;
        const dy = ((1 - scratch.v.y) / 2) * frame.size.height - click.y;
        const d = dx * dx + dy * dy;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      if (best >= 0) {
        const slot = u.uRipples.value[rig.nextRipple++ % u.uRipples.value.length];
        slot.set(scene.positions[best * 3], scene.positions[best * 3 + 1], scene.positions[best * 3 + 2], now);
      }
    }

    // Tell the input where the face is on screen, so pointer positions are measured from it. This
    // uses the unturned face, so turning toward the pointer doesn't move the point it aims from.
    const rect = frame.gl.domElement.getBoundingClientRect();
    scratch.v.set(0, 0.02, 0.03).project(camera);
    input.setCenter(rect.left + ((scratch.v.x + 1) / 2) * rect.width, rect.top + ((1 - scratch.v.y) / 2) * rect.height);
  });

  return (
    <group ref={head}>
      <lineSegments geometry={scene.geometries.lines} material={scene.materials.lines} frustumCulled={false} />
      <points geometry={scene.geometries.points} material={scene.materials.points} frustumCulled={false} />
      <points geometry={scene.geometries.eyes} material={scene.materials.eyes} frustumCulled={false} />
    </group>
  );
}

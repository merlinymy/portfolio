/**
 * The face in the scene: the scanned face, its eye rings, the fitted head, neck and shoulders, and
 * the hair, updated every frame through the motion layers of plan §5.4 (clip, lip-sync, look-at,
 * then the shader effects). Geometry and materials are built in scene.ts.
 */
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  Color,
  Euler,
  type LineSegments,
  Matrix4,
  type Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import type { FaceData } from "./data";
import { growHair } from "./hair";
import { prefersReducedMotion, type LookInput } from "./input";
import { Babbler, ClipBlend, ClipPlayer, Gaze, LipSync, Pose, approach, clamp, mixExpressions } from "./motion";
import { buildScene, hairShape, shapeHead } from "./scene";
import {
  ALWAYS_ON,
  EFFECTS,
  STATES,
  STRIKE_SECONDS,
  control,
  settings,
  type ButtonStyle,
  type EffectName,
  type FaceState,
} from "./settings";

const DEG = Math.PI / 180;
export const FOV = 30;
/** The depth the camera aims at, in face space: just in front of the eyes. */
const CENTER_Z = 0.02;
/** How close a click must land to a point to start a ripple, in CSS pixels. */
const CLICK_RADIUS = 36;
const INTRO_SECONDS = 2.4;
/** How long the lab's hair and head-size sliders must rest before the hair regrows, in seconds. */
const REGROW_DELAY = 0.15;
/**
 * Where the six profile buttons sit around the face, in degrees counterclockwise from the
 * viewer's right, in the nav's order: About, Experience, Projects, Skills, Résumé, Contact.
 */
const BUTTON_ANGLES = [145, 35, 180, 0, 215, -35];
/** The buttons float around the head only where there's room; narrower screens use CSS rows. */
const floatQuery = typeof matchMedia === "function" ? matchMedia("(min-width: 700px)") : undefined;

/** The page's profile nav and its six links, which the face positions around the head. */
export interface FaceButtons {
  nav: HTMLElement;
  links: HTMLElement[];
}

function buildRig(data: FaceData) {
  const sliders = data.names.length;
  const players = Object.fromEntries(
    Object.values(data.clips).map((clip) => [clip.name, new ClipPlayer(clip)]),
  ) as Record<keyof FaceData["clips"], ClipPlayer>;
  const levels = Object.fromEntries(Object.keys(EFFECTS).map((name) => [name, 0])) as Record<EffectName, number>;
  let chinY = Infinity;
  for (let i = 1; i < data.base.length; i += 3) chinY = Math.min(chinY, data.base[i]);
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
    /** The head's angles, followed slowly, so the hair's ends can trail behind. */
    lag: { yaw: 0, pitch: 0 },
    talk: 0,
    loudness: 0,
    brightness: 1,
    color: new Color(settings.look.baseColor),
    nextRipple: 0,
    /** Sideways camera offset in meters, for an open panel. */
    shift: 0,
    floating: false,
    chinY,
    headKey: "",
    hairKey: "",
    hairChangedAt: 0,
    hairPending: false,
    /** The head's turn about the neck, shared with the shader and the CPU-side projections. */
    headMatrix: new Matrix4(),
  };
}

const scratch = {
  v: new Vector3(),
  q: new Quaternion(),
  e: new Euler(),
  m: new Matrix4(),
  color: new Color(),
  stateColor: new Color(),
  ndc: new Vector2(),
  raycaster: new Raycaster(),
  inverse: new Matrix4(),
  plane: new Plane(new Vector3(0, 0, 1), -0.04),
  hit: new Vector3(),
};

export function Face({ data, input, buttons }: { data: FaceData; input: LookInput; buttons?: FaceButtons }) {
  const hairRef = useRef<LineSegments>(null);
  const headRefs = useRef<Object3D[]>([]);
  const occluderRefs = useRef<Object3D[]>([]);
  const scene = useMemo(() => buildScene(data), [data]);
  const rig = useMemo(() => buildRig(data), [data]);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;

  useEffect(() => () => scene.dispose(), [scene]);

  useFrame((frame, delta) => {
    const dt = Math.min(delta, 0.05);
    const now = frame.clock.elapsedTime;
    const { pose, levels } = rig;
    const m = settings.motion;
    const look = settings.look;
    const reduced = prefersReducedMotion();
    const u = scene.uniforms;
    const width = frame.size.width;
    const height = Math.max(1, frame.size.height);

    // Framing: back the camera off until the frame fits both ways. With a panel open on the right,
    // slide the view so the face sits in the space beside it.
    const tan = Math.tan((FOV / 2) * DEG);
    const aspect = width / height;
    const distance = Math.max(look.frameHeight / 2 / tan, look.frameWidth / 2 / (tan * aspect));
    const visibleWidth = 2 * distance * tan * aspect;
    const shift = (control.panelInset / 2 / Math.max(1, width)) * visibleWidth;
    rig.shift = approach(rig.shift, shift, dt, reduced ? 0 : 0.3);
    camera.position.set(rig.shift, look.frameCenterY, CENTER_Z + distance);
    camera.lookAt(rig.shift, look.frameCenterY, CENTER_Z);
    camera.updateMatrixWorld();

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

    // 1. Base clip: every slider, the head sway and the eyes. The still image keeps the neutral scan.
    if (control.still) {
      pose.weights.fill(0);
      pose.head.fill(0);
      pose.eyes.fill(0);
    } else rig.blend.sample(now, pose);

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
    //    An open panel or a keyboard-focused button takes the face's attention from the pointer.
    let [targetX, targetY] = [input.x, input.y];
    let steering = input.active;
    if (control.attention) {
      [targetX, targetY] = input.normalize(control.attention.x, control.attention.y);
      steering = true;
    }
    const following = steering ? state.follow : 0;
    rig.follow = approach(rig.follow, following, dt, 0.4);
    const reach = m.reach * DEG * following;
    rig.look.yaw = approach(rig.look.yaw, targetX * reach, dt, steering ? 0.05 : 0.8);
    rig.look.pitch = approach(rig.look.pitch, targetY * reach * 0.75, dt, steering ? 0.05 : 0.8);
    const headScale = reduced ? 0.5 : 1;
    const headYaw = clamp(rig.look.yaw * m.headShare, -m.headYaw * DEG, m.headYaw * DEG) * headScale;
    const headPitch = clamp(rig.look.pitch * m.headShare, -m.headPitch * DEG, m.headPitch * DEG) * headScale;
    rig.head.yaw = approach(rig.head.yaw, headYaw, dt, m.headSmoothing);
    rig.head.pitch = approach(rig.head.pitch, headPitch, dt, m.headSmoothing);
    const [eyeYaw, eyePitch] = rig.gaze.limit(rig.look.yaw - rig.head.yaw, rig.look.pitch - rig.head.pitch);
    rig.eye.yaw = approach(rig.eye.yaw, eyeYaw, dt, m.eyeSmoothing);
    rig.eye.pitch = approach(rig.eye.pitch, eyePitch, dt, m.eyeSmoothing);
    rig.gaze.apply(rig.eye.yaw, rig.eye.pitch, rig.follow, pose);

    // The head turns about the top of the neck: the shader applies this to every point by its
    // head weight, and the CPU uses the same matrix for clicks, the magnet and the buttons.
    const pivot = data.head?.pivot ?? [0, 0, 0];
    const turnX = pose.head[0] * m.clipHead - rig.head.pitch;
    const turnY = pose.head[1] * m.clipHead + rig.head.yaw;
    scratch.e.set(turnX, turnY, pose.head[2] * m.clipHead, "XYZ");
    rig.headMatrix
      .makeTranslation(pivot[0], pivot[1], pivot[2])
      .multiply(scratch.m.makeRotationFromEuler(scratch.e))
      .multiply(scratch.inverse.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
    u.uHead.value.copy(rig.headMatrix);
    u.uPivot.value.set(pivot[0], pivot[1], pivot[2]);
    const hairSettings = settings.hair;
    rig.lag.yaw = approach(rig.lag.yaw, turnY, dt, 0.25);
    rig.lag.pitch = approach(rig.lag.pitch, turnX, dt, 0.25);
    u.uLag.value.set((rig.lag.pitch - turnX) * hairSettings.lag, (rig.lag.yaw - turnY) * hairSettings.lag);

    // Expressions are mixed here on the CPU (plan §5.3); the shader adds effects on top.
    mixExpressions(data.base, data.targets, pose.weights, scene.positions);
    scene.geometries.points.attributes.position.needsUpdate = true;

    // The head: lab size corrections, then the seam, which follows the face's expressions.
    if (scene.head && data.head) {
      const h = data.head;
      const s = settings.head;
      const key = `${s.width},${s.height},${s.depth}`;
      if (key !== rig.headKey) {
        shapeHead(h, s, scene.head.shaped);
        scene.head.positions.set(scene.head.shaped);
        rig.headKey = key;
      }
      const { positions: hp, shaped, seam } = scene.head;
      for (const i of seam) {
        const w = h.seamWeight[i];
        const j = h.seamIndex[i];
        for (let k = 0; k < 3; k++) hp[i * 3 + k] = shaped[i * 3 + k] + w * (scene.positions[j * 3 + k] - data.base[j * 3 + k]);
      }
      scene.head.geometry.attributes.position.needsUpdate = true;
      for (const object of headRefs.current) object.visible = s.show;

      // The hair regrows when its settings or the head's shape change, once the sliders rest.
      const hairKey = JSON.stringify(hairSettings) + key;
      if (hairKey !== rig.hairKey) {
        rig.hairKey = hairKey;
        rig.hairChangedAt = now;
        rig.hairPending = true;
      }
      if (rig.hairPending && now - rig.hairChangedAt >= REGROW_DELAY && hairRef.current) {
        rig.hairPending = false;
        hairRef.current.geometry = scene.setHair(growHair(hairShape(h, scene.head.shaped, rig.chinY), hairSettings));
      }
      if (hairRef.current) hairRef.current.visible = hairSettings.show;
    }

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
    u.uScale.value = (frame.size.height * frame.viewport.dpr) / (2 * tan);
    u.uSize.value = look.pointSize / 1000;
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
    u.uHairSway.value = hairSettings.sway * calm;

    // The intro plays once on load (or on request from the lab).
    if (rig.introStart < 0 || control.replayIntro) {
      rig.introStart = now;
      control.replayIntro = false;
    }
    const introOn = fx.assemble.mode !== "off" && !reduced;
    u.uAssemble.value = introOn ? clamp(((now - rig.introStart) * fx.assemble.speed) / INTRO_SECONDS, 0, 1) : 1;
    // The occluder is a solid surface, so it steps aside while the points fly in or blow away.
    const occlude = look.occlude && u.uAssemble.value >= 1 && levels.dust < 0.02;
    occluderRefs.current.forEach((object, i) => {
      object.visible = occlude && (i === 0 || settings.head.show);
    });

    // The palette shifts toward the state's color, and brightness follows the state.
    scratch.color.set(look.baseColor);
    scratch.stateColor.set(settings.states[rig.state].color);
    scratch.color.lerp(scratch.stateColor, clamp(amount("stateColor"), 0, 1));
    rig.color.lerp(scratch.color, 1 - Math.exp(-dt / 0.4));
    u.uColor.value.copy(rig.color);
    rig.brightness = approach(rig.brightness, settings.states[rig.state].brightness, dt, 0.4);
    u.uBrightness.value = rig.brightness;
    const mat = scene.materials;
    mat.points.uniforms.uOpacity.value = look.pointOpacity;
    mat.lines.uniforms.uOpacity.value = look.lineOpacity;
    mat.eyes.uniforms.uOpacity.value = look.eyeOpacity;
    mat.eyes.uniforms.uSizeScale.value = look.eyeSize;
    mat.eyes.uniforms.uGain.value = look.eyeGlow;
    mat.headPoints.uniforms.uOpacity.value = settings.head.pointOpacity;
    mat.headLines.uniforms.uOpacity.value = settings.head.lineOpacity;
    mat.hair.uniforms.uOpacity.value = hairSettings.opacity;
    // Photo color: the face's points take their real colors, and the head the average skin tone.
    const photo = clamp(amount("photoColor"), 0, 1);
    for (const material of [mat.points, mat.lines, mat.headPoints, mat.headLines]) material.uniforms.uPhoto.value = photo;

    // Magnet: where the pointer meets a plane just in front of the face, in face space.
    const magnet = amount("magnet") * calm;
    u.uMagnet.value = 0;
    if (magnet > 0.01 && input.pointerPx.inside) {
      scratch.ndc.set((input.pointerPx.x / width) * 2 - 1, -(input.pointerPx.y / height) * 2 + 1);
      scratch.raycaster.setFromCamera(scratch.ndc, camera);
      scratch.inverse.copy(rig.headMatrix).invert();
      scratch.raycaster.ray.applyMatrix4(scratch.inverse);
      if (scratch.raycaster.ray.intersectPlane(scratch.plane, scratch.hit)) {
        u.uMagnetPos.value.copy(scratch.hit);
        u.uMagnet.value = magnet;
      }
    }

    // Ripples start at the point nearest a click, on the face or the head.
    while (input.clicks.length) {
      const click = input.clicks.shift()!;
      if (levels.ripple < 0.5) continue;
      let best: { at: Float32Array; i: number } | undefined;
      let bestDistance = CLICK_RADIUS * CLICK_RADIUS;
      const consider = (at: Float32Array, i: number, turns: boolean) => {
        scratch.v.fromArray(at, i * 3);
        if (turns) scratch.v.applyMatrix4(rig.headMatrix);
        scratch.v.project(camera);
        const dx = ((scratch.v.x + 1) / 2) * width - click.x;
        const dy = ((1 - scratch.v.y) / 2) * height - click.y;
        const d = dx * dx + dy * dy;
        if (d < bestDistance) {
          bestDistance = d;
          best = { at, i };
        }
      };
      for (let i = 0; i < data.vertexCount; i++) consider(scene.positions, i, true);
      if (scene.head && data.head && settings.head.show) {
        for (let i = 0; i < data.head.vertexCount; i++) consider(scene.head.positions, i, data.head.headWeight[i] > 0.5);
      }
      if (best) {
        const slot = u.uRipples.value[rig.nextRipple++ % u.uRipples.value.length];
        slot.set(best.at[best.i * 3], best.at[best.i * 3 + 1], best.at[best.i * 3 + 2], now);
      }
    }

    // Tell the input where the face is on screen, so pointer positions are measured from it. This
    // uses the unturned face, so turning toward the pointer doesn't move the point it aims from.
    const rect = frame.gl.domElement.getBoundingClientRect();
    scratch.v.set(0, 0.02, 0.03).project(camera);
    input.setCenter(rect.left + ((scratch.v.x + 1) / 2) * rect.width, rect.top + ((1 - scratch.v.y) / 2) * rect.height);

    // The profile buttons float around the head where there's room (plan §4.2).
    if (buttons) {
      const floating = floatQuery?.matches ?? false;
      if (floating !== rig.floating) {
        rig.floating = floating;
        buttons.nav.classList.toggle("buttons-floating", floating);
        if (!floating) for (const link of buttons.links) link.style.transform = "";
      }
      if (floating) {
        const b = settings.buttons;
        const style: ButtonStyle = reduced ? "ring" : b.style;
        buttons.links.forEach((link, i) => {
          const base = BUTTON_ANGLES[i % BUTTON_ANGLES.length] * DEG;
          const angle = style === "orbit" ? base + now * 0.06 * b.speed : base;
          scratch.v.set(Math.cos(angle) * 0.118 * b.spread, Math.sin(angle) * 0.118 * b.spread + 0.005, 0.03);
          if (style === "ring" && !reduced) scratch.v.y += Math.sin(now * 0.9 * b.speed + i * 1.3) * 0.004 * b.bob;
          // "head" turns with the face; the other styles stay level.
          if (style === "head") scratch.v.applyMatrix4(rig.headMatrix);
          scratch.v.project(camera);
          const x = ((scratch.v.x + 1) / 2) * width;
          const y = ((1 - scratch.v.y) / 2) * height;
          link.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        });
      }
    }
  });

  const keepHead = (object: Object3D | null) => {
    if (object && !headRefs.current.includes(object)) headRefs.current.push(object);
  };
  const keepOccluder = (object: Object3D | null) => {
    if (object && !occluderRefs.current.includes(object)) occluderRefs.current.push(object);
  };
  return (
    <group>
      <mesh ref={keepOccluder} geometry={scene.geometries.surface} material={scene.materials.occluder} frustumCulled={false} />
      {scene.head && (
        <mesh ref={keepOccluder} geometry={scene.head.surface} material={scene.materials.occluder} frustumCulled={false} />
      )}
      {scene.head && (
        <>
          <lineSegments ref={keepHead} geometry={scene.head.lines} material={scene.materials.headLines} frustumCulled={false} />
          <points ref={keepHead} geometry={scene.head.geometry} material={scene.materials.headPoints} frustumCulled={false} />
        </>
      )}
      <lineSegments ref={hairRef} geometry={scene.hair} material={scene.materials.hair} frustumCulled={false} />
      <lineSegments geometry={scene.geometries.lines} material={scene.materials.lines} frustumCulled={false} />
      <points geometry={scene.geometries.points} material={scene.materials.points} frustumCulled={false} />
      <points geometry={scene.geometries.eyes} material={scene.materials.eyes} frustumCulled={false} />
    </group>
  );
}

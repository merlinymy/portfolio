/**
 * The flame look (docs/face-looks-plan.md, "Flame"): your face as charred embers with glowing
 * cracks, flames licking up off its edges and features, a glow and heat haze around the fire, and
 * sparks drifting up from the hottest spots.
 *
 * Each frame:
 * 1. The face is drawn into a hidden picture of its heat: its open edges (outline, eyes, lips),
 *    the sides that turn away from you, and the parts that move most.
 * 2. The fire picture is fed back into itself: moved upward, swirled by curl noise, softened and
 *    cooled, then topped up from the heat picture. That's what makes the flames rise.
 * 3. On screen: the charred face, then the fire in fire colors with its glow and haze (held back
 *    over the face by "face strength"), then the sparks.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  Plane,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderTarget,
} from "three";
import { settings, type FaceState } from "../settings";
import { createLookMaterial } from "../shaders";
import { FacePoints, type Look, type LookFrame, type LookParts, Pass, fullscreen, fullscreenVertex, hiddenPicture, lookSurface } from "./common";
import { fireRamp, noise } from "./glsl";

/** States that keep the fire its natural colors; the others tint it with their color. */
const UNTINTED: FaceState[] = ["idle", "panel", "listening", "speaking"];
const SPARK_COUNT = 2400;

const heatFragment = /* glsl */ `
uniform float uTime, uEdgeHeat, uRimHeat, uFeatureHeat, uHeat;
varying vec3 vNormal, vView, vFace;
varying float vExpressive, vEdge;
${noise}
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(-vView)));
  float rim = pow(1.0 - facing, 2.0);
  float flicker = 0.65 + 0.35 * snoise(vec3(vFace.xy * 70.0, uTime * 1.7));
  float heat = (vEdge * uEdgeHeat + rim * uRimHeat + vExpressive * uFeatureHeat * 0.6) * flicker * uHeat;
  gl_FragColor = vec4(heat, vExpressive, 0.0, 1.0);
}
`;

const fireFragment = /* glsl */ `
uniform sampler2D uPrev, uHeatMap;
uniform vec2 uTexel, uPointer, uPointerVelocity;
uniform float uAspect, uDt, uTime, uRise, uTurbulence, uSwirlSize, uSwirlSpeed, uCooling, uFlicker, uSoftness, uPointerStir;
varying vec2 vUv;
${noise}
void main() {
  // Work in square units, one screen height tall, so swirls are round on any screen.
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  vec2 velocity = vec2(0.0, uRise) + curl(q * uSwirlSize, uTime * uSwirlSpeed * 0.3) * uTurbulence * 0.08;
  vec2 d = q - vec2(uPointer.x * uAspect, uPointer.y);
  velocity += uPointerVelocity * exp(-dot(d, d) / 0.006) * uPointerStir;
  // Where this pixel's fire came from a moment ago.
  vec2 from = vUv - vec2(velocity.x / uAspect, velocity.y) * uDt;
  vec2 o = uTexel * uSoftness;
  float heat = texture2D(uPrev, from).r * 0.4
    + (texture2D(uPrev, from + vec2(o.x, 0.0)).r + texture2D(uPrev, from - vec2(o.x, 0.0)).r
    + texture2D(uPrev, from + vec2(0.0, o.y)).r + texture2D(uPrev, from - vec2(0.0, o.y)).r) * 0.15;
  // Cooling, uneven so the flames break into tongues.
  float uneven = snoise(vec3(q * 11.0, uTime * 2.2)) * 0.5 + 0.5;
  heat = max(heat - uCooling * uDt * (1.0 + uFlicker * uneven * 2.0), 0.0);
  heat = max(heat, texture2D(uHeatMap, vUv).r);
  gl_FragColor = vec4(heat, 0.0, 0.0, 1.0);
}
`;

const compositeFragment = /* glsl */ `
uniform sampler2D uFire, uHeatMap;
uniform vec2 uTexel;
uniform float uAspect, uTime, uBrightness, uBloom, uHaze, uFaceStrength, uTintAmount;
uniform vec3 uTint;
varying vec2 vUv;
${noise}
${fireRamp}
void main() {
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  vec2 haze = vec2(snoise(vec3(q * 13.0, uTime * 2.6)), snoise(vec3(q * 13.0 + 7.3, uTime * 2.6))) * uHaze * 0.0035;
  float heat = texture2D(uFire, vUv + haze).r;
  // The glow: the fire averaged over two rings around this pixel.
  float glow = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854;
    vec2 dir = vec2(cos(a), sin(a));
    glow += texture2D(uFire, vUv + dir * uTexel * 7.0).r + 0.7 * texture2D(uFire, vUv + dir * uTexel * 19.0).r;
  }
  glow /= 13.6;
  vec3 color = fireRamp(heat * uBrightness, uTint, uTintAmount)
    + fireRamp(glow * uBrightness * 0.9, uTint, uTintAmount) * uBloom * 0.8;
  float face = texture2D(uHeatMap, vUv).a;
  color *= 1.0 - face * uFaceStrength;
  // Bright parts roll off gently toward white instead of clipping flat.
  gl_FragColor = vec4(1.0 - exp(-color * 1.15), 1.0);
}
`;

const emberFragment = /* glsl */ `
uniform float uTime, uEmberGlow, uCrackSize, uCrackFlow, uFaceLight, uUnderLight, uHeat, uTintAmount;
uniform vec3 uTint;
varying vec3 vNormal, vView, vFace;
varying float vExpressive, vEdge;
${noise}
${fireRamp}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vView);
  if (dot(n, v) < 0.0) n = -n;
  float facing = dot(n, v);
  // Cracks: thin ridges of two layers of noise, fixed to the face so they move with it.
  vec3 f = vFace * uCrackSize * 10.0;
  float t = uTime * uCrackFlow;
  float ridge = 1.0 - abs(snoise(f + vec3(0.0, 0.0, t * 0.08)) * 0.7 + snoise(f * 2.3 + vec3(5.0, 1.0, -t * 0.13)) * 0.3);
  float cracks = pow(smoothstep(0.84, 1.0, ridge), 3.0);
  float pulse = 0.7 + 0.3 * sin(t * 2.3 + vFace.y * 45.0 + vFace.x * 20.0);
  float heat = cracks * uEmberGlow * pulse * 1.2 + vEdge * 0.55 + vExpressive * 0.15 + pow(1.0 - facing, 3.0) * 0.6;
  heat *= uHeat;
  // Charred crust, lit orange from the fire below and softly from the front.
  vec3 crust = vec3(0.06, 0.04, 0.035);
  float below = max(dot(n, normalize(vec3(0.0, -0.65, 0.75))), 0.0);
  float front = max(dot(n, normalize(vec3(-0.35, 0.3, 0.9))), 0.0);
  vec3 lit = crust
    + vec3(1.0, 0.42, 0.12) * below * below * uUnderLight * 0.4 * uHeat
    + vec3(0.85, 0.66, 0.52) * pow(front, 1.5) * uFaceLight * 0.6;
  gl_FragColor = vec4(1.0 - exp(-(lit + fireRamp(heat, uTint, uTintAmount)) * 1.15), 1.0);
}
`;

const sparkVertex = /* glsl */ `
uniform sampler2D uFacePoints;
uniform float uFaceCount, uTime, uScale, uRate, uRise, uLife, uSize, uWander, uHeat, uPointerPush;
uniform mat4 uHead;
uniform vec3 uPointer;
attribute vec3 aRandom;
varying float vAge, vGlow;
${noise}
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float life = uLife * mix(0.55, 1.45, aRandom.x);
  float clock = uTime + aRandom.y * life;
  float cycle = floor(clock / life);
  float age = fract(clock / life);
  float seconds = age * life;
  // Each new life starts at a random point on the face, more often at the hot ones.
  float pick = floor(hash(aRandom.z * 113.1 + cycle * 7.77) * uFaceCount);
  vec4 from = texture2D(uFacePoints, vec2((pick + 0.5) / uFaceCount, 0.5));
  float alive = step(hash(cycle * 3.17 + aRandom.x * 51.3), (0.2 + 0.8 * from.w) * uRate);
  vec3 p = (uHead * vec4(from.xyz, 1.0)).xyz;
  vec3 outward = normalize(p - vec3(0.0, 0.0, -0.04));
  float s = aRandom.y * 40.0;
  p += outward * 0.01 * seconds;
  p.y += uRise * (0.022 * seconds + 0.014 * seconds * seconds);
  p.x += (snoise(vec3(s, seconds * 0.6, 0.0)) * 0.016 + sin(seconds * 2.3 + s) * 0.004) * uWander * sqrt(seconds);
  p.z += snoise(vec3(s, 3.0, seconds * 0.5)) * 0.01 * uWander * sqrt(seconds);
  vec3 away = p - uPointer;
  p += normalize(away + 1e-5) * exp(-dot(away, away) / 0.0012) * 0.03 * uPointerPush;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = uSize * 0.0011 * mix(0.5, 1.6, aRandom.z) * (1.0 - age * 0.7);
  gl_PointSize = max(1.0, size * uScale / -mv.z) * alive;
  vAge = age;
  vGlow = alive * uHeat * (0.75 + 0.25 * sin(seconds * 23.0 + s));
}
`;

const sparkFragment = /* glsl */ `
uniform float uTintAmount;
uniform vec3 uTint;
varying float vAge, vGlow;
${fireRamp}
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  vec3 color = fireRamp(mix(1.7, 0.3, vAge), uTint, uTintAmount) * core * core * vGlow * (1.0 - vAge * vAge);
  gl_FragColor = vec4(color, 1.0);
}
`;

export function createFlame(parts: LookParts): Look {
  const uniforms = parts.scene.uniforms;
  const surface = lookSurface(parts);
  const tint = new Color(1, 0.34, 0.04);
  const tintAmount = { value: 0 };
  const shared = { uTint: { value: tint }, uTintAmount: tintAmount };

  // 1. The heat picture: the face drawn with its heat, from the same camera.
  const heatMaterial = createLookMaterial(uniforms, heatFragment, {
    uEdgeHeat: { value: 1 },
    uRimHeat: { value: 1 },
    uFeatureHeat: { value: 1 },
    uHeat: { value: 0 },
  });
  const heatScene = new Scene();
  const heatMesh = new Mesh(surface, heatMaterial);
  heatMesh.frustumCulled = false;
  heatScene.add(heatMesh);

  // 2. The fire picture, fed back into itself: two pictures that take turns.
  const fire = new Pass(
    new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: fireFragment,
      uniforms: {
        uPrev: { value: null },
        uHeatMap: { value: null },
        uTexel: { value: new Vector2() },
        uPointer: { value: new Vector2(-1, -1) },
        uPointerVelocity: { value: new Vector2() },
        uAspect: { value: 1 },
        uDt: { value: 0 },
        uTime: uniforms.uTime,
        uRise: { value: 0 },
        uTurbulence: { value: 0 },
        uSwirlSize: { value: 1 },
        uSwirlSpeed: { value: 1 },
        uCooling: { value: 1 },
        uFlicker: { value: 0 },
        uSoftness: { value: 1 },
        uPointerStir: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  let pictures: { heat: WebGLRenderTarget; a: WebGLRenderTarget; b: WebGLRenderTarget } | undefined;
  let pictureKey = "";

  // 3. On screen: the charred face, the fire over it, then the sparks.
  const emberMaterial = createLookMaterial(uniforms, emberFragment, {
    ...shared,
    uEmberGlow: { value: 1 },
    uCrackSize: { value: 7 },
    uCrackFlow: { value: 1 },
    uFaceLight: { value: 0.3 },
    uUnderLight: { value: 0.5 },
    uHeat: { value: 0 },
  });
  const ember = new Mesh(surface, emberMaterial);
  ember.frustumCulled = false;
  ember.renderOrder = 1;

  const compositeMaterial = new ShaderMaterial({
    vertexShader: fullscreenVertex,
    fragmentShader: compositeFragment,
    uniforms: {
      ...shared,
      uFire: { value: null },
      uHeatMap: { value: null },
      uTexel: { value: new Vector2() },
      uAspect: { value: 1 },
      uTime: uniforms.uTime,
      uBrightness: { value: 1 },
      uBloom: { value: 0 },
      uHaze: { value: 0 },
      uFaceStrength: { value: 0 },
    },
    blending: AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const composite = fullscreen(compositeMaterial);
  composite.renderOrder = 2;

  const sparkGeometry = new BufferGeometry();
  const randoms = new Float32Array(SPARK_COUNT * 3);
  for (let i = 0; i < randoms.length; i++) randoms[i] = Math.random();
  sparkGeometry.setAttribute("position", new BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3));
  sparkGeometry.setAttribute("aRandom", new BufferAttribute(randoms, 3));
  const facePoints = new FacePoints(parts);
  const sparkMaterial = new ShaderMaterial({
    vertexShader: sparkVertex,
    fragmentShader: sparkFragment,
    uniforms: {
      ...shared,
      uFacePoints: { value: facePoints.texture },
      uFaceCount: { value: facePoints.count },
      uTime: uniforms.uTime,
      uScale: uniforms.uScale,
      uHead: uniforms.uHead,
      uRate: { value: 0 },
      uRise: { value: 1 },
      uLife: { value: 2 },
      uSize: { value: 1 },
      uWander: { value: 1 },
      uHeat: { value: 0 },
      uPointer: { value: new Vector3(0, 0, 10) },
      uPointerPush: { value: 0 },
    },
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const sparks = new Points(sparkGeometry, sparkMaterial);
  sparks.frustumCulled = false;
  sparks.renderOrder = 3;

  const object = new Group();
  object.add(ember, composite, sparks);

  const pointer = { uv: new Vector2(-1, -1), velocity: new Vector2(), seen: false, speed: 0 };
  const scratch = {
    ndc: new Vector2(),
    move: new Vector2(),
    raycaster: new Raycaster(),
    plane: new Plane(new Vector3(0, 0, 1), -0.04),
    hit: new Vector3(),
    color: new Color(),
    clear: new Color(),
    size: new Vector2(),
  };
  const eyes = { glow: 0, color: new Color(1, 0.8, 0.5) };

  function resize(frame: LookFrame, quality: number) {
    frame.gl.getDrawingBufferSize(scratch.size);
    const w = Math.max(16, Math.round(scratch.size.x * quality));
    const h = Math.max(16, Math.round(scratch.size.y * quality));
    const key = `${w}x${h}`;
    if (key === pictureKey && pictures) return pictures;
    if (pictures) for (const t of Object.values(pictures)) t.dispose();
    pictures = { heat: hiddenPicture(w, h), a: hiddenPicture(w, h), b: hiddenPicture(w, h) };
    pictureKey = key;
    for (const t of [pictures.a, pictures.b]) {
      frame.gl.setRenderTarget(t);
      frame.gl.clear();
    }
    return pictures;
  }

  return {
    object,
    eyes,
    update(frame) {
      const f = settings.looks.flame;
      const dt = Math.min(frame.dt, 1 / 20);
      const calm = frame.reduced ? 0.35 : 1;
      const gl = frame.gl;
      gl.getClearColor(scratch.clear);
      const clearAlpha = gl.getClearAlpha();
      gl.setClearColor(0x000000, 0);
      const p = resize(frame, f.quality);
      const aspect = frame.width / Math.max(1, frame.height);

      // The fire follows the state: its brightness sets the heat, the voice flares it, and states
      // other than idle tint it their color.
      const flare = 1 + frame.loudness * f.voiceFlare;
      const heat = frame.brightness * frame.intro * flare;
      // The charred face flares only a little; the flames carry the voice.
      const faceHeat = frame.brightness * frame.intro * (1 + frame.loudness * f.voiceFlare * 0.3);
      const tinted = !UNTINTED.includes(frame.state);
      const ease = 1 - Math.exp(-dt / 0.4);
      tintAmount.value += ((tinted ? f.stateTint : 0) - tintAmount.value) * ease;
      tint.lerp(scratch.color.set(settings.states[frame.state].color), ease);

      // The pointer: where it is in the picture and how fast it moves, in screen heights a second.
      if (frame.pointer.inside) {
        const u = frame.pointer.x / Math.max(1, frame.width);
        const v = 1 - frame.pointer.y / Math.max(1, frame.height);
        if (pointer.seen && dt > 0) {
          pointer.velocity.lerp(scratch.move.set(((u - pointer.uv.x) * aspect) / dt, (v - pointer.uv.y) / dt), 0.5);
        }
        pointer.uv.set(u, v);
        pointer.seen = true;
      } else {
        pointer.seen = false;
        pointer.velocity.multiplyScalar(Math.exp(-dt / 0.15));
      }
      pointer.velocity.clampLength(0, 3);
      pointer.speed = pointer.velocity.length();

      // 1. Heat picture.
      facePoints.update(frame.positions);
      const hu = heatMaterial.uniforms;
      hu.uEdgeHeat.value = f.edgeHeat;
      hu.uRimHeat.value = f.rimHeat;
      hu.uFeatureHeat.value = f.featureHeat;
      hu.uHeat.value = heat;
      gl.setRenderTarget(p.heat);
      gl.clear();
      gl.render(heatScene, frame.camera);

      // 2. Fire picture: read one, write the other, then swap.
      const fu = fire.material.uniforms;
      fu.uPrev.value = p.a.texture;
      fu.uHeatMap.value = p.heat.texture;
      fu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      fu.uPointer.value.copy(pointer.uv);
      fu.uPointerVelocity.value.copy(pointer.velocity);
      fu.uAspect.value = aspect;
      fu.uDt.value = dt;
      fu.uRise.value = f.rise * calm;
      fu.uTurbulence.value = f.turbulence;
      fu.uSwirlSize.value = f.swirlSize;
      fu.uSwirlSpeed.value = f.swirlSpeed * calm;
      fu.uCooling.value = f.cooling;
      fu.uFlicker.value = f.flicker * calm;
      fu.uSoftness.value = f.softness;
      fu.uPointerStir.value = f.pointerStir * 0.25;
      fire.render(gl, p.b);
      [p.a, p.b] = [p.b, p.a];
      gl.setRenderTarget(null);
      gl.setClearColor(scratch.clear, clearAlpha);

      // 3. On screen.
      const cu = compositeMaterial.uniforms;
      cu.uFire.value = p.a.texture;
      cu.uHeatMap.value = p.heat.texture;
      cu.uTexel.value.set(1 / p.a.width, 1 / p.a.height);
      cu.uAspect.value = aspect;
      cu.uBrightness.value = f.brightness;
      cu.uBloom.value = f.bloom;
      cu.uHaze.value = f.haze * calm;
      cu.uFaceStrength.value = f.faceStrength;

      const eu = emberMaterial.uniforms;
      eu.uEmberGlow.value = f.emberGlow;
      eu.uCrackSize.value = f.crackSize;
      eu.uCrackFlow.value = f.crackFlow * calm;
      eu.uFaceLight.value = f.faceLight;
      eu.uUnderLight.value = f.underLight;
      eu.uHeat.value = faceHeat;

      // Sparks fly from the hot spots; the pointer pushes them where it meets the face's front.
      const su = sparkMaterial.uniforms;
      su.uRate.value = f.sparks * Math.min(1, 0.6 + 0.4 * flare) * (frame.reduced ? 0 : 1) * frame.intro;
      su.uRise.value = f.sparkRise;
      su.uLife.value = f.sparkLife;
      su.uSize.value = f.sparkSize;
      su.uWander.value = f.sparkWander;
      su.uHeat.value = heat;
      su.uPointerPush.value = 0;
      if (frame.pointer.inside) {
        scratch.ndc.set(pointer.uv.x * 2 - 1, pointer.uv.y * 2 - 1);
        scratch.raycaster.setFromCamera(scratch.ndc, frame.camera);
        if (scratch.raycaster.ray.intersectPlane(scratch.plane, scratch.hit)) {
          su.uPointer.value.copy(scratch.hit);
          su.uPointerPush.value = f.pointerStir * Math.min(1, 0.25 + pointer.speed);
        }
      }

      // Ember eyes: white-hot rings, tinted with the fire.
      eyes.glow = f.eyeGlow * Math.min(1.5, heat);
      eyes.color.setRGB(1, 0.72, 0.42).lerp(tint, tintAmount.value * 0.6);
    },
    dispose() {
      if (pictures) for (const t of Object.values(pictures)) t.dispose();
      fire.dispose();
      heatMaterial.dispose();
      emberMaterial.dispose();
      compositeMaterial.dispose();
      composite.geometry.dispose();
      sparkMaterial.dispose();
      sparkGeometry.dispose();
      facePoints.dispose();
    },
  };
}

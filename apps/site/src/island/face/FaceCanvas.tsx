/**
 * The 3D part of the face island, loaded only after the page's HTML is on screen (plan §5.3):
 * the canvas and the ?lab panel.
 *
 * The stage's data-face attribute says what's showing, for tests and the still-image script:
 * "ready" once the 3D face draws, "still" when the fallback image shows instead.
 *
 * ?still holds the neutral face with no intro, which is how tools/face/still.ts renders the
 * fallback and preview images.
 */
import { Canvas } from "@react-three/fiber";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { loadFace, type FaceData } from "./data";
import { FOV, Face, type FaceButtons } from "./Face";
import { LookInput } from "./input";
import { control, settings } from "./settings";

const Lab = lazy(() => import("../lab/Lab"));

/** three.js needs WebGL 2. Without it the page stays the plain profile, which still works. */
function hasWebGL2() {
  try {
    return Boolean(document.createElement("canvas").getContext("webgl2"));
  } catch {
    return false;
  }
}

export default function FaceCanvas({ container, buttons }: { container: HTMLElement; buttons?: FaceButtons }) {
  const [data, setData] = useState<FaceData>();
  const [input, setInput] = useState<LookInput>();
  const [visible, setVisible] = useState(true);
  const [failed, setFailed] = useState(false);
  const supported = useMemo(hasWebGL2, []);
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const lab = params.has("lab");

  useEffect(() => {
    if (!params.has("still")) return;
    control.still = true;
    settings.effects.assemble.mode = "off";
  }, [params]);

  // In the lab, `face.settings` and `face.control` in the browser console reach the same values.
  useEffect(() => {
    if (lab) Object.assign(window, { face: { settings, control } });
  }, [lab]);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    loadFace().then(
      (face) => live && setData(face),
      (error) => {
        console.error("The face didn't load:", error);
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [supported]);

  useEffect(() => {
    const look = new LookInput(container);
    setInput(look);
    return () => look.dispose();
  }, [container]);

  // Stop drawing while the face is scrolled out of view.
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  // Without WebGL, or if the face files didn't load, a still image of the face stands in.
  const still = !supported || failed;
  useEffect(() => {
    if (still) container.dataset.face = "still";
  }, [still, container]);

  if (still) return <img className="face-still" src="/face/still.jpg" alt="" />;
  if (!data || !input) return null;
  return (
    <>
      <div className="face-canvas" aria-hidden="true">
        <Canvas
          dpr={[1, 2]}
          frameloop={visible ? "always" : "never"}
          camera={{ fov: FOV, near: 0.01, far: 5 }}
          onCreated={() => {
            container.dataset.face = "ready";
          }}
        >
          <Face data={data} input={input} buttons={buttons} />
        </Canvas>
      </div>
      {lab && (
        <Suspense fallback={null}>
          <Lab data={data} />
        </Suspense>
      )}
    </>
  );
}

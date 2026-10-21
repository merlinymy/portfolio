/**
 * The 3D part of the face island, loaded only after the page's HTML is on screen (plan §5.3):
 * the canvas, the "Follow my tilt" button on iPhone, and the ?lab panel.
 */
import { Canvas } from "@react-three/fiber";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { loadFace, type FaceData } from "./data";
import { FOV, Face, type FaceButtons } from "./Face";
import { LookInput, prefersReducedMotion, tiltNeedsPermission } from "./input";
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
  const [askTilt, setAskTilt] = useState(false);
  const supported = useMemo(hasWebGL2, []);
  const lab = useMemo(() => new URLSearchParams(location.search).has("lab"), []);

  // In the lab, `face.settings` and `face.control` in the browser console reach the same values.
  useEffect(() => {
    if (lab) Object.assign(window, { face: { settings, control } });
  }, [lab]);

  useEffect(() => {
    if (!supported) return;
    let live = true;
    loadFace().then(
      (face) => live && setData(face),
      (error) => console.error("The face didn't load:", error),
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

  useEffect(() => {
    setAskTilt(tiltNeedsPermission() && matchMedia("(pointer: coarse)").matches && !prefersReducedMotion());
  }, []);

  if (!supported || !data || !input) return null;
  return (
    <>
      <div className="face-canvas" aria-hidden="true">
        <Canvas dpr={[1, 2]} frameloop={visible ? "always" : "never"} camera={{ fov: FOV, near: 0.01, far: 5 }}>
          <Face data={data} input={input} buttons={buttons} />
        </Canvas>
      </div>
      {askTilt && (
        <button
          type="button"
          className="tilt-button"
          onClick={async () => {
            if (await input.enableTilt().catch(() => false)) setAskTilt(false);
          }}
        >
          Follow my tilt
        </button>
      )}
      {lab && (
        <Suspense fallback={null}>
          <Lab data={data} />
        </Suspense>
      )}
    </>
  );
}

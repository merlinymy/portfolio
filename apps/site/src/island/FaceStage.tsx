import { Suspense, lazy, useEffect, useState } from "react";
import type { FaceButtons } from "./face/Face";
import { setupPanels } from "./panels";

const FaceCanvas = lazy(() => import("./face/FaceCanvas"));

/**
 * The face island (plan §4.2, §5). The server renders an empty stage. In the browser:
 *   - the six profile sections become pop-up panels right away, so the buttons work even if the
 *     3D face never loads (no WebGL, or a failed download);
 *   - the 3D face (three.js and the face data) then loads into the stage and floats the buttons
 *     around the head.
 */
export default function FaceStage() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [buttons, setButtons] = useState<FaceButtons>();

  useEffect(() => {
    const cleanup = setupPanels();
    const nav = document.querySelector<HTMLElement>(".profile-nav");
    if (nav) setButtons({ nav, links: [...nav.querySelectorAll<HTMLElement>("a")] });
    return cleanup;
  }, []);

  return (
    <div className="face-stage" ref={setContainer}>
      {container && (
        <Suspense fallback={null}>
          <FaceCanvas container={container} buttons={buttons} />
        </Suspense>
      )}
    </div>
  );
}

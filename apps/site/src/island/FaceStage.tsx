import { Suspense, lazy, useState } from "react";

const FaceCanvas = lazy(() => import("./face/FaceCanvas"));

/**
 * The face island (plan §5). The server renders an empty stage; once the browser has the page, the
 * 3D face (three.js and the face data) loads into it, so text and links never wait for it.
 */
export default function FaceStage() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div className="face-stage" ref={setContainer}>
      {container && (
        <Suspense fallback={null}>
          <FaceCanvas container={container} />
        </Suspense>
      )}
    </div>
  );
}

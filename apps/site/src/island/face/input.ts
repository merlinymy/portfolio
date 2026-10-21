/**
 * Where the face should look (plan §5.5): the mouse pointer, or a finger on the face. Positions
 * are -1 to 1 across the window from the face's center, +x right and +y up.
 */
type Source = "pointer" | "touch";

const reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

/** The operating system's setting for people who get motion sickness (plan §5.5). */
export const prefersReducedMotion = () => reducedMotion?.matches ?? false;

export class LookInput {
  x = 0;
  y = 0;
  /** False when nothing is steering the face, so it drifts back to center. */
  active = false;
  source: Source | undefined;
  /** The last pointer position in canvas pixels, for the magnet effect. */
  readonly pointerPx = { x: 0, y: 0, inside: false };
  /** Clicks and taps on the canvas since the last frame, in canvas pixels, for ripples. */
  readonly clicks: { x: number; y: number }[] = [];

  private centerX = 0;
  private centerY = 0;
  private readonly removers: (() => void)[] = [];

  constructor(private readonly canvas: HTMLElement) {
    this.listen(window, "pointermove", (e) => this.onPointer(e as PointerEvent));
    this.listen(canvas, "pointerdown", (e) => {
      this.onPointer(e as PointerEvent);
      if (this.clicks.length < 4) this.clicks.push({ x: this.pointerPx.x, y: this.pointerPx.y });
    });
    this.listen(window, "pointerup", (e) => this.onRelease(e as PointerEvent));
    this.listen(window, "pointercancel", (e) => this.onRelease(e as PointerEvent));
    this.listen(document.documentElement, "pointerleave", () => {
      if (this.source === "pointer") this.active = false;
      this.pointerPx.inside = false;
    });
  }

  /** A point in client pixels, as -1 to 1 across the window from the face's center. */
  normalize(clientX: number, clientY: number): [number, number] {
    return [
      Math.max(-1, Math.min(1, (clientX - this.centerX) / (innerWidth / 2))),
      Math.max(-1, Math.min(1, -(clientY - this.centerY) / (innerHeight / 2))),
    ];
  }

  /** The face's center on screen, in client pixels, so pointer positions are measured from it. */
  setCenter(x: number, y: number) {
    this.centerX = x;
    this.centerY = y;
  }

  dispose() {
    for (const remove of this.removers) remove();
  }

  private listen(target: EventTarget, type: string, handler: (e: Event) => void) {
    target.addEventListener(type, handler, { passive: true });
    this.removers.push(() => target.removeEventListener(type, handler));
  }

  private onPointer(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerPx.x = e.clientX - rect.left;
    this.pointerPx.y = e.clientY - rect.top;
    this.pointerPx.inside =
      this.pointerPx.x >= 0 && this.pointerPx.y >= 0 && this.pointerPx.x <= rect.width && this.pointerPx.y <= rect.height;
    const touch = e.pointerType === "touch";
    // A finger steers only after touching the face area, not while scrolling elsewhere.
    if (touch && e.type === "pointermove" && this.source !== "touch") return;
    this.source = touch ? "touch" : "pointer";
    this.active = true;
    [this.x, this.y] = this.normalize(e.clientX, e.clientY);
  }

  private onRelease(e: PointerEvent) {
    if (e.pointerType === "touch" && this.source === "touch") {
      this.active = false;
      this.source = undefined;
      this.pointerPx.inside = false;
    }
  }
}

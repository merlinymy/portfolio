/**
 * Where the face should look (plan §5.5): the mouse pointer, a finger on the face, or the phone's
 * tilt. Positions are -1 to 1 across the window from the face's center, +x right and +y up.
 */
import { settings } from "./settings";

type Source = "pointer" | "touch" | "tilt";

interface TiltEvent {
  beta: number | null;
  gamma: number | null;
}

/** Safari on iPhone only shares motion data after a tap, through this extra static method. */
type PermissionedOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;

/** The operating system's setting for people who get motion sickness (plan §5.5). */
export const prefersReducedMotion = () => reducedMotion?.matches ?? false;

/** True where tilt needs a tap to start (iPhone and iPad Safari). */
export const tiltNeedsPermission = () =>
  typeof DeviceOrientationEvent !== "undefined" &&
  typeof (DeviceOrientationEvent as PermissionedOrientation).requestPermission === "function";

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
  private tilting = false;
  private tiltZero: { beta: number; gamma: number } | undefined;
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
    // Android Chrome shares tilt without asking; iPhone waits for enableTilt() from a tap.
    if (!tiltNeedsPermission() && matchMedia("(pointer: coarse)").matches) this.startTilt();
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

  /** Asks for tilt permission on iPhone. Must be called from a tap. Resolves to whether it worked. */
  async enableTilt(): Promise<boolean> {
    const orientation = DeviceOrientationEvent as PermissionedOrientation;
    if (orientation.requestPermission && (await orientation.requestPermission()) !== "granted") return false;
    this.startTilt();
    return true;
  }

  dispose() {
    for (const remove of this.removers) remove();
  }

  private startTilt() {
    if (this.tilting || prefersReducedMotion()) return;
    this.tilting = true;
    this.listen(window, "deviceorientation", (e) => this.onTilt(e as unknown as TiltEvent));
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
    // A finger steers only after touching the face area; tilt keeps control otherwise.
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

  private onTilt(e: TiltEvent) {
    if (e.beta === null || e.gamma === null || this.source === "touch") return;
    // The first reading is "straight ahead", since people hold phones at an angle.
    this.tiltZero ??= { beta: e.beta, gamma: e.gamma };
    let dx = e.gamma - this.tiltZero.gamma;
    let dy = e.beta - this.tiltZero.beta;
    // In landscape the phone's axes are turned relative to the screen.
    const angle = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    [dx, dy] = [dx * Math.cos(angle) + dy * Math.sin(angle), dy * Math.cos(angle) - dx * Math.sin(angle)];
    const { tiltRange, tiltInvert } = settings.motion;
    const sign = tiltInvert ? -1 : 1;
    this.source = "tilt";
    this.active = true;
    this.x = Math.max(-1, Math.min(1, (sign * dx) / tiltRange));
    this.y = Math.max(-1, Math.min(1, (sign * dy) / tiltRange));
  }
}

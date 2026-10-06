import { isDesktop } from "../platform.ts";
import { preloadWindowApi, startDragging } from "./window.ts";

/**
 * Moving the companion window without a title bar.
 *
 * The window has no chrome, so it can be dragged from anywhere — but a plain
 * press must keep doing what it always did: call the butterfly closer. The
 * gesture therefore only becomes a drag once the pointer travels
 * `DRAG_THRESHOLD` pixels, and the click a completed drag would otherwise emit
 * is swallowed in the capture phase, before the scene's own click handler can
 * see it. A press that never moves is untouched: hover still shows interest,
 * a click still summons.
 */

/** Pixels of movement before a press turns into a window drag. */
export const DRAG_THRESHOLD = 6;

/**
 * Gesture state, kept free of the DOM so the decision logic is unit-testable.
 *
 * Lifecycle: `begin` on pointer down, `move` on pointer move, then either
 * `end` (pointer up) or `cancel` (pointer cancelled, window blurred). The
 * click-suppression flag outlives `end`, because a click is delivered after
 * pointer up.
 */
export class DragGesture {
  private origin: { x: number; y: number } | null = null;
  private dragging = false;
  private swallowClick = false;

  /** Starts a gesture, dropping any suppression that was never consumed. */
  begin(x: number, y: number): void {
    this.origin = { x, y };
    this.dragging = false;
    this.swallowClick = false;
  }

  /**
   * Tracks the pointer. Returns true exactly once per gesture — the moment
   * movement crosses the threshold — which is the single signal to hand the
   * window to the operating system.
   */
  move(x: number, y: number): boolean {
    if (!this.origin || this.dragging) return false;
    if (Math.hypot(x - this.origin.x, y - this.origin.y) < DRAG_THRESHOLD) return false;
    this.dragging = true;
    this.swallowClick = true;
    return true;
  }

  /** Ends the gesture normally; a pending click suppression is kept. */
  end(): void {
    this.origin = null;
    this.dragging = false;
  }

  /** Abandons the gesture and its suppression (pointer cancelled, blur). */
  cancel(): void {
    this.origin = null;
    this.dragging = false;
    this.swallowClick = false;
  }

  /** True when this click belongs to a drag; consumes the flag (one click). */
  consumeClick(): boolean {
    if (!this.swallowClick) return false;
    this.swallowClick = false;
    return true;
  }
}

/**
 * Installs the gesture over the whole window and returns its cleanup
 * function. Outside the desktop shell this does nothing, so the web build
 * keeps exactly the behaviour it has today.
 */
export function attachWindowDrag(target?: Window): () => void {
  // Resolved defensively so the module also loads in non-DOM environments
  // (the headless tests call this to prove the web path is a true no-op).
  const element = target ?? (typeof window !== "undefined" ? window : null);
  if (!element || !isDesktop) return () => {};

  preloadWindowApi();
  const gesture = new DragGesture();

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return; // primary button only
    gesture.begin(event.clientX, event.clientY);
  };

  const onPointerMove = (event: PointerEvent) => {
    if ((event.buttons & 1) === 0) return;
    if (gesture.move(event.clientX, event.clientY)) void startDragging();
  };

  const onPointerUp = () => gesture.end();
  const onCancel = () => gesture.cancel();
  const onBlur = () => gesture.cancel();

  // Capture phase: runs before the canvas listener, so a drag's click never
  // reaches the scene's summon handler.
  const onClick = (event: MouseEvent) => {
    if (gesture.consumeClick()) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onCancel);
  element.addEventListener("blur", onBlur);
  element.addEventListener("click", onClick, true);

  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onCancel);
    element.removeEventListener("blur", onBlur);
    element.removeEventListener("click", onClick, true);
  };
}

/**
 * Selective click-through for the desktop overlay.
 *
 * The overlay starts fully click-through (the native layer enables
 * ignore-cursor-events at launch, so applications underneath are never
 * blocked). This zone flips interaction on only while the cursor is close
 * to the butterfly, and back off when it leaves — with hysteresis between
 * the two radii so the boundary can never flicker on small movements.
 *
 * Kept free of the DOM and the Tauri API so the state machine is unit-testable.
 */
export class HitZone {
  private interactive = false;
  /** Distance (px) below which the overlay becomes interactive. */
  private readonly enterRadius: number;
  /** Distance (px) beyond which the overlay returns to click-through. */
  private readonly exitRadius: number;

  constructor(enterRadius = 90, exitRadius = 150) {
    this.enterRadius = enterRadius;
    this.exitRadius = exitRadius;
  }

  /**
   * Feeds the cursor↔butterfly distance in pixels. Returns true while the
   * overlay should receive cursor events, false while it should pass them
   * through to the applications underneath.
   */
  update(distancePx: number): boolean {
    if (this.interactive) {
      if (distancePx > this.exitRadius) this.interactive = false;
    } else if (distancePx < this.enterRadius) {
      this.interactive = true;
    }
    return this.interactive;
  }

  get isInteractive(): boolean {
    return this.interactive;
  }
}

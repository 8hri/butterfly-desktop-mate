import { Vector3 } from "three";

/** Frame-rate independent smoothing factor. */
const damp = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

export interface CameraTuning {
  /** Camera offset relative to the butterfly. */
  offset: [number, number, number];
  /** Look slightly below the butterfly so it sits above centre. */
  lookAtDrop: number;
  /** How quickly the camera catches up to the butterfly. */
  follow: number;
  /** How quickly the look-at target catches up. */
  lookFollow: number;
  /** Subtle pointer-driven parallax (world units at the screen edge). */
  parallax: number;
  parallaxFollow: number;
  /**
   * Limits how far the camera may travel from its home framing, keeping the
   * composition coherent instead of chasing the butterfly across the world.
   */
  travel: [number, number, number];
  /**
   * How far the framing leans back along the flight path while a
   * user-requested destination is being flown to (a magnitude; direction
   * comes from the flight itself).
   *
   * The framing trails the destination, so the butterfly sits on the side of
   * the frame it is travelling towards and the movement reads as going there.
   * It returns to normal framing once the flight completes.
   */
  focusWeight: number;
  /**
   * Hard cap on that lean, in world units. The lean normally grows with the
   * distance to the destination, but a long flight (up to ~7.5 units across
   * the area) would otherwise push the butterfly out of the frame; capping it
   * keeps every directed flight visible while preserving the cue.
   */
  maxTrailDistance: number;
  /**
   * "follow" (default): the camera trails the butterfly, keeping it framed —
   * the web experience.
   *
   * "fixed": the camera holds its home shot and only pointer parallax moves
   * it. The butterfly's position within the frame then *is* its screen
   * position, which is what lets it travel across the whole window on the
   * transparent desktop instead of being re-centred after every flight. In
   * this mode `offset` is the absolute home position, `lookAt` is the fixed
   * aim point, and the focus lean is not applied (real travel already reads
   * as travel; the lean would shove a butterfly near the frame edge off it).
   */
  framing?: "follow" | "fixed";
  /** Fixed aim point used when `framing` is "fixed". */
  lookAt?: [number, number, number];
}

export const DEFAULT_CAMERA_TUNING: CameraTuning = {
  offset: [0.9, 1.1, 5.2],
  lookAtDrop: 0.15,
  follow: 1.8,
  lookFollow: 2.4,
  parallax: 0.35,
  parallaxFollow: 1.2,
  travel: [2.6, 1.2, 2.4],
  // Calibrated in the browser: strong enough that a directed flight visibly
  // leads the frame (horizontal shifts > 0.15 of the window), soft enough
  // that the butterfly does not reach the frame edge on far-side clicks.
  focusWeight: 0.35,
  // Less than the visible half-width (~3.1 units), so even the longest
  // possible flight keeps the butterfly inside the frame.
  maxTrailDistance: 1.1,
};

/**
 * Framing rig.
 *
 * In follow mode it keeps the butterfly comfortably framed at a stable angle;
 * in fixed mode (desktop) it holds the home shot so the butterfly's own
 * travel fills the frame. Both add a little pointer parallax for life, and
 * neither ever moves aggressively: every value is exponentially damped, so
 * motion is continuous at any frame rate.
 */
export class CameraRig {
  private readonly desired = new Vector3();
  private readonly lookTarget = new Vector3();
  private readonly smoothedLook = new Vector3();
  private readonly parallaxOffset = new Vector3();
  private readonly focusPoint = new Vector3();
  private readonly home = new Vector3();
  private lookInitialized = false;

  private readonly tuning: CameraTuning;

  constructor(tuning: CameraTuning) {
    this.tuning = tuning;
    this.home.set(...tuning.offset);
  }

  /** Smoothed world point the camera should aim at. */
  get lookPoint(): Vector3 {
    return this.smoothedLook;
  }

  /**
   * @param target   World position of the butterfly.
   * @param pointer  Normalised pointer position in [-1, 1], or null.
   * @param outPosition Receives the new camera position.
   * @param focus    Optional user-requested destination the camera leans
   *                 towards while the butterfly flies to it.
   */
  update(
    dt: number,
    target: Vector3,
    pointer: { x: number; y: number } | null,
    outPosition: Vector3,
    focus: Vector3 | null = null,
  ): Vector3 {
    const {
      follow,
      lookFollow,
      parallax,
      parallaxFollow,
      travel,
      lookAtDrop,
      focusWeight,
      maxTrailDistance,
    } = this.tuning;

    // Pointer parallax, damped so it never snaps.
    const px = pointer ? pointer.x * parallax : 0;
    const py = pointer ? pointer.y * parallax * 0.6 : 0;
    this.parallaxOffset.x += (px - this.parallaxOffset.x) * damp(parallaxFollow, dt);
    this.parallaxOffset.y += (py - this.parallaxOffset.y) * damp(parallaxFollow, dt);

    const fixed = this.tuning.framing === "fixed";

    if (fixed) {
      // Fixed framing: hold the home shot (parallax only). No travel clamp is
      // needed — the parallax offset is already bounded well inside it.
      this.desired.set(
        this.home.x + this.parallaxOffset.x,
        this.home.y + this.parallaxOffset.y,
        this.home.z,
      );
    } else {
      this.desired.copy(target).add(this.home).add(this.parallaxOffset);

      // Clamp travel around the home framing so the shot stays composed.
      this.desired.x = clamp(this.desired.x, -travel[0], travel[0]);
      this.desired.y = clamp(this.desired.y, this.home.y - travel[1], this.home.y + travel[1]);
      this.desired.z = clamp(this.desired.z, this.home.z - travel[2], this.home.z + travel[2]);
    }

    outPosition.lerp(this.desired, damp(follow, dt));

    if (fixed) {
      // The aim point is fixed as well: any rotation towards the butterfly
      // would re-centre it on screen and undo the point of holding the shot.
      const aim = this.tuning.lookAt;
      if (aim) this.lookTarget.set(aim[0], aim[1], aim[2]);
      else this.lookTarget.set(target.x, target.y - lookAtDrop, target.z);
    } else {
      // Aim a little below the butterfly so it rests above the frame centre.
      this.lookTarget.set(target.x, target.y - lookAtDrop, target.z);

      // While a user-requested destination is active, trail the framing back
      // along that flight path. The butterfly then sits on the side of the
      // frame it is travelling towards, so a directed flight visibly moves
      // toward the clicked region instead of only turning. The lean is capped,
      // because it would otherwise grow with the flight distance and push the
      // butterfly out of frame on long flights. The bias disappears as soon as
      // the flight completes, because `focus` returns to null.
      if (focus) {
        this.focusPoint.subVectors(this.lookTarget, focus);
        const distance = this.focusPoint.length();
        if (distance > 1e-5) {
          const trail = Math.min(distance * focusWeight, maxTrailDistance);
          this.lookTarget.addScaledVector(this.focusPoint, trail / distance);
        }
      }
    }

    if (!this.lookInitialized) {
      this.smoothedLook.copy(this.lookTarget);
      this.lookInitialized = true;
    } else {
      this.smoothedLook.lerp(this.lookTarget, damp(lookFollow, dt));
    }

    return outPosition;
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

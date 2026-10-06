import { Vector3 } from "three";

export type FlightMode = "idle" | "flying";

export interface FlightArea {
  min: [number, number, number];
  max: [number, number, number];
}

export interface FlightTuning {
  /** Volume the butterfly roams inside. */
  area: FlightArea;
  /** Cruising speed range (world units/second). */
  speed: [number, number];
  /** How long it hovers before choosing a new destination (seconds). */
  idleDuration: [number, number];
  /** How long it travels before settling to hover (seconds). */
  flyDuration: [number, number];
  /** Distance at which the butterfly counts as having reached its target. */
  arriveRadius: number;
  /** Steering responsiveness: higher follows the desired direction faster. */
  steering: number;
  /** How quickly heading follows the direction of travel. */
  turnRate: number;
  /** Maximum bank angle (radians) when turning. */
  maxBank: number;
  /** Extra climb speed blended in at take-off (world units/second). */
  takeOff: number;
  /** How long that take-off climb is blended in (seconds). */
  takeOffDuration: number;
  /**
   * Multiplier on speed and hover amplitude (1 = full). Lowered when the user
   * prefers reduced motion.
   */
  motionScale?: number;
}

/**
 * Clamps a point into the flight area.
 *
 * Single source of truth for the area rules: the controller and the screen
 * targeting both go through here, so a boundary can never disagree.
 */
export function clampToArea(
  point: Vector3,
  target: Vector3,
  min: Vector3,
  max: Vector3,
): Vector3 {
  target.set(
    Math.max(min.x, Math.min(max.x, point.x)),
    Math.max(min.y, Math.min(max.y, point.y)),
    Math.max(min.z, Math.min(max.z, point.z)),
  );
  return target;
}

/**
 * Behavior profile: the reaction knobs the personality layer may tune.
 *
 * These used to be literal constants embedded in the controller. They are
 * now a replaceable profile so an outside layer can decide *how intensely*
 * the butterfly reacts — while every movement mechanic below stays exactly
 * as it is. `DEFAULT_BEHAVIOR_PROFILE` is the reference behavior: with it
 * active, the controller behaves precisely as it did before profiles
 * existed (verified by `tools/test-flight.mjs`).
 */
export interface BehaviorProfile {
  /** Distance (world units) within which a presence earns attention. */
  noticeRadius: number;
  /** Distance within which a presence counts as crowding. */
  crowdRadius: number;
  /** Rate at which a hovering butterfly drifts toward a nearby presence. */
  curiosityDrift: number;
  /** Rate at which it eases away while crowded. */
  crowdPush: number;
  /** Weight of the yaw attention turn toward a nearby presence. */
  attentionYaw: number;
  /** Seconds between shy hops. */
  shyCooldown: number;
  /** Multiplier on idle rest durations. */
  restScale: number;
  /** Multiplier on autonomous hop distance. */
  hopScale: number;
  /** Multiplier on cruise speed (sampled per leg). */
  speedScale: number;
  /** Multiplier on weave amplitude (sampled per leg). */
  weaveScale: number;
  /**
   * How strongly autonomous destinations avoid the extreme reachable edge.
   *
   * A preference, not a boundary: it only makes an edge-adjacent candidate
   * less likely when the butterfly picks where to hop next. It never moves,
   * redirects or cancels anything, never applies to an explicit target, and
   * never changes the flight area — `0` means "no preference at all", which is
   * the reference behaviour.
   */
  edgeAversion: number;
  /**
   * How strongly an autonomous destination prefers to land inside the
   * foreground application window's area.
   *
   * A preference, not a boundary: it nudges a candidate that would land outside
   * the window back toward it, by a fraction that shrinks to zero as the
   * candidate approaches. The butterfly can always wander out; `0` means "no
   * preference at all", which is both the default and what happens whenever no
   * foreground window is known.
   */
  foregroundAffinity: number;
}

/**
 * An axis-aligned world-space box the autonomous chooser treats as preferable.
 *
 * Deliberately just four numbers: the flight layer never learns what a window,
 * a monitor or a pixel is — the scene shell converts a desktop-space fact into
 * this box once, and the controller only compares positions against it.
 */
export interface ForegroundBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The reference behavior: identical to the pre-personality constants. */
export const DEFAULT_BEHAVIOR_PROFILE: BehaviorProfile = {
  noticeRadius: 2.4,
  crowdRadius: 0.4,
  curiosityDrift: 0.1,
  crowdPush: 0.25,
  attentionYaw: 0.55,
  shyCooldown: 5,
  restScale: 1,
  hopScale: 1,
  speedScale: 1,
  weaveScale: 1,
  edgeAversion: 0,
  foregroundAffinity: 0,
};

/** Default behaviour tuned for the calm, unhurried feel of the experience. */
export const DEFAULT_FLIGHT_TUNING: FlightTuning = {
  /**
   * Reference flight area: the airspace solver's output for a 420/320
   * viewport (`flightAreaForAspect(420/320)` in `lib/airspace.ts`, asserted
   * by `tools/test-airspace.mjs`). It is the initial value everywhere and
   * the value the web build keeps; the desktop overlay re-solves its area
   * for the real work-area aspect at runtime (`FlightController.setArea`).
   *
   * The bounds are chosen so every corner projects inside the frame for the
   * shipped camera pose (worst-case ≈ 0.78 of the half-frame, leaving room
   * for the wingspan and pointer parallax). The z-band is deliberately
   * shallow: a thin slab keeps the perspective scale nearly constant across
   * the box, which is what lets one box both stay in frame and reach most
   * of the surface.
   *
   *   x: -2.05 … 1.93   (asymmetric — the camera axis leans left with depth)
   *   y:  0.60 … 2.75   (altitude band; height 2.15 keeps click→altitude
   *                       calibration in `test-targeting.mjs` valid)
   *   z: -0.50 … 0.50   (shallow depth slab)
   */
  area: { min: [-2.05, 0.6, -0.5], max: [1.93, 2.75, 0.5] },
  speed: [0.6, 1.05],
  idleDuration: [1.8, 4.4],
  flyDuration: [4, 9],
  arriveRadius: 0.28,
  steering: 1.6,
  turnRate: 2.4,
  maxBank: 0.45,
  takeOff: 0.5,
  takeOffDuration: 0.9,
};

/** Frame-rate independent smoothing factor. */
const damp = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

/**
 * Minimum length of a wander leg, in world units. Legs shorter than this
 * are stubs — rejected. Short hops (0.7–2.2) are intentional creature
 * behaviour; only leg-length *monotony* reads as artificial.
 */
const MIN_LEG = 0.6;

/**
 * How much of an overshoot past the reachable boundary is drawn back inward,
 * per unit of the profile's `edgeAversion` (capped at the profile's full
 * strength). At the strongest personality value (0.3) that is 15% of the
 * overshoot: a clear preference against slamming into the edge of the
 * reachable volume, far from a wall the butterfly cannot cross.
 */
const EDGE_SOFTNESS = 0.5;

/**
 * How much of the distance between a candidate and the foreground window is
 * recovered per unit of `foregroundAffinity` (capped at the profile's full
 * strength). At the strongest value a candidate is moved about a quarter of the
 * way back — enough to be felt as a preference over many hops, far too little to
 * act as a wall.
 */
const FOREGROUND_PULL = 0.45;

/** Shortest-path angular interpolation. */
function dampAngle(current: number, target: number, lambda: number, dt: number) {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * damp(lambda, dt);
}

const rand = (rng: () => number, range: [number, number]) =>
  range[0] + rng() * (range[1] - range[0]);

/** World up, used when weaving the flight direction sideways. */
const UP = new Vector3(0, 1, 0);

/**
 * Organic flight behaviour for the butterfly.
 *
 * Owns position, heading and mode only — it never touches the GLB. The
 * component applies `position` / `euler` / `mode` to the actor group, which
 * keeps the model a replaceable asset.
 *
 * The controller is a small state machine with a continuous physical state
 * (position, velocity, momentum, per-leg seeds), driven by three ranked
 * influences:
 *
 *   1. explicit targets — `seekTo` (a click) and `aimAt` (web live cursor);
 *   2. presence reactions — `notice` (desktop cursor): gentle attention when
 *      it is near, a shy hop away when it crowds;
 *   3. autonomous life — local hops with an irregular resting rhythm.
 *
 *   IDLE_HOVER     layered-bob hovering; arrival momentum glides out through
 *                  the anchor; awareness drifts toward what is near.
 *      |           explicit target, shy hop, or the resting rhythm ending
 *   TARGET_ACQUIRED: destination set, take-off lift, cruise and leg seeds.
 *      v
 *   FLYING         steering along a weaving curve with a fluttering pace; a
 *                  moving live target re-aims every frame.
 *      |           distance below arriveRadius
 *   ARRIVING       braking eases the speed out; the weave carries it slightly
 *      |           past — a soft landing, never a timed stop.
 *      v
 *   IDLE_HOVER     settles, then notices, rests, and hops again.
 *
 * Autonomous hops are deliberately local (mostly 0.7–2.2 units, biased a
 * little forward), so the butterfly reads as a creature pottering around its
 * patch, not a sprite crossing the whole screen. Lower-priority influences
 * never fight higher ones: presence never redirects a directed flight, and
 * the idle rhythm never fires while a target is active.
 */
export class FlightController {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly euler = { x: 0, y: 0, z: 0 };

  mode: FlightMode = "flying";

  /** Optional destination that overrides wandering (set by interaction). */
  private readonly overrideTarget = new Vector3();
  private hasOverride = false;

  /**
   * The user's live pointer target, in world space (set by `aimAt`). While it
   * is set it owns the flight: an idle butterfly is drawn to it, and a flying
   * one re-aims at it every frame — so moving the mouse redirects an
   * in-progress trajectory smoothly instead of waiting for it to finish.
   */
  private readonly liveTarget = new Vector3();
  private hasLive = false;

  private readonly destination = new Vector3();
  private readonly anchor = new Vector3();
  private readonly desired = new Vector3();
  private readonly toTarget = new Vector3();
  private readonly areaMin = new Vector3();
  private readonly areaMax = new Vector3();
  private readonly scratch = new Vector3();

  /**
   * The cursor as an environmental *presence* (set by `notice`): awareness,
   * not a target. The butterfly may watch it, drift a little toward it, or
   * shy away when it gets crowded — it never chases it.
   */
  private readonly presence = new Vector3();
  private hasPresence = false;
  /** Phase-time before which the shy hop may not fire again (cooldown). */
  private hopCooldownUntil = -1;
  /** Grace after a directed arrival, during which the shy hop stays off. */
  private noHopUntil = -1;

  private timer = 0;
  private phase = 0;
  private speed = 0;
  private bank = 0;

  /** Values sampled once per leg of flight, not per frame, to avoid jitter. */
  /**
   * Cruise speed as *sampled* (before the profile's speedScale). Kept unscaled
   * so a state change applies to the leg in progress instead of waiting for
   * the next one.
   */
  private cruiseBase = 0;
  private flyUntil = 0;
  private idleUntil = 0;
  /** Remaining take-off climb, blended in over time rather than impulsed. */
  private lift = 0;
  /** Per-leg variation: weave alignment and amplitude, sampled once per leg. */
  private legSeed = 0;
  /** Weave amplitude as sampled; the profile's weaveScale is applied per frame. */
  private weaveBase = 1;

  private readonly tuning: FlightTuning;
  private readonly rng: () => number;
  /** Speed and hover amplitude multiplier (accessibility). */
  private readonly motion: number;
  /**
   * Active behavior profile (see `BehaviorProfile`). Defaults to the
   * reference behavior; the personality layer replaces it via
   * `setBehaviorProfile`. Read-only for the controller — it never mutates it.
   */
  private behavior: BehaviorProfile = { ...DEFAULT_BEHAVIOR_PROFILE };
  /**
   * Where the foreground application window is, in world space — or `null` when
   * that is unknown. It is a *preference region*, never a target or a limit:
   * see `drawTowardForeground`.
   */
  private foregroundBounds: ForegroundBounds | null = null;

  /**
   * While true, the autonomous wander rhythm never fires and shy hops are
   * suppressed (Phase 16, mini-game foundation).
   *
   * This is a *suspension*, not a mode and not a personality value: the
   * controller keeps every influence that belongs to the companion (explicit
   * targets, presence awareness, hover life, arrivals, landing rests), and
   * only the two things a hosted activity cannot live with are held — the idle
   * rhythm's next take-off, and the shy hop that would yank the butterfly out
   * of a game. Default false: with nothing hosting, the pre-Phase-16 behaviour
   * is bit-for-bit what it was (asserted by `tools/test-flight.mjs`).
   */
  private autonomySuppressed = false;

  constructor(tuning: FlightTuning, start: Vector3, rng: () => number = Math.random) {
    this.tuning = tuning;
    this.rng = rng;
    this.motion = tuning.motionScale ?? 1;
    this.areaMin.set(...tuning.area.min);
    this.areaMax.set(...tuning.area.max);
    this.position.copy(start);
    this.anchor.copy(start);
    this.cruiseBase = rand(this.rng, tuning.speed);
    this.flyUntil = rand(this.rng, tuning.flyDuration);
    this.idleUntil = this.sampleIdleDuration();
    this.sampleLeg();
    this.pickDestination();
  }

  /**
   * Per-leg variation, sampled once per leg — never per frame. The weave's
   * alignment and amplitude shift from leg to leg so no two flights share
   * the exact same wobble.
   */
  private sampleLeg() {
    this.legSeed = this.rng() * 20;
    this.weaveBase = 0.85 + this.rng() * 0.35;
  }

  /**
   * The resting rhythm: mostly ordinary pauses, sometimes a quick stop that
   * chains into another hop (active spells), sometimes a long still rest.
   * The profile's restScale stretches or compresses the whole rhythm.
   */
  private sampleIdleDuration() {
    const r = this.rng();
    if (r < 0.15) return rand(this.rng, [0.45, 0.9]) * this.behavior.restScale;
    if (r < 0.3) return rand(this.rng, [6, 10]) * this.behavior.restScale;
    return rand(this.rng, this.tuning.idleDuration) * this.behavior.restScale;
  }

  /**
   * The destination the user asked for, or null while the butterfly is
   * wandering on its own. Exposed read-only for the camera, which uses it to
   * lead the framing towards a directed flight.
   */
  get userTarget(): Vector3 | null {
    return this.hasOverride ? this.overrideTarget : null;
  }

  /**
   * The current flight volume. May differ from the tuning's initial value
   * after `setArea`, so anything mapping into the area (e.g. screen
   * targeting) should read it from here, never from the config.
   */
  get area(): FlightArea {
    return {
      min: [this.areaMin.x, this.areaMin.y, this.areaMin.z],
      max: [this.areaMax.x, this.areaMax.y, this.areaMax.z],
    };
  }

  /**
   * Re-binds the flight volume at runtime. The desktop overlay derives its
   * airspace from the real work-area aspect once the native geometry is
   * known (`lib/airspace.ts`); everything currently in flight is simply
   * clamped into the new volume, so nothing teleports or escapes.
   */
  setArea(area: FlightArea) {
    this.areaMin.set(...area.min);
    this.areaMax.set(...area.max);
    clampToArea(this.position, this.position, this.areaMin, this.areaMax);
    clampToArea(this.anchor, this.anchor, this.areaMin, this.areaMax);
  }

  /**
   * Whether the autonomous wander rhythm is currently suspended (Phase 16).
   * Read-only; the hosting layer sets it through `setAutonomySuppressed`.
   */
  get isAutonomySuppressed(): boolean {
    return this.autonomySuppressed;
  }

  /**
   * Suspends or restores the autonomous wander rhythm for a hosted activity
   * (Phase 16, mini-game foundation).
   *
   * This is the smallest possible seam: nothing about position, velocity,
   * destinations, presence, the live target or an explicit target changes.
   * While suppressed the butterfly simply stops *choosing* to wander or to
   * shy-hop — it hovers, notices, answers explicit targets and lands exactly as
   * before. On release the resting rhythm is re-armed from *now* (rather than
   * firing instantly, which a long suppression would otherwise cause), so the
   * companion resumes its own life at an ordinary pace.
   */
  setAutonomySuppressed(suppressed: boolean) {
    if (suppressed === this.autonomySuppressed) return;
    this.autonomySuppressed = suppressed;
    if (!suppressed && this.mode === "idle") {
      // Re-arm the rest deadline relative to now; `timer` may have run far
      // past the old one while the rhythm was suspended.
      this.idleUntil = this.timer + rand(this.rng, this.tuning.idleDuration) * this.behavior.restScale;
    }
  }

  /**
   * Replaces the active behavior profile (called by the personality layer,
   * potentially every frame). The profile is treated as read-only.
   */
  setBehaviorProfile(profile: BehaviorProfile) {
    const previous = this.behavior;
    this.behavior = profile;

    // The resting rhythm is sampled as an absolute deadline, so without this
    // a state change would stay invisible until the *next* rest — up to ten
    // seconds of apparently unchanged behavior. Rescaling what is left of the
    // current rhythm makes the new state legible immediately, without
    // commanding any movement: only the remaining time changes, never the
    // position, velocity or destination.
    const ratio = profile.restScale / previous.restScale;
    if (ratio !== 1) {
      const deadline = this.mode === "idle" ? this.idleUntil : this.flyUntil;
      const remaining = Math.max(0, deadline - this.timer);
      const scaled = this.timer + remaining * ratio;
      if (this.mode === "idle") this.idleUntil = scaled;
      else if (!this.hasOverride) this.flyUntil = scaled;
    }
  }

  /** The active profile (read-only; used by tests and the personality layer). */
  get behaviorProfile(): Readonly<BehaviorProfile> {
    return this.behavior;
  }

  /**
   * Where the current leg is heading (read-only). An autonomous leg's target,
   * or the directed target while the user owns the flight.
   */
  get target(): Vector3 {
    return this.hasOverride ? this.overrideTarget : this.destination;
  }

  /**
   * Publishes (or withdraws) the foreground window's world-space box.
   *
   * Only ever consulted when choosing an autonomous destination, and only ever
   * as a preference. Passing `null` — which is what happens when the window
   * closes, focus moves away, or no desktop information exists at all — restores
   * exactly the previous behaviour, immediately and without a stale target
   * lingering.
   */
  setForegroundBounds(bounds: ForegroundBounds | null) {
    this.foregroundBounds = bounds;
  }

  /**
   * Sets the live pointer target (continuous mouse tracking). While the
   * pointer stays inside the window this is where the butterfly wants to be:
   * it flies there along a curved path, keeps re-aiming as the pointer moves,
   * and settles into a hover once it is close. Pass null when the pointer
   * leaves — the butterfly then resumes free wandering.
   */
  aimAt(point: Vector3 | null) {
    if (!point) {
      this.hasLive = false;
      return;
    }
    clampToArea(point, this.liveTarget, this.areaMin, this.areaMax);
    this.hasLive = true;
  }

  /**
   * Environmental awareness: the cursor's position as a *presence*, not a
   * target (desktop mode). The butterfly may watch it, drift a little
   * toward it, or shy away from it when it gets crowded — but it never
   * chases it, and an explicit target always outranks the reaction.
   * Pass null when the cursor should no longer be felt.
   */
  notice(point: Vector3 | null) {
    if (!point) {
      this.hasPresence = false;
      return;
    }
    clampToArea(point, this.presence, this.areaMin, this.areaMax);
    this.hasPresence = true;
  }

  /**
   * Requests a specific destination (used when the user attracts or summons
   * the butterfly). The butterfly flies there, then resumes wandering.
   *
   * Returns false when the request resolves to where the butterfly already
   * is, so a click on the spot it occupies does not trigger a pointless
   * take-off.
   */
  seekTo(point: Vector3): boolean {
    clampToArea(point, this.overrideTarget, this.areaMin, this.areaMax);
    if (this.overrideTarget.distanceTo(this.position) < this.tuning.arriveRadius) {
      return false;
    }
    this.hasOverride = true;
    this.mode = "flying";
    this.timer = 0;
    this.cruiseBase = rand(this.rng, this.tuning.speed);
    this.flyUntil = Infinity;
    this.sampleLeg();
    return true;
  }

  /** Advances the simulation. Returns the current mode. */
  step(dt: number): FlightMode {
    this.timer += dt;
    this.phase += dt;

    // TARGET_ACQUIRED: the live pointer target may start or re-aim a flight
    // before anything else runs, so engagement happens first every frame.
    this.trackLiveTarget();

    if (this.mode === "flying") this.fly(dt);
    else this.hover(dt);

    this.integrate(dt);
    return this.mode;
  }

  /**
   * Applies the live pointer target (see `aimAt`).
   *
   * - During an override flight the target is copied every frame: a moving
   *   pointer smoothly intercepts the current trajectory (no waiting for a
   *   leg to finish, no path pre-computation).
   * - From idle — or from a wandering leg — flight only engages when the
   *   pointer is farther than the engage radius. The gap between this radius
   *   and `arriveRadius` is deliberate hysteresis: close pointer jitter can
   *   never flicker between flying and hovering.
   */
  private trackLiveTarget() {
    if (!this.hasLive) return;

    if (this.hasOverride && this.mode === "flying") {
      this.overrideTarget.copy(this.liveTarget);
      return;
    }

    const engage = this.tuning.arriveRadius * 2.5;
    if (this.liveTarget.distanceTo(this.position) <= engage) return;

    this.overrideTarget.copy(this.liveTarget);
    this.hasOverride = true;
    this.flyUntil = Infinity;
    if (this.mode === "idle") {
      this.mode = "flying";
      this.timer = 0;
      this.lift = this.tuning.takeOffDuration;
      this.cruiseBase = rand(this.rng, this.tuning.speed);
      this.sampleLeg();
    }
  }

  private fly(dt: number) {
    const { arriveRadius } = this.tuning;
    const target = this.hasOverride ? this.overrideTarget : this.destination;

    this.toTarget.copy(target).sub(this.position);
    const distance = this.toTarget.length();

    if (distance < arriveRadius) {
      // ARRIVING completes: velocity still carries a little (the weave pushes
      // it slightly past), and hover damps it out — a soft landing, never an
      // abrupt stop at a fixed time.
      this.settle();
    } else {
      // Ease the cruise speed out near the destination for a soft landing.
      const braking = Math.min(1, distance / (arriveRadius * 4));

      // Organic weave: perturb the seek direction sideways with layered,
      // incommensurate sines so every leg curves the way real flight does —
      // never a straight Cartesian A→B slide. Because the sway is a function
      // of time layered onto the *current* target direction (not a path baked
      // in advance), a moving pointer target bends the trajectory
      // continuously instead of waiting for a leg to finish. Each leg gets
      // its own seed, so no two flights share the exact same wobble.
      const dir = this.toTarget.normalize();
      const right = this.scratch.crossVectors(dir, UP);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
      else right.normalize();
      const t = this.phase + this.legSeed;
      const m = this.motion;
      const w = this.weaveBase * this.behavior.weaveScale;
      const sway = (Math.sin(t * 1.3) * 0.34 + Math.sin(t * 0.61 + 2.1) * 0.16) * m * w;
      const heave = Math.sin(t * 0.9 + 1.2) * 0.18 * m * w;
      // The cruise speed itself breathes: butterflies never hold a perfectly
      // constant pace. Slow, bounded flutter — never a stall.
      const flutter =
        1 +
        (Math.sin(this.phase * 0.47 + this.legSeed * 1.7) * 0.12 +
          Math.sin(this.phase * 1.13 + this.legSeed) * 0.06) *
          m;
      this.desired
        .copy(dir)
        .addScaledVector(right, sway)
        .addScaledVector(UP, heave)
        .normalize()
        .multiplyScalar(
          this.cruiseBase * this.motion * this.behavior.speedScale * flutter *
            (0.45 + 0.55 * braking),
        );

      // Take-off pulls upward, fading out — no instant velocity jump.
      if (this.lift > 0) {
        const remaining = this.lift / this.tuning.takeOffDuration;
        this.desired.y += this.tuning.takeOff * remaining * this.motion;
        this.lift = Math.max(0, this.lift - dt);
      }

      // Exponential steering keeps velocity continuous: a retarget only
      // bends the curve, it can never teleport or stall the motion.
      const k = damp(this.tuning.steering, dt);
      this.velocity.lerp(this.desired, k);
    }

    // A wandering leg ends on its own rhythm (so it never loops mechanically);
    // an override flight has flyUntil = Infinity and only settles on arrival.
    if (!this.hasOverride && this.timer > this.flyUntil) this.settle();
  }

  private hover(dt: number) {
    this.desired.set(0, 0, 0);
    this.velocity.lerp(this.desired, damp(this.tuning.steering * 0.6, dt));

    // Arrival momentum glides out through the anchor instead of vanishing:
    // the residual velocity drains over about a second, so landing reads as
    // decelerate-then-rest, never cruise-then-freeze.
    this.anchor.addScaledVector(this.velocity, dt);

    // Layered sines give an irregular, breathing hover instead of a loop.
    // The frequencies matter as much as the amplitude: the follow camera
    // damps slow motion away, and the transparent desktop has no background
    // to give motion away — so the idle bob runs faster than the camera can
    // absorb, which is what keeps a resting butterfly visibly alive.
    const t = this.phase;
    const m = this.motion;
    this.anchor.x += (Math.sin(t * 0.9) * 0.2 + Math.sin(t * 0.37) * 0.12) * m * dt;
    this.anchor.y += Math.sin(t * 1.45 + 1.3) * 0.16 * m * dt;
    this.anchor.z += (Math.cos(t * 0.8 + 0.6) * 0.17 + Math.sin(t * 0.31) * 0.1) * m * dt;

    // Awareness: while hovering, drift gently toward a close pointer target.
    // (`trackLiveTarget` has already engaged any pointer farther than the
    // engage radius, so whatever is left here is a nearby resting spot.)
    if (this.hasLive) {
      this.anchor.lerp(this.liveTarget, damp(0.28, dt));
    } else if (this.hasPresence && !this.hasOverride) {
      // Presence reactions — awareness, never a chase (and never while a
      // directed flight owns the motion). Radii and rates come from the
      // active behavior profile.
      const d = this.presence.distanceTo(this.position);
      if (d > this.behavior.crowdRadius && d < this.behavior.noticeRadius) {
        // Curiosity: drift very gently toward the nearby presence.
        this.anchor.lerp(this.presence, damp(this.behavior.curiosityDrift * m, dt));
      } else if (d <= this.behavior.crowdRadius && d > 1e-4 && this.phase > this.noHopUntil) {
        // Crowded: ease away a little even between hops — but not right after
        // a directed arrival (it only just got where it was asked to be).
        this.scratch.copy(this.position).sub(this.presence).normalize();
        this.anchor.addScaledVector(this.scratch, this.behavior.crowdPush * m * dt);
      }
    }

    // The anchor is the hover's source of truth, so it always stays inside
    // the volume — including while residual momentum glides out at a wall.
    clampToArea(this.anchor, this.anchor, this.areaMin, this.areaMax);
    this.position.copy(this.anchor);
    clampToArea(this.position, this.position, this.areaMin, this.areaMax);

    // The shy hop: a cursor right on top of the butterfly nudges it into a
    // short flight away — bounded by a cooldown, and suppressed for a few
    // seconds after a directed arrival (it only just got where it was asked).
    // Suspended outright while a hosted activity owns movement (Phase 16).
    if (
      !this.autonomySuppressed &&
      this.hasPresence &&
      !this.hasOverride &&
      this.phase > this.hopCooldownUntil &&
      this.phase > this.noHopUntil
    ) {
      if (this.presence.distanceTo(this.position) < this.behavior.crowdRadius) {
        this.hopCooldownUntil = this.phase + this.behavior.shyCooldown;
        this.hopAway();
        return;
      }
    }

    // The resting rhythm: suspended while a hosted activity owns movement
    // (Phase 16). Explicit targets and presence awareness are untouched.
    if (!this.autonomySuppressed && this.timer > this.idleUntil) this.takeOff();
  }

  private settle() {
    const wasOverride = this.hasOverride;
    this.mode = "idle";
    this.timer = 0;
    this.anchor.copy(this.position);
    this.hasOverride = false;
    // A directed arrival earns a proper rest where it was asked to be — and
    // a grace without shy reactions — before its own rhythm resumes.
    this.idleUntil = wasOverride
      ? rand(this.rng, [6, 10]) * this.behavior.restScale
      : this.sampleIdleDuration();
    if (wasOverride) this.noHopUntil = this.phase + 6;
  }

  private takeOff(destination?: Vector3) {
    this.mode = "flying";
    this.timer = 0;
    this.lift = this.tuning.takeOffDuration;
    this.cruiseBase = rand(this.rng, this.tuning.speed);
    this.flyUntil = rand(this.rng, this.tuning.flyDuration);
    this.sampleLeg();
    if (destination) this.destination.copy(destination);
    else this.pickDestination();
  }

  /**
   * A short, gentle flight away from a crowding presence — a shy reaction,
   * not a panic: one hop of about a body-length or two, slightly upward.
   */
  private hopAway() {
    const d = this.presence.distanceTo(this.position);
    const away = this.scratch.copy(this.position).sub(this.presence);
    if (d > 1e-4) away.normalize();
    else away.set(Math.sin(this.rng() * 6.28), 0, Math.cos(this.rng() * 6.28));
    this.destination
      .copy(this.position)
      .addScaledVector(away, rand(this.rng, [1.0, 1.8]) * this.behavior.hopScale);
    this.destination.x += (this.rng() - 0.5) * 0.8;
    this.destination.y += rand(this.rng, [0.05, 0.35]);
    this.destination.z += (this.rng() - 0.5) * 0.8;
    clampToArea(this.destination, this.destination, this.areaMin, this.areaMax);
    this.takeOff(this.destination);
  }

  /**
   * Eases a candidate that landed outside the foreground window back toward it.
   *
   * Only the axes that are actually outside are touched, and only by `pull` of
   * the distance to that edge — so the pull vanishes as the candidate nears the
   * window, a candidate already inside is untouched, and the door out always
   * stays open in both directions: nothing here clamps, and a later leg can
   * equally pull the butterfly back out.
   */
  private drawTowardForeground(pull: number) {
    const bounds = this.foregroundBounds;
    if (!bounds) return;
    const { minX, maxX, minY, maxY } = bounds;
    const x = this.destination.x;
    const y = this.destination.y;
    if (x < minX) this.destination.x = x + (minX - x) * pull;
    else if (x > maxX) this.destination.x = x - (x - maxX) * pull;
    if (y < minY) this.destination.y = y + (minY - y) * pull;
    else if (y > maxY) this.destination.y = y - (y - maxY) * pull;
  }

  private pickDestination() {
    // Local, creature-like hopping: mostly short legs nearby, sometimes a
    // medium excursion, rarely a longer cross-area flight. Direction leans a
    // little forward so the butterfly tends to keep going rather than
    // ping-ponging, and vertical changes stay gentle. Whole-area coverage
    // emerges from chains of hops; it no longer needs uniform sampling.
    const forward = this.scratch.set(Math.sin(this.euler.y), 0, Math.cos(this.euler.y));
    // Environmental preference (Phase 13): a candidate that overshoots the
    // reachable volume is drawn back inward by a fraction of the overshoot, so
    // "pressed against the wall" becomes a less likely place to stop. It is a
    // bias, not a boundary — the area clamp below is still the hard limit, no
    // extra randomness is drawn, the leg bands and cadence are untouched, and a
    // candidate that already lands inside the volume is left exactly as drawn.
    // With `edgeAversion = 0` this is skipped entirely, so the reference
    // behaviour is bit-for-bit unchanged.
    const aversion = this.behavior.edgeAversion;
    const softness = aversion > 0 ? EDGE_SOFTNESS * Math.min(1, aversion) : 0;
    // Foreground-window preference (Phase 13B.2): with a known window, an
    // overshooting candidate is eased back toward it — the same shape of nudge
    // as the edge preference, in the opposite direction, and bounded the same
    // way. Two independent pulls, each a fraction of the distance involved, so
    // they can favour an interior region but can never trap the butterfly.
    const affinity = this.behavior.foregroundAffinity;
    const pull = affinity > 0 && this.foregroundBounds ? FOREGROUND_PULL * Math.min(1, affinity) : 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = this.rng();
      const leg =
        (r < 0.7
          ? rand(this.rng, [0.7, 2.2])
          : r < 0.95
            ? rand(this.rng, [2.2, 4.2])
            : rand(this.rng, [4.2, 7])) * this.behavior.hopScale;
      const angle = this.rng() * Math.PI * 2;
      const x = this.position.x + (Math.sin(angle) + forward.x * 0.45) * leg;
      const y = this.position.y + rand(this.rng, [-0.55, 0.55]);
      this.destination.set(
        x,
        y,
        this.position.z + (Math.cos(angle) + forward.z * 0.45) * leg,
      );
      clampToArea(this.destination, this.destination, this.areaMin, this.areaMax);
      // Applied after the clamp, so the pull actually lands inside the volume
      // instead of being clamped straight back onto the boundary.
      if (softness > 0) this.softenAgainstEdge(x, y, softness);
      if (pull > 0) this.drawTowardForeground(pull);
      // Reject stubs, but allow short hops: they are the point of local life.
      if (this.destination.distanceTo(this.position) >= MIN_LEG) break;
    }
  }

  /**
   * Draws an overreaching candidate back toward the interior, in proportion to
   * how far past the reachable boundary it reached.
   *
   * The edge metric is the overshoot itself — distance beyond the nearest
   * reachable bound — measured on the two axes that map to screen position (x
   * across, y up); depth (z) is not a screen edge. The overshoot is capped at
   * one volume span so a long leg aimed at a wall can never turn into a wild
   * pull, and only the clamped axes are touched, so the third axis keeps the
   * value it was drawn with.
   */
  private softenAgainstEdge(x: number, y: number, softness: number) {
    const spanX = this.areaMax.x - this.areaMin.x;
    const spanY = this.areaMax.y - this.areaMin.y;
    const overX = Math.min(
      spanX,
      Math.max(0, this.areaMin.x - x) + Math.max(0, x - this.areaMax.x),
    );
    const overY = Math.min(
      spanY,
      Math.max(0, this.areaMin.y - y) + Math.max(0, y - this.areaMax.y),
    );
    if (overX > 0) {
      this.destination.x += (x > this.areaMax.x ? -overX : overX) * softness;
    }
    if (overY > 0) {
      this.destination.y += (y > this.areaMax.y ? -overY : overY) * softness;
    }
  }

  private integrate(dt: number) {
    const { maxBank, turnRate } = this.tuning;

    // Keep the flight volume soft: ease back inside when drifting out.
    const overshoot = new Vector3();
    if (this.position.x < this.areaMin.x) overshoot.x = this.areaMin.x - this.position.x;
    if (this.position.x > this.areaMax.x) overshoot.x = this.areaMax.x - this.position.x;
    if (this.position.y < this.areaMin.y) overshoot.y = this.areaMin.y - this.position.y;
    if (this.position.y > this.areaMax.y) overshoot.y = this.areaMax.y - this.position.y;
    if (this.position.z < this.areaMin.z) overshoot.z = this.areaMin.z - this.position.z;
    if (this.position.z > this.areaMax.z) overshoot.z = this.areaMax.z - this.position.z;
    if (overshoot.lengthSq() > 0) {
      this.velocity.addScaledVector(overshoot.normalize(), 2.2 * dt);
      clampToArea(this.position, this.position, this.areaMin, this.areaMax);
    }

    this.position.addScaledVector(this.velocity, dt);
    this.speed = this.velocity.length();

    // Heading follows travel direction; a resting butterfly sways gently.
    const previousYaw = this.euler.y;
    let targetYaw: number;
    if (this.speed > 0.02) {
      targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
    } else {
      targetYaw = this.euler.y + Math.sin(this.phase * 0.5) * 0.12 * dt * 6;
    }
    // Attention: a nearby presence earns a gentle turn of the head, fading
    // in as the butterfly comes to rest (velocity always rules real motion).
    if (this.hasPresence && !this.hasOverride && this.speed < 0.15) {
      const d = this.presence.distanceTo(this.position);
      if (d > 0.15 && d < this.behavior.noticeRadius) {
        const faceYaw = Math.atan2(
          this.presence.x - this.position.x,
          this.presence.z - this.position.z,
        );
        let diff = faceYaw - targetYaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        targetYaw += diff * this.behavior.attentionYaw * (1 - this.speed / 0.15);
      }
    }
    this.euler.y = dampAngle(this.euler.y, targetYaw, turnRate, dt);

    // Bank into turns, following the yaw rate.
    const bankLimit = maxBank * this.motion;
    const yawRate = dt > 0 ? (this.euler.y - previousYaw) / dt : 0;
    const targetBank = Math.max(-bankLimit, Math.min(bankLimit, -yawRate * 0.35));
    this.bank += (targetBank - this.bank) * damp(3, dt);

    // Nose follows vertical motion slightly; nose-down when descending.
    const targetPitch = Math.max(
      -0.25,
      Math.min(0.25, this.velocity.y * 0.5),
    );
    this.euler.x += (targetPitch - this.euler.x) * damp(2.5, dt);

    // A small bank also reads as flapping effort while hovering.
    this.euler.z = this.mode === "idle" ? this.bank + Math.sin(this.phase * 1.6) * 0.05 : this.bank;
  }
}

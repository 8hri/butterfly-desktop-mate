import { Vector3 } from "three";
import type { FlightArea } from "./flight";
import type { MiniGameContext, MiniGameDefinition, WorldPoint } from "./minigame";

/**
 * Butterfly Chase (Phase 16.1) — the first mini-game, and deliberately the
 * smallest one that can be fun.
 *
 * While it runs, short-lived glowing targets appear one at a time around the
 * garden. The butterfly is sent after each target; the player clicks the
 * target before it disappears. Each click that lands is a point. After thirty
 * seconds the game completes and reports the score.
 *
 * What it is NOT: a system. There is no level, no streak, no reward, no
 * progression, no persistent score, no second game. It exists to prove the
 * Phase 16 foundation can host something small and real without contaminating
 * anything.
 *
 * Design notes:
 *
 * - **One target at a time.** The butterfly chases a single target, so the
 *   garden reads as *the butterfly hunting*, not as a shooting range with the
 *   butterfly flying randomly past.
 * - **Deterministic spawns.** The target stream is drawn from a seeded RNG
 *   seeded from the garden's own seed (plus a game offset), so the same garden
 *   offers the same sequence of targets on every launch. No `Math.random()`.
 * - **Inside the flight volume.** Targets spawn inside the flight area, so the
 *   butterfly can always reach them, and they keep a respectful distance from
 *   the flowers, stones and log — a target parked on a blossom would be
 *   visually and interactively confusing.
 * - **Nothing persists.** Score lives on the definition object for the HUD to
 *   read, and dies with the game. Memory is never touched.
 */

/** The chase tuning this module needs (structurally: `SCENE.garden.chase`). */
export interface ButterflyChaseTuning {
  durationSeconds: number;
  targetLifetimeSeconds: number;
  spawnDistance: readonly [number, number];
  spawnGapSeconds: number;
  hitRadius: number;
  catchRadius: number;
  minLandmarkDistance: number;
  targetRadius: number;
  expiringSeconds: number;
  color: string;
}

/** One live target. `position` is inside the flight area by construction. */
export interface ChaseTarget {
  position: WorldPoint;
  /** Game-elapsed time at which the target appeared. */
  spawnedAt: number;
  /** Game-elapsed time at which the target vanishes. */
  expiresAt: number;
}

/** The definition's public surface beyond the lifecycle hooks (for HUD/tests). */
export interface ButterflyChaseGame extends MiniGameDefinition {
  readonly score: number;
  readonly hits: number;
  readonly misses: number;
  readonly target: ChaseTarget | null;
  /**
   * Whether the live target is catchable *right now*: the butterfly has
   * actually arrived at it (within `catchRadius`). Recomputed every tick from
   * the flight controller's real position, so it can never disagree with what
   * is on screen.
   */
  readonly catchable: boolean;
  /** Seconds left in the game, clamped at zero. */
  readonly remainingSeconds: number;
  /** Subscribe to score/target/timer changes (for the HUD). */
  onChange(listener: () => void): () => void;
}

/** Deterministic PRNG — same algorithm the project's test suites use. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The offset that separates the chase's stream from the garden's own layout. */
const CHASE_SEED_OFFSET = 0x9e37;

export function createButterflyChase(options: {
  seed: number;
  area: FlightArea;
  /** Landmark [x, z] points targets must keep clear of (flowers, stones, log). */
  landmarks: ReadonlyArray<readonly [number, number]>;
  tuning: ButterflyChaseTuning;
}): ButterflyChaseGame {
  const { seed, area, landmarks, tuning } = options;
  const rand = mulberry32((seed ^ CHASE_SEED_OFFSET) | 0);

  let score = 0;
  let hits = 0;
  let misses = 0;
  let target: ChaseTarget | null = null;
  /**
   * The previous target's position — the anchor the next spawn is drawn
   * around. Anchoring on the *target* (not on the butterfly's live position)
   * is what makes the stream fully deterministic from the seed: the butterfly
   * was just chasing that target, so reachability is the same either way, but
   * the draw never depends on flight noise. `null` until the first spawn,
   * which anchors on the butterfly's position at game start.
   */
  let lastSpawn: WorldPoint | null = null;
  /**
   * Whether the butterfly is currently within `catchRadius` of the live
   * target — the single gate on hits. Recomputed every tick from the flight
   * controller's actual position.
   */
  let catchable = false;
  /** Elapsed time when the next target may appear (after a gap). */
  let nextSpawnAt = 0;
  /** Seconds left, recomputed each tick; the HUD reads this field. */
  let remaining = tuning.durationSeconds;
  let lastNotifiedSecond = -1;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Draws the next target position: within `spawnDistance` of the anchor (the
   * previous target, or the butterfly at game start — both are points the
   * butterfly can reach within the measured arrival curve the lifetime is
   * sized against), still inside the flight area, and never on top of a
   * landmark. Bounded attempts; the deterministic fallback accepts the band
   * even if a landmark is close.
   */
  const drawPosition = (anchor: WorldPoint): WorldPoint => {
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = rand() * Math.PI * 2;
      const distance =
        tuning.spawnDistance[0] + rand() * (tuning.spawnDistance[1] - tuning.spawnDistance[0]);
      const x = anchor[0] + Math.cos(angle) * distance;
      // The lower two thirds of the altitude band: targets read as hovering
      // over the clearing, not pressed against the flight ceiling.
      const y = area.min[1] + rand() * (area.max[1] - area.min[1]) * 0.66;
      const z = anchor[2] + Math.sin(angle) * distance;
      if (x < area.min[0] || x > area.max[0] || z < area.min[2] || z > area.max[2]) continue;
      const clear = landmarks.every(
        ([lx, lz]) => Math.hypot(x - lx, z - lz) >= tuning.minLandmarkDistance,
      );
      if (clear) return [x, y, z];
    }
    // Deterministic fallback: any point in the area. Reached only when the
    // butterfly is pressed against a wall and the whole band is unusable.
    const x = area.min[0] + rand() * (area.max[0] - area.min[0]);
    const y = area.min[1] + rand() * (area.max[1] - area.min[1]) * 0.66;
    const z = area.min[2] + rand() * (area.max[2] - area.min[2]);
    return [x, y, z];
  };

  const scratch = new Vector3();

  const spawn = (context: MiniGameContext) => {
    // The anchor: the previous target if there was one (deterministic), else
    // the butterfly's position at this moment — which for the first spawn of a
    // game is its start point, also deterministic.
    const anchor: WorldPoint = lastSpawn ?? [
      context.flight.position.x,
      context.flight.position.y,
      context.flight.position.z,
    ];
    const position = drawPosition(anchor);
    lastSpawn = position;
    target = {
      position,
      spawnedAt: context.elapsed,
      expiresAt: context.elapsed + tuning.targetLifetimeSeconds,
    };
    catchable = false;
    // The chase: send the butterfly after each new target, at the *exact* world
    // point the hit test uses. A refused seek (the butterfly is already there)
    // is harmless — it simply hovers, and the catchable gate opens on the next
    // tick because it is already within catchRadius.
    scratch.set(position[0], position[1], position[2]);
    context.flight.seekTo(scratch);
    notify();
  };

  const expire = (elapsed: number) => {
    target = null;
    catchable = false;
    misses += 1;
    nextSpawnAt = elapsed + tuning.spawnGapSeconds;
    notify();
  };

  return {
    id: "butterfly-chase",
    name: "Butterfly Chase",
    description: "Click each glowing target before it vanishes.",
    supportsPause: true,

    onStart(context) {
      score = 0;
      hits = 0;
      misses = 0;
      target = null;
      catchable = false;
      lastSpawn = null;
      nextSpawnAt = 0;
      remaining = tuning.durationSeconds;
      lastNotifiedSecond = -1;
      spawn(context);
    },

    update(context, dt) {
      remaining = Math.max(0, tuning.durationSeconds - context.elapsed);
      // The fixed duration is the completion condition.
      if (context.elapsed >= tuning.durationSeconds) {
        context.complete();
        return;
      }
      // The HUD's second display ticks on integer boundaries only — no
      // per-frame notification noise.
      const second = Math.ceil(remaining);
      if (second !== lastNotifiedSecond) {
        lastNotifiedSecond = second;
        notify();
      }
      if (target) {
        // The catchable gate: the butterfly has actually arrived. Recomputed
        // every tick from the controller's real position, so it can never
        // disagree with what the player sees on screen.
        scratch.set(target.position[0], target.position[1], target.position[2]);
        catchable = scratch.distanceTo(context.flight.position) <= tuning.catchRadius;
        if (context.elapsed >= target.expiresAt) expire(context.elapsed);
      } else if (context.elapsed >= nextSpawnAt) {
        spawn(context);
      }
      void dt;
    },

    onClick(context, _point, ray) {
      // The gate: the butterfly must actually be there. A click while it is
      // still chasing is simply not a catch — the target stays alive.
      if (!target || !catchable || !ray) return;
      // The test: closest approach of the *actual click ray* to the target's
      // actual world position — the same construction as the garden's flower
      // picking. The resolved targeting point (`_point`) is deliberately not
      // used: its altitude and depth are remapped for flight targeting, so it
      // does not correspond to the thing that was clicked.
      const [ox, oy, oz] = ray.origin;
      const [dx, dy, dz] = ray.direction;
      const cx = target.position[0] - ox;
      const cy = target.position[1] - oy;
      const cz = target.position[2] - oz;
      const along = cx * dx + cy * dy + cz * dz;
      if (along <= 0) return; // the click points away from the target
      const px = ox + dx * along;
      const py = oy + dy * along;
      const pz = oz + dz * along;
      const distance = Math.hypot(
        target.position[0] - px,
        target.position[1] - py,
        target.position[2] - pz,
      );
      if (distance > tuning.hitRadius) return;
      // A hit: score exactly once, consume the target, and schedule the next
      // one. `target` is null from here, so this target can never score again
      // and can never be counted as skipped.
      hits += 1;
      score += 1;
      target = null;
      catchable = false;
      nextSpawnAt = context.elapsed + tuning.spawnGapSeconds;
      notify();
    },

    onStop() {
      // Whatever the exit, no active target may outlive the game: the marker
      // hides, and a restart begins from a genuinely clean slate.
      target = null;
      catchable = false;
      lastSpawn = null;
    },

    onPointerMove() {
      // Consume every move: while the chase runs, the butterfly belongs to the
      // targets, so the ordinary cursor-follow must not reclaim it.
      return true;
    },

    get score() {
      return score;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get target() {
      return target;
    },
    get catchable() {
      return catchable;
    },
    get remainingSeconds() {
      return remaining;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

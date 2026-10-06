import type { Vector3 } from "three";
import type { FlightController } from "./flight";

/**
 * The mini-game foundation (Phase 16).
 *
 * A mini-game is an *activity layered on top of the companion*, never a
 * replacement for it. The same butterfly, the same flight controller, the same
 * personality, the same memory — the game borrows two things for a while and
 * gives them back cleanly:
 *
 * 1. **Input ownership.** While a game is active, pointer clicks and moves in
 *    the garden go to the game instead of to the ordinary summon / flower /
 *    live-target path. `Interaction` checks one flag — `ownsPointer()` — and
 *    otherwise changes nothing.
 * 2. **The autonomous wander rhythm.** The flight controller's
 *    `setAutonomySuppressed(true)` suspends the resting rhythm and the shy hop
 *    while a game runs, and restores them the moment it ends. Everything else
 *    the flight controller does is untouched.
 *
 * What this module deliberately is NOT:
 *
 * - Not a game engine. There is no ECS, no scene graph, no plugin registry, no
 *   event bus, no asset pipeline, no save system. A game is a small object with
 *   lifecycle hooks; the runtime is a small state machine.
 * - Not a second input system. The DOM listeners stay exactly where they are
 *   (`Interaction`); the runtime only answers "does a game want this event?"
 * - Not a UI system. The runtime is invisible by default; the garden renders
 *   nothing extra while no game is active.
 *
 * The state machine:
 *
 *   inactive ──start()──▶ ready ──(game's onStart returns)──▶ playing
 *     ▲                                                       │  │
 *     │                                            pause() ───┘  └── resume()
 *     │                                                       │  (paused)
 *     │                                                       ▼
 *     │                              complete() ── completed ──▶ cleanup ──▶ inactive
 *     │
 *     └────────── cancel() / reset() (cleanup) ───────────────┘
 *
 * `ready` exists so a game's start hook runs while the runtime is already
 * clearly in a transition — the game cannot observe a half-started runtime.
 * `completed` exists so the garden can show a result for a moment before the
 * game closes; the runtime then settles back to `inactive`.
 *
 * Everything in here is deterministic and side-effect free apart from the
 * game's own hooks: no rendering imports, no DOM, no timers of its own (a game
 * that needs one registers it as a resource, which the runtime then guarantees
 * to tear down).
 */

/** The lifecycle states a mini-game may be in. */
export const MINIGAME_STATES = [
  "inactive",
  "ready",
  "playing",
  "paused",
  "completed",
] as const;
export type MiniGameState = (typeof MINIGAME_STATES)[number];

/** A world-space point, as [x, y, z]. */
export type WorldPoint = readonly [number, number, number];

/**
 * A click expressed as a ray through the camera, in world space.
 *
 * This is the *precise* click: the targeting pipeline also resolves a click to
 * a single point (`point`), but that point is a targeting-plane construct —
 * its altitude is remapped from the vertical screen offset and its depth is
 * clamped to the flight area, so it generally is NOT the world position of the
 * thing that was clicked. A game that needs to know *what* was clicked (rather
 * than *where the click intends*) measures closest approach to this ray —
 * exactly how the garden's flower picking works.
 */
export interface ClickRay {
  origin: WorldPoint;
  /** Normalised. */
  direction: WorldPoint;
}

/**
 * Why a game ended: completed successfully, cancelled by the player, or reset
 * by the host. Passed to `onStop` so a game can distinguish "well done" from
 * "never mind".
 */
export type MiniGameEndReason = "completed" | "cancelled" | "reset";

/**
 * The narrow flight surface a mini-game may use.
 *
 * Only two verbs exist, and both are the flight controller's *existing* public
 * interface — `seekTo` for an explicit destination, `aimAt` for a live target.
 * A game never sees the controller itself, so it cannot touch position,
 * velocity, destinations or internals; it can only ask, exactly as a person's
 * click asks.
 */
export interface MiniGameFlightSurface {
  /** Request an explicit flight destination. Same semantics as a click. */
  seekTo(point: Vector3): boolean;
  /** Set or clear the live target (null clears). */
  aimAt(point: Vector3 | null): void;
  /** The butterfly's current position (read-only reference). */
  readonly position: Vector3;
}

/**
 * What the runtime hands to a game's hooks. Deliberately small: the narrow
 * flight surface, a clock, and a way to register resources for guaranteed
 * cleanup. A game that needs more than this should be adding it to the *game*,
 * not to the runtime.
 */
export interface MiniGameContext {
  flight: MiniGameFlightSurface;
  /**
   * Seconds since the game started (the runtime advances it each tick while
   * playing). Pausing freezes it, so game logic never has to know pause
   * happened.
   */
  elapsed: number;
  /**
   * Register a resource to be torn down when the game ends for any reason —
   * a timer, a listener, an animation handle. The runtime calls each exactly
   * once, in reverse registration order, on complete, cancel and reset alike.
   */
  addResource(dispose: () => void): void;
  /**
   * Ends the game on the success path (`playing → completed → cleanup`). A
   * timed game calls this when its duration runs out; it is the game's own
   * way to say "done", and it routes through the same single teardown path as
   * every other exit.
   */
  complete(): void;
}

/**
 * A mini-game definition: identity plus lifecycle hooks, nothing else.
 *
 * A game is a plain object — no base class, no registration ceremony. The
 * runtime only ever calls these hooks; a game that ignores most of them is a
 * three-line object. `update` is the only per-frame hook, and it is optional:
 * a purely event-driven game simply omits it.
 */
export interface MiniGameDefinition {
  /** Stable identifier, e.g. "ring-flight". */
  readonly id: string;
  /** Human-readable name for future menus. */
  readonly name: string;
  /** One line about the game, for future menus. */
  readonly description?: string;
  /** Whether the game tolerates being paused. */
  readonly supportsPause: boolean;
  /** Called once when the game enters `ready`, before it becomes `playing`. */
  onStart?(context: MiniGameContext): void;
  /** Called each frame while `playing`. `dt` is seconds. */
  update?(context: MiniGameContext, dt: number): void;
  /** Called on pause and resume respectively. */
  onPause?(context: MiniGameContext): void;
  onResume?(context: MiniGameContext): void;
  /**
   * Called when a pointer click reaches the game (the garden's ordinary
   * summon/flower path is not consulted while a game is active).
   *
   * `point` is the click resolved through the targeting pipeline — what the
   * click *intends* as a destination. `ray` is the actual camera ray of the
   * click — what the click *touched*. Games that hit-test against world
   * objects must use the ray; the point's altitude and depth are remapped for
   * flight targeting and do not correspond to any world object.
   */
  onClick?(context: MiniGameContext, point: Vector3, ray: ClickRay): void;
  /**
   * Called when the pointer moves while the game owns input. Return true to
   * consume the move (the ordinary live-target `aimAt` stays off); return
   * false or leave undefined to let the normal cursor-follow continue.
   */
  onPointerMove?(context: MiniGameContext, point: Vector3): boolean | void;
  /**
   * Called exactly once when the game ends, whatever the reason. Game-specific
   * teardown belongs in resources (`context.addResource`) — this hook is for
   * observing the end (score tally, a farewell), not for cleanup.
   */
  onStop?(context: MiniGameContext, reason: MiniGameEndReason): void;
}

/**
 * Builds the narrow flight surface over the real controller.
 *
 * The game never sees the `FlightController` itself — only the two verbs a
 * person's click already has, plus a read-only view of position. Autonomy
 * suppression stays with the runtime (it owns and releases it through
 * `setAutonomySuppressed`), because that is a lifecycle guarantee, not a game
 * verb.
 */
export function miniGameFlightSurface(flight: FlightController): MiniGameFlightSurface {
  return {
    seekTo: (point) => flight.seekTo(point),
    aimAt: (point) => flight.aimAt(point),
    get position() {
      return flight.position;
    },
  };
}

/**
 * The generic lifecycle boundary. Owns no game logic and no resources of its
 * own beyond the registered disposers of the currently active game.
 *
 * The runtime is constructed once per scene with a flight *surface* (not the
 * controller) and an autonomy-release callback, so tests can drive it with a
 * stub and the app wires the real things in one place.
 */
/** The runtime's dependencies, injected once at construction. */
export interface MiniGameRuntimeDeps {
  flight: MiniGameFlightSurface;
  /** Called with `true` while a game runs and `false` when it ends. */
  setAutonomySuppressed: (suppressed: boolean) => void;
}

export class MiniGameRuntime {
  private state: MiniGameState = "inactive";
  private game: MiniGameDefinition | null = null;
  private elapsed = 0;
  private readonly resources: Array<() => void> = [];
  /** Registered state observers (for the host UI and for tests). */
  private readonly listeners = new Set<(state: MiniGameState) => void>();
  private readonly deps: MiniGameRuntimeDeps;

  constructor(deps: MiniGameRuntimeDeps) {
    this.deps = deps;
  }

  get currentState(): MiniGameState {
    return this.state;
  }

  get activeGame(): MiniGameDefinition | null {
    return this.game;
  }

  /** How many resources the active game has registered (test surface). */
  get resourceCount(): number {
    return this.resources.length;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: (state: MiniGameState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transition(next: MiniGameState) {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * Whether the runtime currently owns garden pointer input. `Interaction`
   * checks exactly this and nothing else.
   */
  ownsPointer(): boolean {
    return this.state === "ready" || this.state === "playing" || this.state === "paused";
  }

  /** The context handed to every hook of the active game. */
  private makeContext(): MiniGameContext {
    return {
      flight: this.deps.flight,
      elapsed: this.elapsed,
      addResource: (dispose) => {
        this.resources.push(dispose);
      },
      complete: () => {
        this.complete();
      },
    };
  }

  /**
   * Starts a game. Returns false (without touching anything) if another game
   * is active — a second start can never create duplicate runtime state.
   */
  start(game: MiniGameDefinition): boolean {
    if (this.state !== "inactive") return false;
    this.game = game;
    this.elapsed = 0;
    this.transition("ready");
    // The runtime claims autonomy suppression the same moment it claims the
    // game, so a game's start hook already runs with the rhythm held.
    this.deps.setAutonomySuppressed(true);
    game.onStart?.(this.makeContext());
    // A start hook may end the game immediately (e.g. it knows it cannot run).
    // Read through the getter: the hook may have moved the state, and a direct
    // field read would be narrowed to the value set above.
    if (this.currentState !== "ready") return true;
    this.transition("playing");
    return true;
  }

  /** Pauses an active game. No-op (returns false) unless the game allows it. */
  pause(): boolean {
    if (this.state !== "playing" || !this.game?.supportsPause) return false;
    this.transition("paused");
    this.game.onPause?.(this.makeContext());
    return true;
  }

  /** Resumes a paused game. */
  resume(): boolean {
    if (this.state !== "paused" || !this.game) return false;
    this.transition("playing");
    this.game.onResume?.(this.makeContext());
    return true;
  }

  /** Completes the active game: the success path out. */
  complete(): boolean {
    if (this.state !== "playing" && this.state !== "paused") return false;
    this.transition("completed");
    this.teardown("completed");
    return true;
  }

  /** Cancels the active game: the player-chosen exit. */
  cancel(): boolean {
    if (this.state === "inactive" || this.state === "completed") return false;
    this.teardown("cancelled");
    return true;
  }

  /**
   * Resets the runtime to a clean initial state. From `inactive` this is a
   * no-op; from anywhere else it is a teardown without a verdict.
   */
  reset(): boolean {
    if (this.state === "inactive") return false;
    this.teardown("reset");
    return true;
  }

  /** Advances the active game's clock and update hook. Ignored otherwise. */
  update(dt: number) {
    if (this.state !== "playing" || !this.game) return;
    this.elapsed += dt;
    this.game.update?.(this.makeContext(), dt);
  }

  /** Routes a garden pointer click to the active game, if any. */
  handleClick(point: Vector3, ray: ClickRay): void {
    if (this.state !== "playing" || !this.game?.onClick) return;
    this.game.onClick(this.makeContext(), point, ray);
  }

  /** Routes a garden pointer move; returns whether the game consumed it. */
  handlePointerMove(point: Vector3): boolean {
    if (this.state !== "playing" || !this.game?.onPointerMove) return false;
    return this.game.onPointerMove(this.makeContext(), point) === true;
  }

  /**
   * The one teardown path. Complete, cancel and reset all end here, so the
   * guarantees below can never diverge between the exits:
   *
   * - the game's `onStop` runs with the reason;
   * - every registered resource is disposed exactly once, in reverse order;
   * - autonomy suppression is released;
   * - the runtime returns to `inactive` with no stale game, clock or resources.
   */
  private teardown(reason: MiniGameEndReason) {
    const game = this.game;
    if (!game) {
      this.transition("inactive");
      return;
    }
    // Reverse order: resources unwind the way they wound up.
    game.onStop?.(this.makeContext(), reason);
    for (let i = this.resources.length - 1; i >= 0; i--) {
      this.resources[i]();
    }
    this.resources.length = 0;
    this.deps.setAutonomySuppressed(false);
    this.game = null;
    this.elapsed = 0;
    this.transition("inactive");
  }
}

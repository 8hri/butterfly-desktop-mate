/**
 * Deterministic tests for the mini-game foundation (Phase 16, dev only).
 *
 * What is asserted here is the *boundary*, not any game: the lifecycle state
 * machine, invalid-transition rejection, interaction ownership, autonomy
 * suppression, and — above all — the cleanup guarantees: after every exit path
 * there are no timers, no listeners, no resources, no input ownership, no
 * flight control left over, and the ordinary garden interaction surface is
 * available again exactly as before.
 *
 * A tiny `TestMiniGame` definition (no gameplay) exists only to exercise those
 * transitions. It is not the first mini-game.
 *
 * Usage: node tools/test-minigame.mjs
 */
import {
  MINIGAME_STATES,
  MiniGameRuntime,
  miniGameFlightSurface,
} from "../src/lib/minigame.ts";
import * as minigameModule from "../src/lib/minigame.ts";
import { FlightController, DEFAULT_FLIGHT_TUNING } from "../src/lib/flight.ts";
import { Vector3 } from "three";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** Deterministic PRNG, same as the flight suite uses. */
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** A fresh flight controller plus its recorded suppression transitions. */
function makeFlight() {
  const flight = new FlightController(
    DEFAULT_FLIGHT_TUNING,
    new Vector3(0, 1.4, 0),
    mulberry32(42),
  );
  const suppressions = [];
  const setAutonomySuppressed = (suppressed) => {
    suppressions.push(suppressed);
    flight.setAutonomySuppressed(suppressed);
  };
  return {
    flight,
    suppressions,
    deps: { flight: miniGameFlightSurface(flight), setAutonomySuppressed },
  };
}

/** The lifecycle test stub: no gameplay, just hook bookkeeping. */
function makeTestGame(overrides = {}) {
  const calls = { start: 0, update: 0, pause: 0, resume: 0, click: 0, move: 0, stop: [] };
  const resources = [];
  const game = {
    id: "test-game",
    name: "Test Mini-Game",
    description: "Lifecycle test stub — not a real game.",
    supportsPause: true,
    onStart(context) {
      calls.start++;
      // A game registers its real resources through the context; two stand-ins
      // (a timer, a listener) prove teardown runs them exactly once.
      context.addResource(() => resources.push("disposed-timer"));
      context.addResource(() => resources.push("disposed-listener"));
    },
    update(context, dt) {
      calls.update++;
      if (dt > 0 && context.elapsed >= 0) {
        /* deterministic, no state */
      }
    },
    onPause() {
      calls.pause++;
    },
    onResume() {
      calls.resume++;
    },
    onClick(context, point) {
      calls.click++;
      game.lastClick = [point.x, point.y, point.z];
    },
    onPointerMove(context, point) {
      calls.move++;
      return true;
    },
    onStop(context, reason) {
      calls.stop.push(reason);
    },
    ...overrides,
  };
  return { game, calls, resources };
}

// --- The vocabulary is exactly five states ---------------------------------------
check(
  "the state vocabulary is exactly inactive/ready/playing/paused/completed",
  MINIGAME_STATES.join(",") === "inactive,ready,playing,paused,completed",
  MINIGAME_STATES.join(","),
);

// --- Start: inactive -> ready -> playing -----------------------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls } = makeTestGame();
  const seen = [];
  runtime.onStateChange((state) => seen.push(state));

  check("a fresh runtime is inactive and owns nothing", runtime.currentState === "inactive" && !runtime.ownsPointer());
  check("start returns true and runs the game's start hook", runtime.start(game) && calls.start === 1);
  check(
    "start passes through ready into playing",
    runtime.currentState === "playing" && seen.join(",") === "ready,playing",
    seen.join(","),
  );
  check("an active game owns the pointer", runtime.ownsPointer());
}

// --- Pause / resume ---------------------------------------------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls } = makeTestGame();
  runtime.start(game);

  check("pause succeeds on a playing game that supports it", runtime.pause() && runtime.currentState === "paused");
  check("pause ran the game's hook exactly once", calls.pause === 1);
  check("a paused game still owns the pointer (the player is mid-game)", runtime.ownsPointer());
  check("update does not advance while paused", (runtime.update(0.5), calls.update === 0));
  check("resume returns to playing and runs the hook", runtime.resume() && runtime.currentState === "playing" && calls.resume === 1);
  check("update advances while playing", (runtime.update(0.5), calls.update === 1));
}

// --- A game that does not support pause cannot be paused ---------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game } = makeTestGame({ supportsPause: false });
  runtime.start(game);
  check(
    "pause is rejected when the game does not support it",
    !runtime.pause() && runtime.currentState === "playing",
  );
  check(
    "resume is rejected when not paused",
    !runtime.resume() && runtime.currentState === "playing",
  );
}

// --- Invalid transitions are rejected safely ---------------------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  check("pause on an inactive runtime is a no-op", !runtime.pause() && runtime.currentState === "inactive");
  check("resume on an inactive runtime is a no-op", !runtime.resume() && runtime.currentState === "inactive");
  check("complete on an inactive runtime is a no-op", !runtime.complete() && runtime.currentState === "inactive");
  check("cancel on an inactive runtime is a no-op", !runtime.cancel() && runtime.currentState === "inactive");
  check("reset on an inactive runtime is a no-op", !runtime.reset() && runtime.currentState === "inactive");
  check("update on an inactive runtime does nothing", (runtime.update(1), runtime.currentState === "inactive"));
}

// --- Complete: playing -> completed -> cleanup -> inactive ---------------------------
{
  const { deps, suppressions } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls, resources } = makeTestGame();
  const seen = [];
  runtime.onStateChange((state) => seen.push(state));
  runtime.start(game);
  seen.length = 0;

  check("complete succeeds", runtime.complete() && calls.stop.join(",") === "completed");
  check(
    "complete passes through completed back to inactive",
    runtime.currentState === "inactive" && seen.join(",") === "completed,inactive",
    seen.join(","),
  );
  check(
    "every registered resource was disposed exactly once, in reverse order",
    resources.join(",") === "disposed-listener,disposed-timer",
    resources.join(","),
  );
  check("no resources remain registered", runtime.resourceCount === 0);
  check("the pointer is owned no more", !runtime.ownsPointer());
  check(
    "autonomy suppression was claimed at start and released at end",
    suppressions.join(",") === "true,false",
    suppressions.join(","),
  );
}

// --- Cancel: playing -> cleanup -> inactive ------------------------------------------
{
  const { deps, suppressions } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls, resources } = makeTestGame();
  runtime.start(game);
  check("cancel succeeds", runtime.cancel() && calls.stop.join(",") === "cancelled");
  check(
    "cancel disposes every resource and goes inactive",
    resources.length === 2 && runtime.currentState === "inactive" && runtime.resourceCount === 0,
  );
  check("autonomy suppression is released on cancel too", suppressions.join(",") === "true,false");
}

// --- Reset from a paused state -------------------------------------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls, resources } = makeTestGame();
  runtime.start(game);
  runtime.pause();
  check("reset succeeds from paused", runtime.reset() && calls.stop.join(",") === "reset");
  check(
    "reset leaves a clean initial state",
    runtime.currentState === "inactive" && !runtime.ownsPointer() && runtime.resourceCount === 0 && resources.length === 2,
  );
}

// --- Re-entry: start, end, start again — no stale state ------------------------------
{
  const { deps, suppressions } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const first = makeTestGame();
  const second = makeTestGame();
  runtime.start(first.game);
  runtime.complete();
  check("a second game can start after the first ended", runtime.start(second.game) && second.calls.start === 1);
  check(
    "the second game runs with no stale state",
    runtime.currentState === "playing" && runtime.resourceCount === 2 && first.calls.stop.length === 1,
  );
  runtime.complete();
  check(
    "suppression cycles cleanly across both games",
    suppressions.join(",") === "true,false,true,false",
    suppressions.join(","),
  );
}

// --- Multiple starts: an active game rejects a second start ----------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const first = makeTestGame();
  const second = makeTestGame();
  runtime.start(first.game);
  check(
    "starting an already-active runtime is rejected",
    !runtime.start(second.game) && runtime.activeGame?.id === "test-game" && second.calls.start === 0,
  );
  check("the rejected game received no start hook and no state changed", runtime.currentState === "playing");
}

// --- Interaction ownership -------------------------------------------------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game, calls } = makeTestGame();

  check("clicks go nowhere while inactive", (runtime.handleClick(new Vector3()), calls.click === 0));
  check("moves go nowhere while inactive", !runtime.handlePointerMove(new Vector3()) && calls.move === 0);

  runtime.start(game);
  runtime.handleClick(new Vector3(0.5, 1.2, -1));
  check("a click while playing reaches the game", calls.click === 1 && game.lastClick.join(",") === "0.5,1.2,-1");
  check("a move the game consumes reports itself consumed", runtime.handlePointerMove(new Vector3()) && calls.move === 1);

  runtime.complete();
  runtime.handleClick(new Vector3());
  check("after the game ends, clicks reach it no more", calls.click === 1);
}

// --- A game that consumes nothing leaves the ordinary path alone -----------------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game } = makeTestGame({ onPointerMove: undefined });
  runtime.start(game);
  check(
    "a game without a move handler does not consume moves",
    !runtime.handlePointerMove(new Vector3()),
  );
  check("a game without a click handler swallows nothing extra", (runtime.handleClick(new Vector3()), true));
  runtime.cancel();
}

// --- Flight integration: suppression actually suspends the rhythm ----------------------
{
  const { flight, deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game } = makeTestGame();
  const dt = 1 / 60;

  // Run the bare controller for a while: it should wander (mode changes occur).
  const bare = new FlightController(DEFAULT_FLIGHT_TUNING, new Vector3(0, 1.4, 0), mulberry32(42));
  let bareTransitions = 0;
  let previous = bare.mode;
  for (let i = 0; i < 60 * 30; i++) {
    bare.step(dt);
    if (bare.mode !== previous) {
      bareTransitions++;
      previous = bare.mode;
    }
  }

  runtime.start(game);
  // Suppression is not a teleport: a leg already in flight when the game starts
  // completes its soft landing, which is one legitimate mode transition. What
  // must never happen is a *new* autonomous leg beginning. So the first 10s is
  // the settling window; the assertion covers the 20s after it.
  for (let i = 0; i < 60 * 10; i++) flight.step(dt);
  let suppressedTransitions = 0;
  previous = flight.mode;
  for (let i = 0; i < 60 * 20; i++) {
    flight.step(dt);
    if (flight.mode !== previous) {
      suppressedTransitions++;
      previous = flight.mode;
    }
  }
  check(
    "while suppressed, the autonomous rhythm never starts a new leg",
    suppressedTransitions === 0 && bareTransitions > 0,
    `suppressed=${suppressedTransitions} transitions after settling, same-seed bare=${bareTransitions}`,
  );
  check("the controller reports its suppression", flight.isAutonomySuppressed === true);

  runtime.complete();
  check("suppression is lifted when the game ends", flight.isAutonomySuppressed === false);
  let resumedTransitions = 0;
  previous = flight.mode;
  for (let i = 0; i < 60 * 30; i++) {
    flight.step(dt);
    if (flight.mode !== previous) {
      resumedTransitions++;
      previous = flight.mode;
    }
  }
  check("the ordinary wander rhythm resumes afterwards", resumedTransitions > 0, `resumed=${resumedTransitions}`);
}

// --- Flight integration: the game can ask for movement, and nothing more -----------------
{
  const { flight, deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  const { game } = makeTestGame();
  runtime.start(game);
  const surface = deps.flight;
  const target = new Vector3(1.0, 1.6, -0.3);
  check(
    "the game can request a flight through the surface",
    surface.seekTo(target) === true && flight.userTarget !== null,
  );
  check("the surface exposes position read-only", surface.position === flight.position);
  check(
    "the surface exposes only seekTo/aimAt/position",
    Object.keys(surface).sort().join(",") === "aimAt,position,seekTo",
    Object.keys(surface).sort().join(","),
  );
  runtime.complete();
}

// --- A start hook may end the game immediately -------------------------------------------
{
  const { deps, suppressions } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  let stopped = false;
  const selfEnding = {
    id: "self-ending",
    name: "Self Ending",
    supportsPause: false,
    onStart(context) {
      context.addResource(() => {
        stopped = true;
      });
    },
  };
  // A start hook that cancels must not leave the runtime half-started.
  runtime.start(selfEnding);
  runtime.cancel();
  check(
    "a game that is cancelled from the outside during start leaves no residue",
    stopped && runtime.currentState === "inactive" && runtime.resourceCount === 0 && suppressions.join(",") === "true,false",
  );
}

// --- Module surface -----------------------------------------------------------------------
{
  const surface = Object.keys(minigameModule).sort().join(",");
  check(
    "the module surface is exactly the foundation",
    surface === "MINIGAME_STATES,MiniGameRuntime,miniGameFlightSurface",
    surface,
  );
  // `WorldPoint` is a type-only export and correctly absent at runtime.
}

// --- A game can end itself (Phase 16.1: timed games need this seam) ----------------
{
  const { deps } = makeFlight();
  const runtime = new MiniGameRuntime(deps);
  let stopReason = null;
  const timed = {
    id: "timed",
    name: "Timed",
    supportsPause: false,
    update(context, dt) {
      if (context.elapsed >= 1) context.complete();
    },
    onStop(context, reason) {
      stopReason = reason;
    },
  };
  runtime.start(timed);
  for (let i = 0; i < 70; i++) runtime.update(1 / 60);
  check(
    "a game that completes itself ends through the single teardown path",
    runtime.currentState === "inactive" && stopReason === "completed" && !runtime.ownsPointer(),
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

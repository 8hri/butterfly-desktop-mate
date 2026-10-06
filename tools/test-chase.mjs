/**
 * Deterministic tests for Butterfly Chase (Phase 16.1, dev only).
 *
 * The game is exercised through the *real* Phase 16 runtime and the *real*
 * flight controller — the same seams it uses in the scene — so these tests
 * also re-verify the foundation's guarantees under an actual game: ownership,
 * suppression, the single teardown path, and the immediate return of normal
 * interaction afterwards.
 *
 * Usage: node tools/test-chase.mjs
 */
import { Vector3 } from "three";
import { SCENE } from "../src/config/experience.ts";
import { MiniGameRuntime, miniGameFlightSurface } from "../src/lib/minigame.ts";
import { createButterflyChase } from "../src/lib/butterflyChase.ts";
import { FlightController } from "../src/lib/flight.ts";
import { gardenFlightArea } from "../src/lib/airspace.ts";
import { gardenObjects } from "../src/lib/garden.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** Deterministic PRNG, same as every other suite. */
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const garden = SCENE.garden;
const tuning = garden.chase;
const aspect = garden.windowSize.width / garden.windowSize.height;
const area = gardenFlightArea(aspect, garden);
const landmarks = [
  ...garden.flowers.map((f) => f.position),
  ...garden.stones.map((s) => s.position),
  garden.log.position,
];

/** A fresh runtime + flight + game, wired exactly as the scene wires them. */
function makeGame(seed = garden.seed) {
  const flight = new FlightController(
    { ...SCENE.flight },
    new Vector3(0, 1.4, 0),
    mulberry32(7),
  );
  flight.setArea(area);
  const runtime = new MiniGameRuntime({
    flight: miniGameFlightSurface(flight),
    setAutonomySuppressed: (suppressed) => flight.setAutonomySuppressed(suppressed),
  });
  const game = createButterflyChase({ seed, area, landmarks, tuning });
  return { flight, runtime, game };
}

/** Drives the game at 60 fps for `seconds` of game time. */
function play(runtime, seconds) {
  const dt = 1 / 60;
  for (let i = 0; i < Math.ceil(seconds * 60); i++) runtime.update(dt);
}

/**
 * A click ray aimed exactly at a world point, from a plausible camera spot.
 * The game's hit test is the ray's closest approach, so a ray built this way
 * passes within ~zero of the point.
 */
function rayAt(position, origin = [0.8, 2.1, 4.6]) {
  const dx = position[0] - origin[0];
  const dy = position[1] - origin[1];
  const dz = position[2] - origin[2];
  const length = Math.hypot(dx, dy, dz);
  return { origin, direction: [dx / length, dy / length, dz / length] };
}

/**
 * A click ray that misses the target laterally by `offset` world units
 * (aimed parallel to a hit ray but displaced sideways).
 */
function rayPast(position, offset, origin = [0.8, 2.1, 4.6]) {
  const shifted = [position[0] + offset, position[1], position[2]];
  return rayAt(shifted, origin);
}

/**
 * Drives game AND flight until the butterfly is within catchRadius of the
 * live target — the condition the game itself uses to open the hit gate.
 */
function arrive(runtime, game, flight) {
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 12; i++) {
    runtime.update(dt);
    flight.step(dt);
    if (game.catchable) return true;
  }
  return game.catchable;
}

// --- Start: the game enters playing with a live target ------------------------------
{
  const { runtime, game, flight } = makeGame();
  check("start enters playing", runtime.start(game) && runtime.currentState === "playing");
  check("a target exists immediately", game.target !== null);
  check(
    "the butterfly is sent after the target",
    flight.userTarget !== null &&
      flight.userTarget.distanceTo(new Vector3(...game.target.position)) < 1e-6,
  );
  check("autonomy is suppressed while playing", flight.isAutonomySuppressed === true);
  check("the score starts at zero", game.score === 0);
  check("the runtime owns the pointer", runtime.ownsPointer());
}

// --- Target spawning: deterministic, inside the area, clear of landmarks -------------
{
  const { runtime, game } = makeGame();
  runtime.start(game);
  const spawned = [];
  // Drive through several spawns by letting targets expire.
  for (let i = 0; i < 8; i++) {
    if (game.target) spawned.push([...game.target.position]);
    play(runtime, tuning.targetLifetimeSeconds + tuning.spawnGapSeconds + 0.05);
  }
  check(
    "targets spawn one at a time after expiry",
    spawned.length >= 3,
    `${spawned.length} spawns observed`,
  );
  check(
    "every target is inside the flight area",
    spawned.every(
      ([x, y, z]) =>
        x >= area.min[0] && x <= area.max[0] &&
        y >= area.min[1] && y <= area.max[1] &&
        z >= area.min[2] && z <= area.max[2],
    ),
  );
  check(
    "every target keeps clear of flowers, stones and the log",
    spawned.every(([x, , z]) =>
      landmarks.every(([lx, lz]) => Math.hypot(x - lx, z - lz) >= tuning.minLandmarkDistance - 1e-9),
    ),
  );
}

// --- Determinism: same seed, same stream ---------------------------------------------
{
  const first = makeGame(20260);
  const second = makeGame(20260);
  first.runtime.start(first.game);
  second.runtime.start(second.game);
  const sequence = (runtime, game) => {
    const out = [[...game.target.position]];
    for (let i = 0; i < 4; i++) {
      play(runtime, tuning.targetLifetimeSeconds + tuning.spawnGapSeconds + 0.05);
      if (game.target) out.push([...game.target.position]);
    }
    return JSON.stringify(out);
  };
  check(
    "the same seed produces the same target stream",
    sequence(first.runtime, first.game) === sequence(second.runtime, second.game),
  );
  const third = makeGame(20261);
  third.runtime.start(third.game);
  check(
    "a different seed produces a different stream",
    JSON.stringify(third.game.target.position) !== JSON.stringify(first.game.target.position),
  );
}

// --- The gate: a click before the butterfly arrives is not a catch --------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  check("the gate starts closed (the butterfly has not arrived)", game.catchable === false);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position));
  check(
    "a click on the target BEFORE arrival scores nothing",
    game.score === 0 && game.target !== null,
  );
  check("the gate opens when the butterfly arrives", arrive(runtime, game, flight) === true);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position));
  check(
    "the same click AFTER arrival scores",
    game.score === 1 && game.hits === 1 && game.target === null,
  );
}

// --- A successful hit: exactly once, consumed, next from the stream ----------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  arrive(runtime, game, flight);
  const firstPosition = [...game.target.position];
  runtime.handleClick(new Vector3(...firstPosition), rayAt(firstPosition));
  check(
    "a click on an arrived target scores exactly once",
    game.score === 1 && game.hits === 1 && game.target === null,
  );
  runtime.handleClick(new Vector3(...firstPosition), rayAt(firstPosition));
  check(
    "the same spot cannot score twice (the target is consumed)",
    game.score === 1 && game.hits === 1,
  );
  check(
    "the hit target is never counted as skipped",
    game.misses === 0,
  );
  check(
    "the next target spawns after the gap",
    (play(runtime, tuning.spawnGapSeconds + 0.05), game.target !== null),
  );
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position));
  check("hits accumulate across the stream", game.score === 2 && game.hits === 2 && game.misses === 0);
}

// --- Ray precision: a ray that misses laterally does not hit ------------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayPast(game.target.position, tuning.hitRadius + 0.05));
  check(
    "a ray missing by more than the hit radius does not score",
    game.score === 0 && game.target !== null,
  );
  runtime.handleClick(new Vector3(...game.target.position), rayPast(game.target.position, tuning.hitRadius - 0.05));
  check(
    "a ray passing just inside the hit radius scores",
    game.score === 1,
  );
}

// --- Expiry: exactly one skip, removed, never scores again ---------------------------------
{
  const { runtime, game } = makeGame();
  runtime.start(game);
  const expiredPosition = [...game.target.position];
  play(runtime, tuning.targetLifetimeSeconds + 0.02);
  check(
    "an unclicked target expires and counts as skipped exactly once",
    game.target === null && game.misses === 1,
  );
  runtime.handleClick(new Vector3(...expiredPosition), rayAt(expiredPosition));
  check(
    "an expired target can never score, even clicking its exact spot",
    game.score === 0 && game.misses === 1,
  );
}

// --- Accounting: final counts match the actual target lifecycle ------------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  // Scripted lifecycle: hit two, let one expire, hit one, let the game end.
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position)); // hit 1
  play(runtime, tuning.spawnGapSeconds + 0.05);
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position)); // hit 2
  play(runtime, tuning.spawnGapSeconds + 0.05);
  play(runtime, tuning.targetLifetimeSeconds + 0.02); // expire 1
  play(runtime, tuning.spawnGapSeconds + 0.05);
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position)); // hit 3
  check(
    "after 3 hits and 1 expiry the counters match the lifecycle",
    game.score === 3 && game.hits === 3 && game.misses === 1,
    `score=${game.score} hits=${game.hits} misses=${game.misses}`,
  );
}

// --- A target still live at completion is neither hit nor skipped -------------------------
// Proven directly with a game shorter than one target lifetime: the first target
// outlives the whole game, so at completion there is exactly one live target and
// every counter must be zero.
{
  const flight = new FlightController({ ...SCENE.flight }, new Vector3(0, 1.4, 0), mulberry32(7));
  flight.setArea(area);
  const runtime = new MiniGameRuntime({
    flight: miniGameFlightSurface(flight),
    setAutonomySuppressed: (s) => flight.setAutonomySuppressed(s),
  });
  const game = createButterflyChase({
    seed: garden.seed,
    area,
    landmarks,
    tuning: { ...tuning, durationSeconds: tuning.targetLifetimeSeconds - 1 },
  });
  runtime.start(game);
  play(runtime, tuning.targetLifetimeSeconds + 1);
  check(
    "a target still live at completion is neither hit nor skipped",
    runtime.currentState === "inactive" && game.score === 0 && game.hits === 0 && game.misses === 0,
    `score=${game.score} hits=${game.hits} misses=${game.misses}`,
  );
  check(
    "game completion leaves no active target",
    game.target === null && game.catchable === false,
  );
}

// --- Restart: "Again" starts with clean counters and a reachable first target ----------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  arrive(runtime, game, flight);
  runtime.handleClick(new Vector3(...game.target.position), rayAt(game.target.position));
  play(runtime, tuning.spawnGapSeconds + tuning.targetLifetimeSeconds + 1); // expire target 2
  runtime.complete();

  runtime.start(game); // "Again"
  check(
    "a restart begins with clean counters",
    game.score === 0 && game.hits === 0 && game.misses === 0 && game.target !== null,
  );
  check(
    "the restart's first target spawns within reach of the butterfly's position",
    new Vector3(...game.target.position).distanceTo(flight.position) <= tuning.spawnDistance[1] + 1e-6,
    `distance ${new Vector3(...game.target.position).distanceTo(flight.position).toFixed(2)}`,
  );
  check("the flight surface is claimed for the new round", flight.isAutonomySuppressed === true);

  // Determinism of a restart: the definition keeps ONE seeded stream across
  // restarts, so "Again" continues the sequence rather than replaying it —
  // every round is deterministic from the seed, and no two rounds repeat.
  // (Fresh definitions with the same seed produce identical streams; that is
  // the determinism property, already asserted above.)
  const secondTarget = [...game.target.position];
  runtime.cancel();
  runtime.start(game);
  check(
    "each restart continues the deterministic stream rather than repeating it",
    JSON.stringify(game.target.position) !== JSON.stringify(secondTarget) &&
      game.score === 0 && game.misses === 0,
  );
}

// --- Expiry: an unclicked target vanishes and a fresh one follows -------------------------
{
  const { runtime, game } = makeGame();
  runtime.start(game);
  play(runtime, tuning.targetLifetimeSeconds + 0.02);
  check("an unclicked target expires", game.target === null && game.misses === 1);
  check(
    "a fresh target spawns after the gap",
    (play(runtime, tuning.spawnGapSeconds + 0.05), game.target !== null),
  );
}

// --- Completion: fixed duration ends the game cleanly -------------------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  let stopReason = null;
  const original = game.onStop?.bind(game);
  game.onStop = (context, reason) => {
    stopReason = reason;
    original?.(context, reason);
  };
  play(runtime, tuning.durationSeconds + 0.1);
  check(
    "the game completes itself at the fixed duration",
    runtime.currentState === "inactive" && stopReason === "completed",
  );
  check("autonomy suppression is released on completion", flight.isAutonomySuppressed === false);
  check("the runtime no longer owns the pointer", !runtime.ownsPointer());
}

// --- Cancellation: mid-game cancel cleans up fully -----------------------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  play(runtime, 2);
  const stopReasons = [];
  const original = game.onStop?.bind(game);
  game.onStop = (context, reason) => {
    stopReasons.push(reason);
    original?.(context, reason);
  };
  check("cancel succeeds mid-game", runtime.cancel());
  check(
    "cancel tears down through the single path",
    runtime.currentState === "inactive" &&
      stopReasons.join(",") === "cancelled" &&
      flight.isAutonomySuppressed === false &&
      !runtime.ownsPointer(),
  );
}

// --- Pause: the game clock freezes -----------------------------------------------------------
{
  const { runtime, game } = makeGame();
  runtime.start(game);
  play(runtime, 2);
  const remaining = game.remainingSeconds;
  const target = game.target;
  check("the game supports pause", runtime.pause() && runtime.currentState === "paused");
  play(runtime, 5);
  check(
    "while paused, the clock and the target are frozen",
    game.remainingSeconds === remaining && game.target === target,
  );
  check("resume continues the game", runtime.resume() && runtime.currentState === "playing");
  play(runtime, 1);
  check("the clock advances again after resume", game.remainingSeconds < remaining);
}

// --- Normal interaction returns immediately when the game ends --------------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  check("the pointer is owned during play", runtime.ownsPointer());
  runtime.cancel();
  check(
    "the moment the game ends, ownership is gone",
    !runtime.ownsPointer() && runtime.currentState === "inactive",
  );
  // The ordinary surface works again: a seek lands exactly as before.
  const ok = flight.seekTo(new Vector3(area.min[0] + 0.3, 1.2, 0));
  check("the flight surface answers ordinary requests again", ok === true && flight.userTarget !== null);
}

// --- The butterfly actually chases: it moves toward each spawned target -------------------------
{
  const { runtime, game, flight } = makeGame();
  runtime.start(game);
  const dt = 1 / 60;
  const position = game.target.position;
  let closest = Infinity;
  for (let i = 0; i < 60 * 10; i++) {
    runtime.update(dt);
    flight.step(dt);
    closest = Math.min(closest, flight.position.distanceTo(new Vector3(...position)));
    if (closest < SCENE.flight.arriveRadius) break;
  }
  check(
    "the butterfly flies to the target and arrives",
    closest < SCENE.flight.arriveRadius,
    `closest approach ${closest.toFixed(3)} (arrive radius ${SCENE.flight.arriveRadius})`,
  );
  // While it chases, it never wanders off on its own.
  check("the wander rhythm stayed suppressed the whole chase", flight.isAutonomySuppressed === true);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

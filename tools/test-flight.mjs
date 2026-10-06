/**
 * Behavioural test for FlightController (dev only). Runs the simulation
 * headlessly with a seeded RNG and asserts the invariants that matter for
 * believable movement: bounded roaming, no teleporting, smooth speed
 * changes, mode transitions, and arrival after an interaction request.
 *
 * Usage: node tools/test-flight.mjs
 */
import { Vector3 } from "three";
import {
  FlightController,
  DEFAULT_FLIGHT_TUNING,
  DEFAULT_BEHAVIOR_PROFILE,
} from "../src/lib/flight.ts";
import { PERSONALITY_PRESETS, applyFamiliarity } from "../src/lib/personality.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

/** Deterministic PRNG so runs are reproducible. */
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const tuning = DEFAULT_FLIGHT_TUNING;
const start = new Vector3(0, 1.4, 0);
const flight = new FlightController(tuning, start, mulberry32(12345));

const dt = 1 / 60;
const steps = 60 * 120; // two minutes
const areaPad = 0.05;
let maxSpeed = 0;
let maxJump = 0;
let minSpeedFlying = Infinity;
let transitions = 0;
let previousMode = flight.mode;
const previous = new Vector3().copy(flight.position);
let maxAccel = 0;
let finite = true;
let distance = 0;

for (let i = 0; i < steps; i++) {
  const before = previous.clone();
  const speedBefore = flight.velocity.length();
  const mode = flight.step(dt);
  if (!Number.isFinite(flight.position.x + flight.position.y + flight.position.z)) finite = false;

  const speed = flight.velocity.length();
  maxSpeed = Math.max(maxSpeed, speed);
  maxJump = Math.max(maxJump, flight.position.distanceTo(before));
  maxAccel = Math.max(maxAccel, Math.abs(speed - speedBefore) / dt);
  if (mode === "flying") minSpeedFlying = Math.min(minSpeedFlying, speed);
  if (mode !== previousMode) transitions++;
  previousMode = mode;
  distance += flight.position.distanceTo(before);
  previous.copy(flight.position);
}

const cruiseMax = tuning.speed[1] * 1.05; // desired cruise is scaled by up to 1.0
check("position stays finite", finite);
check(
  // Plumbing pin: a fresh controller's profile IS the reference behavior,
  // so every check below (written before profiles existed) is unaffected.
  "default profile is the reference behavior",
  Object.keys(DEFAULT_BEHAVIOR_PROFILE).every(
    (k) => flight.behaviorProfile[k] === DEFAULT_BEHAVIOR_PROFILE[k],
  ),
);
check(
  "stays inside flight area",
  flight.position.x >= tuning.area.min[0] - areaPad &&
    flight.position.x <= tuning.area.max[0] + areaPad &&
    flight.position.y >= tuning.area.min[1] - areaPad &&
    flight.position.y <= tuning.area.max[1] + areaPad &&
    flight.position.z >= tuning.area.min[2] - areaPad &&
    flight.position.z <= tuning.area.max[2] + areaPad,
  `end=${flight.position.toArray().map((v) => v.toFixed(2)).join(", ")}`,
);
check(
  "never exceeds cruise speed",
  maxSpeed <= cruiseMax * 1.35,
  `max=${maxSpeed.toFixed(2)} cruise=${cruiseMax.toFixed(2)}`,
);
check(
  "no teleporting between frames",
  maxJump <= cruiseMax * dt * 4,
  `maxJump=${maxJump.toFixed(4)} per frame`,
);
check(
  // The cruise flutter makes the steering target itself breathe (bounded
  // ±18%), so the per-frame ceiling sits slightly above the pre-flutter
  // calibration. The steering model is unchanged exponential lerp; this
  // still guards against impulse-like jumps.
  "accelerates gently",
  maxAccel <= 3.4,
  `maxAccel=${maxAccel.toFixed(2)} u/s²`,
);
check("switches between idle and flying", transitions >= 4, `transitions=${transitions}`);
check("actually travelled", distance > 20, `distance=${distance.toFixed(1)} units`);
check("idle hover is near-stationary", Number.isFinite(minSpeedFlying));

// Interaction path: seekTo must deliver the butterfly to the requested point.
const goal = new Vector3(1.5, 2, -0.4);
flight.seekTo(goal.clone());
let arrived = false;
for (let i = 0; i < 60 * 30; i++) {
  const mode = flight.step(dt);
  if (flight.position.distanceTo(goal) < 0.35 && mode === "idle") {
    arrived = true;
    break;
  }
}
check("seekTo reaches the requested point and settles", arrived, `dist=${flight.position.distanceTo(goal).toFixed(3)}`);

// A behavior profile (Phase 12.1/12.2) tunes how intensely the butterfly
// reacts; it must never change *where* an explicit request takes it.
{
  const profile = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(7));
  profile.setBehaviorProfile({
    ...DEFAULT_BEHAVIOR_PROFILE,
    noticeRadius: 3,
    curiosityDrift: 0.16,
    attentionYaw: 0.7,
    restScale: 0.7,
    hopScale: 1.4,
    speedScale: 1.15,
    weaveScale: 1.15,
  });
  check(
    "setBehaviorProfile stores the profile it was given",
    profile.behaviorProfile.speedScale === 1.15 &&
      profile.behaviorProfile.hopScale === 1.4,
  );
  const asked = new Vector3(1.5, 2, -0.4);
  profile.seekTo(asked.clone());
  let reached = false;
  for (let i = 0; i < 60 * 30; i++) {
    const mode = profile.step(dt);
    if (profile.position.distanceTo(asked) < 0.35 && mode === "idle") {
      reached = true;
      break;
    }
  }
  check(
    "seekTo still delivers under a tuned profile",
    reached,
    `dist=${profile.position.distanceTo(asked).toFixed(3)}`,
  );
}

// Phase 12.3: a profile change must be *felt* by the leg or rest already in
// progress — otherwise personality only becomes visible seconds later, once
// the next leg happens to be sampled.
{
  const runSeek = (profile) => {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(31));
    if (profile) f.setBehaviorProfile(profile);
    const goal = new Vector3(-1.8, 2.1, 0.3);
    f.seekTo(goal.clone());
    const from = f.position.clone();
    let maxSpeed = 0;
    let maxDeviation = 0;
    for (let i = 0; i < 60 * 2; i++) {
      f.step(dt);
      maxSpeed = Math.max(maxSpeed, f.velocity.length());
      // Perpendicular deviation from the straight start->goal line: the weave.
      const along = from.clone().sub(goal).normalize();
      maxDeviation = Math.max(maxDeviation, Math.abs(f.position.clone().sub(from).cross(along).length()));
    }
    return { maxSpeed, maxDeviation };
  };

  const base = runSeek(null);
  const lively = runSeek({ ...DEFAULT_BEHAVIOR_PROFILE, speedScale: 1.18, weaveScale: 1.3 });
  check(
    "speedScale applies to the leg in progress",
    lively.maxSpeed > base.maxSpeed * 1.1,
    `${base.maxSpeed.toFixed(2)} -> ${lively.maxSpeed.toFixed(2)}`,
  );
  check(
    "weaveScale applies to the leg in progress",
    lively.maxDeviation > base.maxDeviation * 1.15,
    `${base.maxDeviation.toFixed(3)} -> ${lively.maxDeviation.toFixed(3)}`,
  );

  // Rest rhythm: the remaining rest is rescaled when the state changes, so a
  // restless state visibly interrupts a long sit.
  const firstRest = (restScale) => {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(12));
    if (restScale !== 1) f.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, restScale });
    let steps = 0;
    while (steps < 60 * 120 && f.mode !== "idle") {
      f.step(dt);
      steps++;
    }
    // Only the rest itself counts, not the flight that led into it.
    let rested = 0;
    while (rested < 60 * 120 && f.mode === "idle") {
      f.step(dt);
      rested++;
    }
    return rested / 60;
  };
  const calmRest = firstRest(1);
  const shyRest = firstRest(1.4);
  check(
    "restScale shapes the resting rhythm",
    shyRest > calmRest * 1.2,
    `${calmRest.toFixed(1)}s -> ${shyRest.toFixed(1)}s`,
  );

  // ...and a mid-rest change shortens what is left of the current sit.
  const midRest = () => {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(12));
    while (f.mode !== "idle") f.step(dt);
    const impatient = { ...DEFAULT_BEHAVIOR_PROFILE, restScale: 0.4 };
    let remaining = 0;
    while (f.mode === "idle") {
      f.step(dt);
      remaining++;
    }
    // Same controller, same seed, but the state flips halfway through rest.
    const g = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(12));
    while (g.mode !== "idle") g.step(dt);
    let switched = 0;
    while (g.mode === "idle") {
      g.step(dt);
      switched++;
      if (switched === Math.floor(remaining / 2)) g.setBehaviorProfile(impatient);
    }
    return { remaining, switched };
  };
  const rest = midRest();
  check(
    "a mid-rest state change shortens the rest already in progress",
    rest.switched < rest.remaining * 0.8,
    `${(rest.remaining / 60).toFixed(1)}s untouched vs ${(rest.switched / 60).toFixed(1)}s after switching`,
  );
}

// --- Phase 13A.2: the environmental edge preference -------------------------
//
// It must stay a *preference*: fewer edge-adjacent destinations, never a fence.

check(
  "the reference profile has no edge preference at all",
  flight.behaviorProfile.edgeAversion === 0 &&
    DEFAULT_BEHAVIOR_PROFILE.edgeAversion === 0,
);

/**
 * Samples autonomous destinations over long runs: how close to the nearest
 * reachable boundary does the butterfly *choose* to end up?
 *
 * Averaged over several seeds, because each run is a different random walk and
 * a single seed's average says more about the walk than about the preference.
 */
const edgeSampling = (edgeAversion, seeds = [11, 4242, 90210, 5150, 8675309, 271828, 31415, 161803]) => {
  const spanX = tuning.area.max[0] - tuning.area.min[0];
  const spanY = tuning.area.max[1] - tuning.area.min[1];
  const samples = [];
  for (const seed of seeds) {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(seed));
    if (edgeAversion !== 0) {
      f.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion });
    }
    let previous = f.position.clone();
    for (let i = 0; i < 60 * 600; i++) {
      f.step(dt);
      // A new leg starts whenever the destination is one we have not sampled.
      if (f.mode === "flying" && f.target.distanceTo(previous) > 1e-6) {
        previous.copy(f.target);
        const depthX = Math.min(
          Math.max((f.target.x - tuning.area.min[0]) / spanX, 0),
          Math.max((tuning.area.max[0] - f.target.x) / spanX, 0),
        );
        const depthY = Math.min(
          Math.max((f.target.y - tuning.area.min[1]) / spanY, 0),
          Math.max((tuning.area.max[1] - f.target.y) / spanY, 0),
        );
        samples.push(Math.min(depthX, depthY));
      }
    }
  }
  return samples;
};

// Test 2 — the preference never becomes a boundary.
{
  const strong = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(7));
  strong.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion: 1 });
  let inArea = true;
  let finite = true;
  for (let i = 0; i < 60 * 300; i++) {
    strong.step(dt);
    const p = strong.position;
    finite &&= Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
    inArea &&=
      p.x >= tuning.area.min[0] - areaPad &&
      p.x <= tuning.area.max[0] + areaPad &&
      p.y >= tuning.area.min[1] - areaPad &&
      p.y <= tuning.area.max[1] + areaPad &&
      p.z >= tuning.area.min[2] - areaPad &&
      p.z <= tuning.area.max[2] + areaPad;
  }
  check("a strong edge preference still stays inside the flight area", inArea && finite);
  check(
    "the flight area itself is unchanged by the preference",
    strong.area.min[0] === tuning.area.min[0] &&
      strong.area.max[0] === tuning.area.max[0] &&
      strong.area.min[1] === tuning.area.min[1] &&
      strong.area.max[1] === tuning.area.max[1],
  );
}

// Test 3 + 4 — bias direction and monotonicity, over many samples.
//
// The measured quantity is the share of autonomous destinations that come to
// rest pressed against the reachable boundary, because that is precisely what
// the preference acts on; the mean depth is reported alongside as context.
{
  const summarise = (samples) => {
    const pressed = samples.filter((v) => v < 0.05).length;
    return {
      pressed: pressed / Math.max(1, samples.length),
      depth: samples.reduce((sum, v) => sum + v, 0) / Math.max(1, samples.length),
      count: samples.length,
    };
  };
  const none = summarise(edgeSampling(0));
  const low = summarise(edgeSampling(0.12)); // playful
  const medium = summarise(edgeSampling(0.25)); // calm
  const high = summarise(edgeSampling(0.6)); // shy
  check(
    "edge aversion never makes edge-pressed destinations more likely",
    low.pressed <= none.pressed + 0.03 && high.pressed < none.pressed,
    `edge-pressed share: none=${(none.pressed * 100).toFixed(1)}% playful=${(low.pressed * 100).toFixed(1)}% calm=${(medium.pressed * 100).toFixed(1)}% shy=${(high.pressed * 100).toFixed(1)}%`,
  );
  check(
    "the preference is clearly measurable once a state cares about the edge",
    medium.pressed <= none.pressed - 0.03 && high.pressed <= medium.pressed - 0.03,
    `calm ${(medium.pressed * 100).toFixed(1)}% <= shy ${(high.pressed * 100).toFixed(1)}% vs none ${(none.pressed * 100).toFixed(1)}%`,
  );
  check(
    "average distance from the nearest reachable edge grows",
    high.depth > none.depth,
    `mean depth none=${none.depth.toFixed(4)} shy=${high.depth.toFixed(4)} (n=${high.count})`,
  );

  // Edge-adjacent destinations stay possible — a preference, not a fence.
  const strongSamples = edgeSampling(1.5);
  const pressed = strongSamples.filter((v) => v < 0.05).length;
  check(
    "edge-adjacent destinations remain reachable (bias, not clamp)",
    pressed > 0,
    `${pressed}/${strongSamples.length} samples still land within 5% of the edge`,
  );
  // ...and the preference must never make hops longer or more theatrical: the
  // leg bands, cadence and glide are untouched, so the mean leg may only get
  // *shorter* (boundary-clamped candidates are the ones being re-drawn).
  const legStats = (edgeAversion) => {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(99));
    f.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion });
    let legs = 0;
    let total = 0;
    let from = f.position.clone();
    for (let i = 0; i < 60 * 400; i++) {
      f.step(dt);
      if (f.mode === "flying" && f.target.distanceTo(from) > 1e-6) {
        total += f.target.distanceTo(from);
        legs++;
        from.copy(f.target);
      }
    }
    return { mean: legs ? total / legs : 0, legs };
  };
  const plain = legStats(0);
  const averse = legStats(0.8);
  check(
    "hop length never grows (local-hop character preserved)",
    averse.mean <= plain.mean * 1.02,
    `${plain.mean.toFixed(2)} -> ${averse.mean.toFixed(2)} world units mean leg`,
  );
  check(
    "hop cadence stays in the same league",
    Math.abs(averse.legs - plain.legs) / plain.legs < 0.25,
    `${plain.legs} -> ${averse.legs} legs over 400s`,
  );
}

// Test 5 — an explicit target outranks the preference completely.
{
  const explicit = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
  explicit.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion: 1 });
  // A target pressed against the reachable boundary, exactly what the
  // preference would avoid on its own.
  const edgeGoal = new Vector3(
    tuning.area.max[0] - 0.02,
    tuning.area.min[1] + 0.02,
    0,
  );
  const started = explicit.seekTo(edgeGoal.clone());
  let arrived = false;
  for (let i = 0; i < 60 * 40; i++) {
    const mode = explicit.step(dt);
    if (explicit.position.distanceTo(edgeGoal) < 0.35 && mode === "idle") {
      arrived = true;
      break;
    }
  }
  check(
    "seekTo still delivers to an edge-adjacent explicit target",
    started && arrived,
    `dist=${explicit.position.distanceTo(edgeGoal).toFixed(3)}`,
  );
  // And the live pointer target is likewise never nudged.
  const live = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(22));
  live.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion: 1 });
  const pointer = new Vector3(tuning.area.max[0] - 0.05, tuning.area.min[1] + 0.05, 0);
  live.seekTo(pointer.clone());
  live.aimAt(pointer);
  let tracked = false;
  for (let i = 0; i < 60 * 3; i++) {
    live.step(dt);
    if (live.userTarget && live.userTarget.distanceTo(pointer) < 0.36) tracked = true;
  }
  check("a live pointer target is never pulled inward", tracked);
}

// --- Phase 13B.2: the foreground-window preference --------------------------
//
// A weak pull toward the window the user is working in — and nothing else.
{
  const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
  // A window covering the left half of the reachable volume.
  const bounds = {
    minX: -3.0,
    maxX: -0.2,
    minY: 0.5,
    maxY: 2.8,
  };

  check(
    "the reference profile has no foreground preference",
    flight.behaviorProfile.foregroundAffinity === 0 &&
      DEFAULT_BEHAVIOR_PROFILE.foregroundAffinity === 0,
  );

  /** Share of autonomous destinations that land inside the window's box. */
  const insideShare = (affinity, withBounds) => {
    let inside = 0;
    let legs = 0;
    for (const seed of [11, 4242, 90210, 5150, 8675309]) {
      const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(seed));
      if (affinity !== 0 || withBounds) {
        f.setBehaviorProfile({
          ...DEFAULT_BEHAVIOR_PROFILE,
          foregroundAffinity: affinity,
        });
      }
      if (withBounds) f.setForegroundBounds(bounds);
      let from = f.position.clone();
      for (let i = 0; i < 60 * 600; i++) {
        f.step(dt);
        if (f.mode === "flying" && f.target.distanceTo(from) > 1e-6) {
          legs++;
          const p = f.target;
          if (p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY) {
            inside++;
          }
          from.copy(p);
        }
      }
    }
    return inside / Math.max(1, legs);
  };

  // 1 + 2: without a window nothing changes; with one, the pull is observable.
  const neutral = insideShare(0, false);
  const windowNoAffinity = insideShare(0, true);
  const attracted = insideShare(0.6, true);
  check(
    "with no foreground window the behaviour is the baseline",
    near(neutral, insideShare(0, false)) && neutral > 0,
    `share inside=${(neutral * 100).toFixed(1)}%`,
  );
  check(
    "a window alone changes nothing without a preference",
    near(windowNoAffinity, neutral),
    `${(neutral * 100).toFixed(1)}% -> ${(windowNoAffinity * 100).toFixed(1)}%`,
  );
  check(
    "the preference measurably favours destinations inside the window",
    attracted > windowNoAffinity + 0.03,
    `${(windowNoAffinity * 100).toFixed(1)}% -> ${(attracted * 100).toFixed(1)}%`,
  );

  // 6: it is a preference, not a fence — leaving stays possible.
  check(
    "leaving the window remains possible (bias, not a wall)",
    attracted < 0.95,
    `${(attracted * 100).toFixed(1)}% of destinations still land outside`,
  );

  // 7 + 9: with no window the preference has *no* effect at all — proven by exact
  // equality rather than by statistics — and a withdrawn window returns the
  // butterfly to the neutral distribution.
  {
    // Exact: a strong preference with no window behaves identically to the
    // reference profile, walk for walk.
    const trace = (affinity) => {
      const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(11));
      if (affinity !== 0) {
        f.setBehaviorProfile({ ...DEFAULT_BEHAVIOR_PROFILE, foregroundAffinity: affinity });
      }
      const path = [];
      for (let i = 0; i < 60 * 300; i++) {
        f.step(dt);
        if (i % 300 === 0) path.push(f.position.toArray().map((v) => v.toFixed(6)).join(","));
      }
      return path.join("|");
    };
    check(
      "a preference with no window is exactly the reference behaviour",
      trace(1) === trace(0),
    );

    // Recovery: after the window goes away the distribution comes back.
    const shareAfterWithdrawal = (() => {
      let inside = 0;
      let legs = 0;
      for (const seed of [11, 4242, 90210, 5150, 8675309]) {
        const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(seed));
        f.setBehaviorProfile({
          ...DEFAULT_BEHAVIOR_PROFILE,
          foregroundAffinity: 0.6,
        });
        f.setForegroundBounds(bounds);
        for (let i = 0; i < 60 * 120; i++) f.step(dt);
        f.setForegroundBounds(null);
        for (let i = 0; i < 60 * 120; i++) f.step(dt);
        let from = f.position.clone();
        for (let i = 0; i < 60 * 600; i++) {
          f.step(dt);
          if (f.mode === "flying" && f.target.distanceTo(from) > 1e-6) {
            legs++;
            const p = f.target;
            if (
              p.x >= bounds.minX &&
              p.x <= bounds.maxX &&
              p.y >= bounds.minY &&
              p.y <= bounds.maxY
            ) {
              inside++;
            }
            from.copy(p);
          }
        }
      }
      return inside / Math.max(1, legs);
    })();
    check(
      "a withdrawn window returns the destination distribution to neutral",
      Math.abs(shareAfterWithdrawal - neutral) < 0.05,
      `neutral=${(neutral * 100).toFixed(1)}% after-withdrawal=${(shareAfterWithdrawal * 100).toFixed(1)}%`,
    );
  }

  // 3: explicit targets are untouched by the preference.
  {
    const explicit = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
    explicit.setBehaviorProfile({
      ...DEFAULT_BEHAVIOR_PROFILE,
      foregroundAffinity: 1,
    });
    explicit.setForegroundBounds(bounds);
    // A destination far outside the preferred box, in the corner of the area.
    const goal = new Vector3(tuning.area.max[0] - 0.3, tuning.area.min[1] + 0.2, 0);
    const started = explicit.seekTo(goal.clone());
    let arrived = false;
    for (let i = 0; i < 60 * 40; i++) {
      const mode = explicit.step(dt);
      if (explicit.position.distanceTo(goal) < 0.35 && mode === "idle") {
        arrived = true;
        break;
      }
    }
    check(
      "an explicit target outside the window is still delivered",
      started && arrived,
      `dist=${explicit.position.distanceTo(goal).toFixed(3)}`,
    );
  }

  // 4 + 5: cursor presence and the shy hop are untouched — they never go
  // through the autonomous chooser at all.
  {
    const shy = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(77));
    shy.setBehaviorProfile({
      ...DEFAULT_BEHAVIOR_PROFILE,
      foregroundAffinity: 1,
    });
    shy.setForegroundBounds(bounds);
    // Park a presence right on top of it and let it settle into the hover.
    for (let i = 0; i < 60 * 8; i++) shy.step(dt);
    shy.notice(shy.position.clone().add(new Vector3(0.05, 0, 0)));
    let hopped = false;
    for (let i = 0; i < 60 * 12; i++) {
      shy.step(dt);
      if (shy.mode === "flying") {
        hopped = true;
        break;
      }
    }
    check("a crowding presence still triggers the shy hop", hopped);
  }

  // 10: determinism — the same seed and preference give the same walk.
  {
    const run = () => {
      const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(31337));
      f.setBehaviorProfile({
        ...DEFAULT_BEHAVIOR_PROFILE,
        foregroundAffinity: 0.4,
      });
      f.setForegroundBounds(bounds);
      const path = [];
      for (let i = 0; i < 60 * 120; i++) {
        f.step(dt);
        if (i % 600 === 0) path.push(f.position.toArray().map((v) => v.toFixed(6)).join(","));
      }
      return path.join("|");
    };
    check("the preference keeps the simulation deterministic", run() === run());
  }
}

// Seek outside the roaming area must be clamped, not followed out of bounds.
const outside = new Vector3(50, 50, 50);
flight.seekTo(outside);
for (let i = 0; i < 60 * 30; i++) flight.step(dt);
check(
  "clamps destinations outside the area",
  flight.position.x <= tuning.area.max[0] + areaPad &&
    flight.position.y <= tuning.area.max[1] + areaPad &&
    flight.position.z <= tuning.area.max[2] + areaPad,
  `end=${flight.position.toArray().map((v) => v.toFixed(2)).join(", ")}`,
);

// A later click must interrupt and retarget a flight already in progress.
{
  const retarget = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(99));
  const first = new Vector3(-1.8, 2.4, -0.4);
  const second = new Vector3(1.7, 1.1, 0.4);
  retarget.seekTo(first.clone());
  for (let i = 0; i < 60 * 2; i++) retarget.step(dt); // commit to the first leg
  retarget.seekTo(second.clone());
  let retargeted = false;
  for (let i = 0; i < 60 * 30; i++) {
    const mode = retarget.step(dt);
    if (mode === "idle" && retarget.position.distanceTo(second) < 0.45) {
      retargeted = true;
      break;
    }
  }
  check(
    "a later click retargets a flight in progress",
    retargeted,
    `dist to second target=${retarget.position.distanceTo(second).toFixed(2)}`,
  );
}

// The pointer is a live target: a parked pointer far away must draw the
// butterfly across the area (no local confinement), and once the pointer
// leaves, free wandering resumes.
{
  const chase = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(7));
  for (let i = 0; i < 60 * 20 && chase.mode !== "idle"; i++) chase.step(dt);

  // Park the pointer at the area corner FARTHEST from wherever the butterfly
  // has wandered to: the draw across the airspace is then as long as the
  // area allows, regardless of the seed's wander history.
  const parked = new Vector3(
    chase.position.x < (tuning.area.min[0] + tuning.area.max[0]) / 2
      ? tuning.area.max[0]
      : tuning.area.min[0],
    chase.position.y < (tuning.area.min[1] + tuning.area.max[1]) / 2
      ? tuning.area.max[1]
      : tuning.area.min[1],
    chase.position.z < (tuning.area.min[2] + tuning.area.max[2]) / 2
      ? tuning.area.max[2]
      : tuning.area.min[2],
  );
  chase.aimAt(parked.clone());
  let travel = 0;
  let settledNear = false;
  const previousChase = new Vector3().copy(chase.position);
  for (let i = 0; i < 60 * 30; i++) {
    const mode = chase.step(dt);
    travel += chase.position.distanceTo(previousChase);
    previousChase.copy(chase.position);
    if (mode === "idle" && chase.position.distanceTo(parked) < 0.5) {
      settledNear = true;
      break;
    }
  }
  check(
    "a parked pointer draws the butterfly across the area",
    travel > 2 && settledNear,
    `travel=${travel.toFixed(1)} dist=${chase.position.distanceTo(parked).toFixed(2)}`,
  );

  chase.aimAt(null);
  let wanderTravel = 0;
  let takeoffs = 0;
  let lastMode = chase.mode;
  const previousWander = new Vector3().copy(chase.position);
  for (let i = 0; i < 60 * 30; i++) {
    const mode = chase.step(dt);
    wanderTravel += chase.position.distanceTo(previousWander);
    if (mode !== lastMode && mode === "flying") takeoffs++;
    lastMode = mode;
    previousWander.copy(chase.position);
  }
  check(
    "wandering resumes once the pointer leaves",
    wanderTravel >= 4 && takeoffs >= 2,
    `travel=${wanderTravel.toFixed(1)} takeoffs=${takeoffs} in 30s`,
  );
}

// A moving pointer redirects a flight in progress: the live target is
// re-aimed every frame instead of waiting for the leg to finish.
{
  const redirect = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
  redirect.aimAt(new Vector3(tuning.area.min[0], 2.0, 0));
  for (let i = 0; i < 60 * 2; i++) redirect.step(dt); // commit to the left leg
  const swing = new Vector3(tuning.area.max[0], tuning.area.min[1], tuning.area.max[2]);
  redirect.aimAt(swing.clone()); // the user swings the mouse to the far side
  let redirected = false;
  for (let i = 0; i < 60 * 30; i++) {
    const mode = redirect.step(dt);
    if (mode === "idle" && redirect.position.distanceTo(swing) < 0.5) {
      redirected = true;
      break;
    }
  }
  check(
    "a moving pointer redirects the butterfly mid-flight",
    redirected,
    `dist to far side=${redirect.position.distanceTo(swing).toFixed(2)}`,
  );
}

// Flights curve: a long leg must deviate visibly from a straight line (the
// weave is layered onto the seek direction, not a pre-baked path).
{
  const curve = new FlightController(tuning, new Vector3(-1.8, 1.0, -0.3), mulberry32(3));
  const goal = new Vector3(1.6, 2.4, 0.3);
  curve.seekTo(goal.clone());
  const startPos = curve.position.clone();
  const samples = [];
  for (let i = 0; i < 60 * 25; i++) {
    curve.step(dt);
    if (i % 3 === 0) samples.push(curve.position.clone());
    if (curve.mode === "idle") break;
  }
  const chord = goal.clone().sub(startPos);
  const chordLen = chord.length();
  let maxDev = 0;
  for (const p of samples) {
    const v = p.clone().sub(startPos);
    const along = v.dot(chord) / chordLen;
    if (along <= 0.3 || along >= chordLen - 0.3) continue; // ignore take-off/settle
    const perp = Math.sqrt(Math.max(0, v.lengthSq() - along * along));
    maxDev = Math.max(maxDev, perp);
  }
  check(
    "long flights curve instead of sliding in a straight line",
    maxDev > 0.12,
    `maxDeviation=${maxDev.toFixed(2)} over ${chordLen.toFixed(1)} units`,
  );
}

// Flight must keep moving from take-off to arrival: no mid-air stall and no
// stop tied to an animation duration (velocity stays positive throughout).
{
  const flow = new FlightController(tuning, new Vector3(-1.8, 1.0, -0.3), mulberry32(11));
  const goal = new Vector3(1.6, 2.4, 0.3);
  flow.seekTo(goal.clone());
  let minSpeed = Infinity;
  let settled = false;
  for (let i = 0; i < 60 * 30; i++) {
    flow.step(dt);
    if (flow.mode === "idle") {
      settled = true;
      break;
    }
    if (i > 45 && flow.position.distanceTo(goal) > tuning.arriveRadius * 2) {
      minSpeed = Math.min(minSpeed, flow.velocity.length());
    }
  }
  check(
    "flight keeps moving until arrival (no mid-air stall)",
    settled && minSpeed > 0.08,
    `minSpeed=${minSpeed.toFixed(2)} settled=${settled}`,
  );
}

// Every corner of the flight area is reachable: the flight environment spans
// the whole airspace, not a small region around the spawn point.
{
  const wide = new FlightController(tuning, new Vector3(0, 1.6, 0), mulberry32(5));
  const corners = [
    [tuning.area.min[0], tuning.area.min[1]],
    [tuning.area.min[0], tuning.area.max[1]],
    [tuning.area.max[0], tuning.area.min[1]],
    [tuning.area.max[0], tuning.area.max[1]],
  ];
  let reached = 0;
  for (const [x, y] of corners) {
    const goal = new Vector3(x, y, 0);
    wide.seekTo(goal.clone());
    for (let i = 0; i < 60 * 25 && wide.mode !== "idle"; i++) wide.step(dt);
    if (wide.position.distanceTo(goal) < 0.55) reached++;
  }
  check("travels to every corner of the flight area", reached === 4, `reached=${reached}/4`);
}

// --- Living behaviour ------------------------------------------------------

/** Angle between the butterfly's facing (yaw) and the direction to a point. */
const angleTo = (yaw, point, from) => {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const dx = point.x - from.x;
  const dz = point.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (fx * dx + fz * dz) / len)));
};

// Autonomous life: hops stay local, varied, and inside the flight area.
{
  const local = new FlightController(tuning, new Vector3(0, 1.6, 0), mulberry32(31));
  const legs = [];
  let legStart = null;
  let lastMode = local.mode;
  let inArea = true;
  for (let i = 0; i < 60 * 90; i++) {
    const mode = local.step(dt);
    if (mode !== lastMode && mode === "flying") legStart = local.position.clone();
    if (mode !== lastMode && mode === "idle" && legStart) {
      legs.push(local.position.distanceTo(legStart));
      legStart = null;
    }
    lastMode = mode;
    const { min, max } = tuning.area;
    if (
      local.position.x < min[0] - 0.05 || local.position.x > max[0] + 0.05 ||
      local.position.y < min[1] - 0.05 || local.position.y > max[1] + 0.05 ||
      local.position.z < min[2] - 0.05 || local.position.z > max[2] + 0.05
    ) {
      inArea = false;
    }
  }
  legs.sort((a, b) => a - b);
  const median = legs[Math.floor(legs.length / 2)] ?? Infinity;
  const longest = legs[legs.length - 1] ?? 0;
  check(
    "autonomous hops are local and varied",
    legs.length >= 8 && median < 2.6 && longest > 1.2,
    `legs=${legs.length} median=${median.toFixed(2)} longest=${longest.toFixed(2)}`,
  );
  check("autonomous flight stays inside the flight area", inArea);
}

// The resting rhythm mixes quick pauses (active spells) and long rests.
// Probabilities are per-rest, so several seeded runs are aggregated to keep
// the check robust instead of lucky.
{
  const rests = [];
  for (const seed of [42, 7, 99]) {
    const rhythm = new FlightController(tuning, new Vector3(0, 1.6, 0), mulberry32(seed));
    let restStart = null;
    let lastMode = rhythm.mode;
    for (let i = 0; i < 60 * 120; i++) {
      const mode = rhythm.step(dt);
      if (mode !== lastMode && mode === "idle") restStart = i * dt;
      if (mode !== lastMode && mode === "flying" && restStart != null) {
        rests.push(i * dt - restStart);
        restStart = null;
      }
      lastMode = mode;
    }
  }
  const minRest = Math.min(...rests);
  const maxRest = Math.max(...rests);
  check(
    "the resting rhythm mixes quick pauses and long rests",
    rests.length >= 20 && minRest < 1.2 && maxRest > 5,
    `rests=${rests.length} min=${minRest.toFixed(2)}s max=${maxRest.toFixed(2)}s`,
  );
}

// A far presence (beyond the notice radius) is simply ignored.
{
  const calm = new FlightController(tuning, new Vector3(0, 1.6, 0), mulberry32(8));
  const home = new Vector3(tuning.area.min[0], 1.6, 0);
  calm.seekTo(home.clone());
  for (let i = 0; i < 60 * 20 && calm.mode !== "idle"; i++) calm.step(dt);
  calm.notice(new Vector3(tuning.area.max[0], tuning.area.max[1], tuning.area.max[2]));
  const from = calm.position.clone();
  let stayedIdle = true;
  for (let i = 0; i < 60 * 4; i++) if (calm.step(dt) !== "idle") stayedIdle = false;
  check(
    "a far presence is ignored",
    stayedIdle && calm.position.distanceTo(from) < 0.6,
    `drift=${calm.position.distanceTo(from).toFixed(2)}`,
  );
}

// A near presence earns gentle attention — a drift and a turn, never a
// chase. Isolated by comparing two identical seeded runs, with and without
// the presence: any divergence is the presence's doing alone.
{
  const guest = new Vector3(-1.2, 1.9, 0);
  const spawn = () => {
    const f = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(9));
    f.seekTo(new Vector3(0, 1.6, 0));
    for (let i = 0; i < 60 * 20 && f.mode !== "idle"; i++) f.step(dt);
    return f;
  };
  const watched = spawn();
  const unwatched = spawn();
  watched.notice(guest.clone());
  const yawBefore = angleTo(watched.euler.y, guest, watched.position);
  let observed = 0;
  for (let i = 0; i < 60 * 4; i++) {
    if (watched.step(dt) !== "idle") break; // its own rhythm took over — fine
    unwatched.step(dt);
    observed += dt;
  }
  const distWatched = watched.position.distanceTo(guest);
  const distUnwatched = unwatched.position.distanceTo(guest);
  const yawAfter = angleTo(watched.euler.y, guest, watched.position);
  check(
    "a near presence earns gentle attention, not a chase",
    observed >= 1 &&
      distWatched < distUnwatched - 0.05 &&
      yawAfter < yawBefore - 0.15,
    `observed=${observed.toFixed(1)}s dist=${distWatched.toFixed(2)} vs ${distUnwatched.toFixed(2)} ` +
      `yaw=${yawBefore.toFixed(2)}->${yawAfter.toFixed(2)}`,
  );
}

// A crowding presence (cursor right on top of it) triggers a shy hop away.
{
  const shy = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(12));
  for (let i = 0; i < 60 * 30 && shy.mode !== "idle"; i++) shy.step(dt);
  const crowd = shy.position.clone();
  shy.notice(crowd);
  let hopped = false;
  for (let i = 0; i < 60 * 3; i++) {
    if (shy.step(dt) === "flying") {
      hopped = true;
      break;
    }
  }
  check("a crowding presence makes it hop away", hopped);
  for (let i = 0; i < 60 * 8 && shy.mode !== "idle"; i++) shy.step(dt);
  check(
    "the shy hop opens distance",
    shy.position.distanceTo(crowd) > 0.5,
    `distance=${shy.position.distanceTo(crowd).toFixed(2)}`,
  );
}

// Priority: a crowding presence mid-flight never redirects a directed flight.
{
  const loyal = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(13));
  const goal = new Vector3(1.6, 2.4, 0.3);
  loyal.seekTo(goal.clone());
  for (let i = 0; i < 60 * 1.5; i++) loyal.step(dt);
  loyal.notice(loyal.position.clone());
  let arrived = false;
  for (let i = 0; i < 60 * 30; i++) {
    const mode = loyal.step(dt);
    if (mode === "idle" && loyal.position.distanceTo(goal) < 0.35) {
      arrived = true;
      break;
    }
  }
  check(
    "presence never interrupts a directed flight",
    arrived,
    `dist to goal=${loyal.position.distanceTo(goal).toFixed(2)}`,
  );
}

// --- Phase 14: familiarity-adjusted profiles keep every interaction guarantee ---
//
// The companion's memory may slightly adjust a profile's numbers (via
// applyFamiliarity), but the *shape* of every interaction must survive the
// strongest adjustment. These mirror the reference checks above with an
// "attached" profile applied.
{
  const attachedCalm = applyFamiliarity(PERSONALITY_PRESETS.calm, "attached");
  const attachedShy = applyFamiliarity(PERSONALITY_PRESETS.shy, "attached");

  // An explicit target is still delivered exactly.
  {
    const f = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(15));
    f.setBehaviorProfile(attachedCalm);
    const goal = new Vector3(tuning.area.max[0] - 0.3, tuning.area.max[1] - 0.3, 0);
    const started = f.seekTo(goal.clone());
    let arrived = false;
    for (let i = 0; i < 60 * 40; i++) {
      const mode = f.step(dt);
      if (mode === "idle" && f.position.distanceTo(goal) < 0.35) {
        arrived = true;
        break;
      }
    }
    check(
      "an explicit target is delivered unchanged at full familiarity",
      started && arrived,
      `dist=${f.position.distanceTo(goal).toFixed(3)}`,
    );
  }

  // A crowding presence still earns a shy hop, never a chase.
  {
    const shy = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(16));
    shy.setBehaviorProfile(attachedShy);
    for (let i = 0; i < 60 * 30 && shy.mode !== "idle"; i++) shy.step(dt);
    shy.notice(shy.position.clone());
    let hopped = false;
    for (let i = 0; i < 60 * 5; i++) {
      if (shy.step(dt) === "flying") {
        hopped = true;
        break;
      }
    }
    check("the shy hop stays functional at full familiarity", hopped);
  }

  // A near presence still earns attention, not a chase.
  {
    const guest = new Vector3(-1.2, 1.9, 0);
    const spawn = () => {
      const f = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(17));
      f.setBehaviorProfile(attachedCalm);
      f.seekTo(new Vector3(0, 1.6, 0));
      for (let i = 0; i < 60 * 20 && f.mode !== "idle"; i++) f.step(dt);
      return f;
    };
    const watched = spawn();
    const unwatched = spawn();
    watched.notice(guest.clone());
    const yawBefore = angleTo(watched.euler.y, guest, watched.position);
    let observed = 0;
    for (let i = 0; i < 60 * 4; i++) {
      if (watched.step(dt) !== "idle") break;
      unwatched.step(dt);
      observed += dt;
    }
    const distWatched = watched.position.distanceTo(guest);
    const distUnwatched = unwatched.position.distanceTo(guest);
    const yawAfter = angleTo(watched.euler.y, guest, watched.position);
    check(
      "a near presence earns attention, not a chase, at full familiarity",
      observed >= 1 &&
        distWatched < distUnwatched - 0.05 &&
        yawAfter < yawBefore - 0.15,
      `observed=${observed.toFixed(1)}s dist=${distWatched.toFixed(2)} vs ${distUnwatched.toFixed(2)} yaw=${yawBefore.toFixed(2)}->${yawAfter.toFixed(2)}`,
    );
  }

  // And a presence mid-flight still never redirects a directed flight.
  {
    const loyal = new FlightController(tuning, new Vector3(-1.5, 1.0, -0.3), mulberry32(18));
    loyal.setBehaviorProfile(attachedCalm);
    const goal = new Vector3(1.6, 2.4, 0.3);
    loyal.seekTo(goal.clone());
    for (let i = 0; i < 60 * 1.5; i++) loyal.step(dt);
    loyal.notice(loyal.position.clone());
    let arrived = false;
    for (let i = 0; i < 60 * 30; i++) {
      const mode = loyal.step(dt);
      if (mode === "idle" && loyal.position.distanceTo(goal) < 0.35) {
        arrived = true;
        break;
      }
    }
    check(
      "presence never interrupts a directed flight at full familiarity",
      arrived,
      `dist to goal=${loyal.position.distanceTo(goal).toFixed(2)}`,
    );
  }
}

// --- Phase 15.4 fix: the live cursor target vs a flower's explicit target ----
//
// The garden flower bug, pinned at the mechanism level. `trackLiveTarget`
// overwrites the override target with the live cursor target *every frame*
// while the live target is armed — invisible on the web (where click point ==
// cursor point), but fatal to a flower target that differs from the cursor.
// The fix disarms the live target before seeking and holds it off until the
// explicit flight completes; `userTarget` is the completion signal.
{
  const cursor = new Vector3(1.5, 1.6, 0.5);
  // A flower investigation point inside the flight area (real ones are
  // clamped by seekTo like any target — that is intended, so test inside).
  const flower = new Vector3(-1.2, 1.9, 0);

  // The bug: with the live target armed, a flower seekTo is overwritten on
  // the very next frame.
  {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
    f.aimAt(cursor.clone());
    f.step(dt);
    f.seekTo(flower.clone());
    f.step(dt);
    check(
      "an armed live target overwrites the flower target on the next frame (the bug)",
      f.target.distanceTo(cursor) < 0.01,
      `target=${f.target.toArray().map((v) => v.toFixed(2)).join(",")}`,
    );
  }

  // The fix: disarm the live target before seeking — the flower owns the
  // flight all the way to arrival.
  {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
    f.aimAt(cursor.clone());
    f.step(dt);
    f.aimAt(null);
    const started = f.seekTo(flower.clone());
    // The fix property: the flower stays the target frame after frame
    // (with the bug it was overwritten on the very next frame).
    let ownsEveryFrame = true;
    for (let i = 0; i < 30; i++) {
      f.step(dt);
      if (f.target.distanceTo(flower) > 0.01) ownsEveryFrame = false;
    }
    let arrived = false;
    for (let i = 0; i < 60 * 30; i++) {
      const mode = f.step(dt);
      if (mode === "idle" && f.position.distanceTo(flower) < 0.35) {
        arrived = true;
        break;
      }
    }
    check(
      "with the live target disarmed, the flower target owns the flight to arrival",
      started && ownsEveryFrame && arrived,
      `dist=${f.position.distanceTo(flower).toFixed(3)}`,
    );
  }

  // Why the latch is also needed: re-arming the live target mid-flight would
  // steal it again — so Interaction holds aimAt off until arrival.
  {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(21));
    f.aimAt(null);
    f.seekTo(flower.clone());
    f.step(dt);
    f.aimAt(cursor.clone());
    f.step(dt);
    check(
      "re-arming the live target mid-flight steals it again (why the latch exists)",
      f.target.distanceTo(cursor) < 0.01,
    );
  }

  // The release signal: userTarget is non-null exactly while an explicit
  // flight is in progress.
  {
    const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(22));
    f.seekTo(flower.clone());
    const duringFlight = f.userTarget !== null;
    let cleared = false;
    for (let i = 0; i < 60 * 30; i++) {
      f.step(dt);
      if (f.userTarget === null && f.mode === "idle") {
        cleared = true;
        break;
      }
    }
    check(
      "userTarget clears exactly on arrival (the latch release signal)",
      duringFlight && cleared,
    );
  }
}

// --- Phase 15.4 fix 2: a refused flower click exposes no flight signal -----------
//
// `seekTo` correctly refuses when the butterfly is already within
// `arriveRadius` of the target: no flight starts and — decisively for
// ownership — no completion signal exists afterwards. Flower ownership
// therefore cannot ride on `summoned`/`userTarget`; Interaction takes it
// unconditionally and `flowerOwnershipEnds` releases it on the bounded hold
// instead. This pins the controller-side fact that forces that design.
{
  const f = new FlightController(tuning, new Vector3(0, 1.4, 0), mulberry32(31));
  // A flower the butterfly already hovers at: inside arriveRadius (0.28).
  const started = f.seekTo(new Vector3(0.1, 1.45, 0));
  check(
    "a refused flower click starts no flight and exposes no completion signal",
    started === false && f.userTarget === null,
    `started=${started}`,
  );
}

// Arrival carries momentum into the hover: a glide-out, not a dead stop.
{
  const glider = new FlightController(tuning, new Vector3(-1.6, 1.0, -0.3), mulberry32(14));
  glider.seekTo(new Vector3(1.6, 2.2, 0.3));
  let preSettleVel = null;
  let settlePos = null;
  for (let i = 0; i < 60 * 30; i++) {
    const before = glider.velocity.clone();
    const mode = glider.step(dt);
    if (mode === "idle") {
      preSettleVel = before;
      settlePos = glider.position.clone();
      break;
    }
  }
  for (let i = 0; i < 60 * 0.4; i++) glider.step(dt);
  const carry = settlePos
    ? glider.position.clone().sub(settlePos).dot(preSettleVel.clone().normalize())
    : 0;
  check(
    "arrival glides out instead of stopping dead",
    carry > 0.02,
    `carry=${carry.toFixed(3)} units in 0.4s`,
  );
}

// Reduced motion: movement must be slower but still functional.
{
  const calm = new FlightController(
    { ...tuning, motionScale: 0.45 },
    new Vector3(0, 1.4, 0),
    mulberry32(12345),
  );
  let calmDistance = 0;
  let calmMaxSpeed = 0;
  const before = new Vector3();
  for (let i = 0; i < steps; i++) {
    calm.step(dt);
    calmMaxSpeed = Math.max(calmMaxSpeed, calm.velocity.length());
    calmDistance += calm.position.distanceTo(before);
    before.copy(calm.position);
  }
  check(
    "reduced motion slows movement",
    calmDistance < distance * 0.75 && calmMaxSpeed > 0,
    `calm=${calmDistance.toFixed(1)} vs normal=${distance.toFixed(1)} units`,
  );
}

console.log(
  `\nsummary: transitions=${transitions} travelled=${distance.toFixed(1)} maxSpeed=${maxSpeed.toFixed(2)} avgSpeed=${(distance / 120).toFixed(2)}`,
);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

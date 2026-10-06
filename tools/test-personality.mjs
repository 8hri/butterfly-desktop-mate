/**
 * Unit tests for the personality layer (dev only).
 *
 * The personality is deterministic by design: no randomness, so the same
 * event sequence always yields the same states. These checks pin the state
 * model, the attention accumulator, the transition rules and — critically —
 * that the reference (calm) state is behavior-identical to before the layer
 * existed.
 *
 * Usage: node tools/test-personality.mjs
 */
import { Personality, PERSONALITY_PRESETS, applyFamiliarity } from "../src/lib/personality.ts";
import { DEFAULT_BEHAVIOR_PROFILE } from "../src/lib/flight.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const dt = 1 / 60;
const run = (p, seconds, each = null) => {
  let profile = null;
  for (let i = 0; i < seconds * 60; i++) {
    if (each) each(i * dt, p);
    profile = p.step(dt);
  }
  return profile;
};

// --- The reference state is exactly the pre-personality behavior ---
// (Phase 13A.2: except for the environmental edge preference, which the calm
// preset now carries deliberately — see the Phase 13A.2 block below.)
{
  const withoutEdge = (profile) =>
    Object.keys(DEFAULT_BEHAVIOR_PROFILE)
      .filter((k) => k !== "edgeAversion" && k !== "foregroundAffinity")
      .every((k) => profile[k] === DEFAULT_BEHAVIOR_PROFILE[k]);

  const p = new Personality();
  check("starts calm", p.currentState === "calm");
  const profile = p.step(dt);
  check("calm profile equals the reference behavior", withoutEdge(profile));
  const presetSame = Object.keys(DEFAULT_BEHAVIOR_PROFILE)
    .filter((k) => k !== "edgeAversion" && k !== "foregroundAffinity")
    .every((k) => PERSONALITY_PRESETS.calm[k] === DEFAULT_BEHAVIOR_PROFILE[k]);
  check("calm preset equals the reference behavior", presetSame);
}

// --- Attention: proximity feeds slowly, clicks strongly, time decays ---
{
  const p = new Personality();
  p.onCursorProximity(1, dt);
  const afterOne = p.attentionLevel;
  check(
    "proximity feeds attention at low weight",
    afterOne > 0 && afterOne < 0.005,
    `${afterOne.toExponential(1)} per tick`,
  );
  p.onClick(true);
  check(
    "a near click feeds attention strongly",
    p.attentionLevel > afterOne + 0.2,
    `${p.attentionLevel.toFixed(2)}`,
  );
  const before = p.attentionLevel;
  run(p, 5);
  check(
    "attention decays over time",
    p.attentionLevel < before - 0.2,
    `${before.toFixed(2)} -> ${p.attentionLevel.toFixed(2)}`,
  );
}

// --- One click never changes the state (keeps harness scenarios stable) ---
{
  const p = new Personality();
  p.onClick(true);
  run(p, 3);
  check("a single click leaves the state calm", p.currentState === "calm");
}

// --- Sustained proximity turns the butterfly curious ---
{
  const p = new Personality();
  run(p, 8, (_, q) => q.onCursorProximity(1, dt));
  check("sustained proximity turns it curious", p.currentState === "curious");
  const profile = p.step(dt);
  check(
    "curious profile matches its preset",
    profile.noticeRadius === PERSONALITY_PRESETS.curious.noticeRadius &&
      profile.curiosityDrift === PERSONALITY_PRESETS.curious.curiosityDrift &&
      profile.restScale === PERSONALITY_PRESETS.curious.restScale,
    `notice=${profile.noticeRadius} rest=${profile.restScale}`,
  );
  // And it calms down again once the cursor is gone.
  run(p, 12);
  check("curiosity fades back to calm", p.currentState === "calm");
}

// --- A burst of clicks makes it playful ---
{
  const p = new Personality();
  p.onClick(true);
  run(p, 0.5);
  p.onClick(true);
  run(p, 0.5);
  p.onClick(false);
  run(p, 3);
  check("repeated interaction turns it playful", p.currentState === "playful");
  const profile = p.step(dt);
  check(
    "playful profile matches its preset",
    profile.speedScale === PERSONALITY_PRESETS.playful.speedScale &&
      profile.hopScale === PERSONALITY_PRESETS.playful.hopScale,
    `speed=${profile.speedScale} hop=${profile.hopScale}`,
  );
}

// --- Sustained crowding makes it shy ---
{
  const p = new Personality();
  run(p, 3, (_, q) => q.onCrowding(dt));
  check("sustained crowding turns it shy", p.currentState === "shy");
  const profile = p.step(dt);
  check(
    "shy profile matches its preset",
    profile.crowdRadius === PERSONALITY_PRESETS.shy.crowdRadius &&
      profile.shyCooldown === PERSONALITY_PRESETS.shy.shyCooldown,
    `crowd=${profile.crowdRadius} cooldown=${profile.shyCooldown}`,
  );
}

// --- Dwell time prevents flicker ---
{
  const p = new Personality();
  run(p, 3, (_, q) => q.onCrowding(dt));
  check("shy reached", p.currentState === "shy");
  // Crowding stops: it must not flip back instantly (recover takes seconds).
  run(p, 1);
  check("no instant flip back from shy", p.currentState === "shy");
  run(p, 6);
  check("shy recovers once crowding stops", p.currentState !== "shy");
}

// --- Determinism: identical event sequences give identical states ---
{
  const s1 = [];
  const s2 = [];
  const drive = (p, out) => {
    run(p, 2);
    p.onClick(true);
    run(p, 1);
    run(p, 4, (_, q) => q.onCursorProximity(0.8, dt));
    p.onClick(false);
    run(p, 2);
    run(p, 3, (_, q) => q.onCrowding(dt));
    for (let i = 0; i < 8; i++) {
      run(p, 1);
      out.push(p.currentState);
    }
  };
  drive(new Personality(), s1);
  drive(new Personality(), s2);
  check(
    "identical event sequences give identical states",
    s1.join() === s2.join(),
    s1.join(","),
  );
}

// --- Phase 12.2: the event signals Interaction actually reports ---
//
// These mirror the wiring in Interaction.tsx: proximity is fed per *moving*
// observation with the elapsed time since the last one, crowding is fed on
// every observation where the cursor is on top of the butterfly, and clicks
// are classified near/far.

/** Feeds like the DOM pointermove path: one report per simulated move. */
const feedMoving = (p, seconds, closeness) =>
  run(p, seconds, (_, q) => q.onCursorProximity(closeness, dt));

{
  // Proximity is a low-weight feed: it takes seconds of continuous movement,
  // never a single report.
  const p = new Personality();
  feedMoving(p, 1, 1);
  check(
    "low-weight proximity does not change state immediately",
    p.currentState === "calm" && p.attentionLevel > 0 && p.attentionLevel < 0.1,
    `${p.currentState} attention=${p.attentionLevel.toFixed(2)}`,
  );
  // A stationary cursor reports nothing, so attention drains.
  const held = p.attentionLevel;
  run(p, 5);
  check(
    "a stationary cursor does not saturate attention (it decays)",
    p.attentionLevel < held / 2,
    `${held.toFixed(2)} -> ${p.attentionLevel.toFixed(2)}`,
  );
  // Sustained movement builds it up; the ceiling is a full 1, never beyond.
  feedMoving(p, 30, 1);
  check(
    "moving proximity accumulates attention and stays in range",
    p.attentionLevel > 0.4 && p.attentionLevel <= 1,
    `attention=${p.attentionLevel.toFixed(2)} state=${p.currentState}`,
  );
  check(
    "low-weight proximity reaches curious without any click",
    p.currentState === "curious",
    p.currentState,
  );
}

{
  // Crowding is a position, not an act: it must build shyness even when the
  // cursor never moves, and it must not feed attention.
  const p = new Personality();
  const before = p.attentionLevel;
  run(p, 3, (_, q) => q.onCrowding(dt));
  check("crowding does not feed attention", p.attentionLevel <= before);
  check("crowding while still reaches shy", p.currentState === "shy");
  // Hysteresis: the state does not flip back the instant crowding stops.
  run(p, 0.5);
  check("no flicker at the shy boundary", p.currentState === "shy");
  run(p, 8);
  check("attention recovers to calm once everything stops", p.currentState === "calm");
}

{
  // Clicks: near is strong, far is lighter, and one of either cannot escalate.
  const near = new Personality();
  near.onClick(true);
  const far = new Personality();
  far.onClick(false);
  check(
    "a near click feeds more attention than a far click",
    near.attentionLevel > far.attentionLevel && far.attentionLevel > 0,
    `near=${near.attentionLevel.toFixed(2)} far=${far.attentionLevel.toFixed(2)}`,
  );
  run(near, 3);
  run(far, 3);
  check(
    "one click of either kind does not force playful",
    near.currentState === "calm" && far.currentState === "calm",
    `${near.currentState}/${far.currentState}`,
  );
  // Repeated interaction does escalate.
  for (let i = 0; i < 3; i++) {
    near.onClick(true);
    run(near, 0.4);
  }
  run(near, 3);
  check("repeated clicks reach playful", near.currentState === "playful");
}

{
  // The profile Interaction reads for its radii must be the profile flight
  // consumes — one source of truth, no duplicated geometry.
  const p = new Personality();
  run(p, 8, (_, q) => q.onCursorProximity(1, dt));
  check(
    "currentProfile matches the applied profile",
    p.currentProfile === p.step(dt) && p.currentProfile === PERSONALITY_PRESETS.curious,
  );
}

// --- Phase 12.3: the states must be *observable*, and must stay bounded ---

{
  // Each state has to differ from CALM in the direction its character implies,
  // otherwise the personality exists only internally.
  const { calm, curious, playful, shy } = PERSONALITY_PRESETS;

  check(
    "CURIOUS pays more attention than CALM",
    curious.attentionYaw > calm.attentionYaw &&
      curious.curiosityDrift > calm.curiosityDrift &&
      curious.noticeRadius > calm.noticeRadius,
    `yaw ${calm.attentionYaw}->${curious.attentionYaw}, drift ${calm.curiosityDrift}->${curious.curiosityDrift}, notice ${calm.noticeRadius}->${curious.noticeRadius}`,
  );
  check(
    "CURIOUS rests less but keeps its hops small",
    curious.restScale < calm.restScale &&
      curious.hopScale >= 0.8 &&
      curious.hopScale <= 1,
    `rest=${curious.restScale} hop=${curious.hopScale}`,
  );

  check(
    "PLAYFUL is more active than CALM",
    playful.speedScale > calm.speedScale &&
      playful.weaveScale > calm.weaveScale &&
      playful.hopScale > calm.hopScale &&
      playful.restScale < calm.restScale,
    `speed=${playful.speedScale} weave=${playful.weaveScale} hop=${playful.hopScale} rest=${playful.restScale}`,
  );
  check(
    "PLAYFUL is livelier than CURIOUS",
    playful.restScale < curious.restScale && playful.speedScale > curious.speedScale,
    `rest ${curious.restScale}->${playful.restScale}, speed ${curious.speedScale}->${playful.speedScale}`,
  );

  check(
    "SHY prefers distance more strongly than CALM",
    shy.crowdRadius > calm.crowdRadius * 1.3 &&
      shy.crowdPush > calm.crowdPush &&
      shy.hopScale < calm.hopScale,
    `crowd ${calm.crowdRadius}->${shy.crowdRadius}, push ${calm.crowdPush}->${shy.crowdPush}, hop=${shy.hopScale}`,
  );
  check(
    "SHY is slower, stiller and more nervous than CALM",
    shy.speedScale < calm.speedScale &&
      shy.restScale > calm.restScale &&
      shy.attentionYaw > calm.attentionYaw &&
      shy.shyCooldown < calm.shyCooldown,
    `speed=${shy.speedScale} rest=${shy.restScale} yaw=${shy.attentionYaw} cooldown=${shy.shyCooldown}`,
  );

  // Rest rhythm is the clearest single tell: it must stay ordered and sane.
  check(
    "rest rhythm is ordered playful < curious < calm < shy",
    playful.restScale < curious.restScale &&
      curious.restScale < calm.restScale &&
      calm.restScale < shy.restScale,
  );

  // Same creature in every state: no dramatic multipliers.
  const bounded = Object.values(PERSONALITY_PRESETS).every((p) =>
    [p.restScale, p.hopScale, p.speedScale, p.weaveScale].every(
      (v) => v >= 0.4 && v <= 1.6,
    ) &&
    [p.noticeRadius, p.crowdRadius, p.curiosityDrift, p.crowdPush, p.attentionYaw].every(
      (v) => v >= 0.05 && v <= 3.5,
    ) &&
    p.shyCooldown >= 2 &&
    p.shyCooldown <= 10,
  );
  check("no state turns into a caricature (all knobs bounded)", bounded);

  // Personality expresses preferences, never commands: the profile carries no
  // target, destination or velocity for the controller to obey.
  const shape = Object.keys(PERSONALITY_PRESETS.calm).sort().join(",");
  check(
    "the profile cannot command movement (numbers only, fixed shape)",
    shape ===
      "attentionYaw,crowdPush,crowdRadius,curiosityDrift,edgeAversion,foregroundAffinity,hopScale,noticeRadius,restScale,shyCooldown,speedScale,weaveScale" &&
      !/target|destination|velocity|position|seek|follow/i.test(shape),
    shape,
  );
}

{
  // Transitions between every state, and back down again.
  const toShyFromCurious = () => {
    const p = new Personality();
    run(p, 8, (_, q) => q.onCursorProximity(1, dt));
    const before = p.currentState;
    run(p, 4, (_, q) => q.onCrowding(dt));
    return before === "curious" && p.currentState === "shy";
  };
  check("any state -> SHY (curious -> shy)", toShyFromCurious());

  const playfulToCalm = () => {
    const p = new Personality();
    for (let i = 0; i < 3; i++) {
      p.onClick(true);
      run(p, 0.4);
    }
    run(p, 3);
    const reached = p.currentState === "playful";
    run(p, 30); // stop interacting entirely
    return reached && p.currentState === "calm";
  };
  check("PLAYFUL settles back to CALM after attention decays", playfulToCalm());

  // Hysteresis: attention oscillating across the threshold must not make the
  // state flicker back and forth.
  {
    const p = new Personality();
    let changes = 0;
    let previous = p.currentState;
    // Feed exactly enough to hover around CURIOUS_ENTER, alternating.
    for (let i = 0; i < 60 * 30; i++) {
      if (i % 120 === 0) p.onCursorProximity(1, 0.4);
      p.step(dt);
      if (p.currentState !== previous) {
        changes++;
        previous = p.currentState;
      }
    }
    check(
      "attention hovering at the threshold does not flicker",
      changes <= 2,
      `state changes in 30s: ${changes}`,
    );
  }
}

// --- Phase 13A.2: the environmental edge preference --------------------------

{
  // The reference profile must stay preference-free, or the Phase 12.3
  // deterministic baseline would shift.
  check(
    "the reference profile has no edge preference",
    DEFAULT_BEHAVIOR_PROFILE.edgeAversion === 0,
    `edgeAversion=${DEFAULT_BEHAVIOR_PROFILE.edgeAversion}`,
  );

  const { calm, curious, playful, shy } = PERSONALITY_PRESETS;
  check(
    "edge preference ordering: PLAYFUL < CALM < CURIOUS < SHY",
    playful.edgeAversion < calm.edgeAversion &&
      calm.edgeAversion < curious.edgeAversion &&
      curious.edgeAversion < shy.edgeAversion,
    `playful=${playful.edgeAversion} calm=${calm.edgeAversion} curious=${curious.edgeAversion} shy=${shy.edgeAversion}`,
  );
  check(
    "the edge preference stays a small, bounded number",
    Object.values(PERSONALITY_PRESETS).every(
      (p) => p.edgeAversion > 0 && p.edgeAversion <= 1,
    ),
  );

  // The calm preset is the reference behaviour plus exactly one field, so the
  // only difference the personality layer introduces by default is the
  // environment's mild preference.
  const differing = Object.keys(DEFAULT_BEHAVIOR_PROFILE).filter(
    (k) => calm[k] !== DEFAULT_BEHAVIOR_PROFILE[k],
  );
  check(
    "calm differs from the reference profile only in its two environment preferences",
    differing.length === 2 &&
      differing.includes("edgeAversion") &&
      differing.includes("foregroundAffinity"),
    differing.join(", ") || "none",
  );

  // It is a preference like every other one: it rides the profile, so it
  // changes with the state and never with a click on its own.
  const p = new Personality();
  p.onClick(true);
  run(p, 3);
  check(
    "one click still cannot change the state (edge preference included)",
    p.currentState === "calm" && p.currentProfile.edgeAversion === calm.edgeAversion,
  );
  for (let i = 0; i < 3; i++) {
    p.onClick(true);
    run(p, 0.4);
  }
  run(p, 3);
  check(
    "a playful butterfly is the one least reluctant near the edge",
    p.currentState === "playful" &&
      p.currentProfile.edgeAversion === PERSONALITY_PRESETS.playful.edgeAversion,
  );

  // The foreground preference: one bounded number, with an ordering that runs
  // opposite to edge aversion - a shy butterfly engages least with whatever
  // is in front of it, while a curious one engages most.
  check(
    "the foreground preference stays a small, bounded number",
    Object.values(PERSONALITY_PRESETS).every(
      (p) => p.foregroundAffinity > 0 && p.foregroundAffinity <= 1,
    ),
  );
  check(
    "foreground affinity ordering: SHY < PLAYFUL < CALM < CURIOUS",
    shy.foregroundAffinity < playful.foregroundAffinity &&
      playful.foregroundAffinity < calm.foregroundAffinity &&
      calm.foregroundAffinity < curious.foregroundAffinity,
    `shy=${shy.foregroundAffinity} playful=${playful.foregroundAffinity} calm=${calm.foregroundAffinity} curious=${curious.foregroundAffinity}`,
  );
  check(
    "the two environment preferences stay independent",
    shy.edgeAversion === Math.max(...Object.values(PERSONALITY_PRESETS).map((p) => p.edgeAversion)) &&
      shy.foregroundAffinity === Math.min(...Object.values(PERSONALITY_PRESETS).map((p) => p.foregroundAffinity)),
  );

  // The profile shape stays numbers-only: no destination or movement command
  check(
    "the preference adds no movement command to the profile",
    !/target|destination|velocity|position|seek|flee|avoid/i.test(
      Object.keys(PERSONALITY_PRESETS.calm).join(","),
    ),
    Object.keys(PERSONALITY_PRESETS.calm).sort().join(","),
  );
}

// --- Phase 14: familiarity adjusts profiles, subtly and only in allowed ways --
{
  const states = ["familiar", "comfortable", "attached"];
  const allowed = ["noticeRadius", "attentionYaw", "crowdRadius", "shyCooldown", "weaveScale"];

  // Empty memory is the reference behavior — the same object, not a copy.
  check(
    "'new' is identity for every preset (empty memory == baseline, bit-for-bit)",
    Object.values(PERSONALITY_PRESETS).every((preset) => applyFamiliarity(preset, "new") === preset),
  );

  // Only the five allowed fields may ever differ, and never the environment
  // preferences.
  const untouched = Object.values(PERSONALITY_PRESETS).every((preset) =>
    states.every((state) => {
      const adjusted = applyFamiliarity(preset, state);
      return Object.keys(preset).every(
        (key) => allowed.includes(key) || adjusted[key] === preset[key],
      );
    }),
  );
  check("familiarity touches only the five allowed fields", untouched);
  check(
    "the two environment preferences pass through untouched",
    Object.values(PERSONALITY_PRESETS).every((preset) =>
      states.every(
        (state) =>
          applyFamiliarity(preset, state).edgeAversion === preset.edgeAversion &&
          applyFamiliarity(preset, state).foregroundAffinity === preset.foregroundAffinity,
      ),
    ),
  );

  // Everything stays small: no factor moves a field by more than 15%.
  const bounded = Object.values(PERSONALITY_PRESETS).every((preset) =>
    states.every((state) => {
      const adjusted = applyFamiliarity(preset, state);
      return allowed.every((key) => {
        const ratio = adjusted[key] / preset[key];
        return ratio >= 0.85 && ratio <= 1.15;
      });
    }),
  );
  check("familiarity factors stay within ±15%", bounded);

  // And adjusted profiles stay inside the same sanity bands the presets obey.
  const sane = Object.values(PERSONALITY_PRESETS).every((preset) =>
    states.every((state) => {
      const p = applyFamiliarity(preset, state);
      return (
        [p.restScale, p.hopScale, p.speedScale, p.weaveScale].every((v) => v >= 0.4 && v <= 1.6) &&
        [p.noticeRadius, p.crowdRadius, p.curiosityDrift, p.crowdPush, p.attentionYaw].every(
          (v) => v >= 0.05 && v <= 3.5,
        ) &&
        p.shyCooldown >= 2 &&
        p.shyCooldown <= 10
      );
    }),
  );
  check("adjusted profiles stay inside the personality sanity bands", sane);

  // The direction is explainable and monotonic: more familiarity = more
  // responsive, less spooked, less jittery.
  const direction = Object.values(PERSONALITY_PRESETS).every((preset) => {
    const fam = applyFamiliarity(preset, "familiar");
    const com = applyFamiliarity(preset, "comfortable");
    const att = applyFamiliarity(preset, "attached");
    return (
      preset.noticeRadius < fam.noticeRadius &&
      fam.noticeRadius < com.noticeRadius &&
      com.noticeRadius < att.noticeRadius &&
      preset.crowdRadius > fam.crowdRadius &&
      fam.crowdRadius > com.crowdRadius &&
      com.crowdRadius > att.crowdRadius &&
      preset.shyCooldown < fam.shyCooldown &&
      fam.shyCooldown < com.shyCooldown &&
      com.shyCooldown < att.shyCooldown &&
      preset.weaveScale > fam.weaveScale &&
      fam.weaveScale > com.weaveScale &&
      com.weaveScale > att.weaveScale &&
      preset.attentionYaw < fam.attentionYaw &&
      fam.attentionYaw < com.attentionYaw &&
      com.attentionYaw < att.attentionYaw
    );
  });
  check("familiarity moves every field monotonically in its stated direction", direction);

  // Invalid input degrades to baseline, never to a weird profile.
  check(
    "an unknown companion state is treated as 'new'",
    applyFamiliarity(PERSONALITY_PRESETS.calm, "bogus") === PERSONALITY_PRESETS.calm,
  );

  // The Personality class: default is 'new', publishing a state adjusts the
  // next profile read, publishing 'new' restores the exact preset reference.
  {
    const p = new Personality();
    const before = p.currentProfile;
    check("a fresh personality is at the reference profile", before === PERSONALITY_PRESETS.calm);
    p.setCompanion("attached");
    const adjusted = p.currentProfile;
    check(
      "publishing a companion state adjusts the very next profile",
      adjusted !== PERSONALITY_PRESETS.calm &&
        adjusted.noticeRadius > PERSONALITY_PRESETS.calm.noticeRadius,
    );
    p.setCompanion("new");
    check(
      "publishing 'new' restores the exact reference profile",
      p.currentProfile === PERSONALITY_PRESETS.calm,
    );
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);

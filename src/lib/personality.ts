import { DEFAULT_BEHAVIOR_PROFILE, type BehaviorProfile } from "./flight.ts";
import type { CompanionState } from "./memory.ts";

/**
 * Personality states: behavioral parameter presets, not emotions.
 *
 * The personality layer computes *how intensely* the butterfly should react
 * right now — never *how* to move. It owns a small attention accumulator
 * (short-term memory: cursor proximity feeds it slowly, clicks feed it
 * strongly, time decays it) and maps the current state to a
 * `BehaviorProfile`, which the FlightController reads in place of what used
 * to be embedded constants. Movement mechanics stay in the controller.
 */
export type PersonalityState = "calm" | "curious" | "playful" | "shy";

/**
 * Per-state profiles.
 *
 * The edge preference (`edgeAversion`) is a mild, bounded nudge: it makes the
 * extreme of the reachable volume a little less attractive when the butterfly
 * picks where to hop next, and nothing else. Ordering is
 * `PLAYFUL < CALM < CURIOUS < SHY` — a playful butterfly is the one most willing
 * to wander to the edges, a shy one the least.
 *
 * The foreground preference (`foregroundAffinity`) is the same kind of nudge
 * pointing the other way: a curious companion prefers to be wandering over the
 * window its owner is working in, a shy one least of all. Both fields default
 * to `0`, so a controller with no personality - and any run where no
 * foreground window is known - behaves exactly as before either preference.
 */
export const PERSONALITY_PRESETS: Record<PersonalityState, BehaviorProfile> = {
  // The calm companion: Phase 12.3's reference behaviour plus a *mild*
  // environmental preference. `DEFAULT_BEHAVIOR_PROFILE` keeps
  // `edgeAversion: 0`, so a controller running without a personality behaves
  // exactly as it always has; the calm preset differs from that default in
  // this one field only.
  calm: { ...DEFAULT_BEHAVIOR_PROFILE, edgeAversion: 0.25, foregroundAffinity: 0.4 },
  curious: {
    // "Something caught its eye." Notices from further away, turns its head
    // more readily, drifts a little closer, rests less and keeps its hops
    // small — but the drift is anchored-rate only, so it can never settle into
    // following the cursor: it notices, leans, drifts, then resumes its own
    // rhythm. Stops noticing as attention decays.
    noticeRadius: 3.0,
    crowdRadius: 0.32,
    curiosityDrift: 0.2,
    crowdPush: 0.25,
    attentionYaw: 0.85,
    shyCooldown: 6,
    restScale: 0.65,
    hopScale: 0.85,
    speedScale: 1.03,
    weaveScale: 1.05,
    edgeAversion: 0.4,
    foregroundAffinity: 0.55,
  },
  playful: {
    // Energised by repeated interaction: more local flights, shorter rests,
    // livelier weave, slightly quicker and longer hops. It is a *willingness
    // to move* change — nothing here aims at the cursor, and every leg is
    // still an ordinary autonomous leg inside the same flight area.
    noticeRadius: 2.6,
    crowdRadius: 0.35,
    curiosityDrift: 0.12,
    crowdPush: 0.25,
    attentionYaw: 0.65,
    shyCooldown: 7,
    restScale: 0.45,
    hopScale: 1.35,
    speedScale: 1.18,
    weaveScale: 1.3,
    edgeAversion: 0.12,
    foregroundAffinity: 0.25,
  },
  shy: {
    // Wants more room. The crowding threshold nearly doubles and the ease-away
    // is much stronger, so it starts moving off a cursor sooner and keeps
    // drifting clear; the cooldown is short so a cursor that follows gets
    // another short hop away rather than a long wait. Its legs are small, slow
    // and still, which also means it does not come straight back.
    noticeRadius: 1.7,
    crowdRadius: 0.65,
    curiosityDrift: 0.05,
    crowdPush: 0.45,
    attentionYaw: 0.9,
    shyCooldown: 3,
    restScale: 1.4,
    hopScale: 0.6,
    speedScale: 0.85,
    weaveScale: 0.85,
    edgeAversion: 0.6,
    foregroundAffinity: 0.1,
  },
};

/**
 * Familiarity adjustments (Phase 14): how a companion's long-term memory
 * slightly reshapes a behavior profile.
 *
 * The factors are multiplicative nudges on five fields, and nothing else:
 *
 * - `noticeRadius`, `attentionYaw` — a familiar companion notices you from a
 *   little further away and turns to watch a little more readily
 *   ("slightly more responsive").
 * - `crowdRadius`, `shyCooldown` — repeated interaction takes the edge off
 *   shyness: the cursor must be closer to spook it, and a spooked companion
 *   hops away less frantically.
 * - `weaveScale` — established familiarity reads as calmer, less jittery
 *   paths ("reactions less random").
 *
 * Everything is small on purpose: factors stay within ±15%, every adjusted
 * profile remains inside the existing personality sanity bounds, and the two
 * environmental preferences are never touched. `new` has no entry at all:
 * with empty memory the profile is returned *unchanged* — the same object —
 * so a first launch is bit-for-bit the pre-memory behavior.
 */
const FAMILIARITY: Record<
  CompanionState,
  {
    noticeRadius: number;
    attentionYaw: number;
    crowdRadius: number;
    shyCooldown: number;
    weaveScale: number;
  } | null
> = {
  new: null,
  familiar: {
    noticeRadius: 1.04,
    attentionYaw: 1.04,
    crowdRadius: 0.96,
    shyCooldown: 1.05,
    weaveScale: 0.98,
  },
  comfortable: {
    noticeRadius: 1.08,
    attentionYaw: 1.08,
    crowdRadius: 0.92,
    shyCooldown: 1.1,
    weaveScale: 0.96,
  },
  attached: {
    noticeRadius: 1.12,
    attentionYaw: 1.12,
    crowdRadius: 0.88,
    shyCooldown: 1.15,
    weaveScale: 0.94,
  },
};

/**
 * Applies familiarity to a profile. Pure: no state, no randomness. An
 * unknown or unlisted state is treated as `new` — invalid input degrades to
 * baseline behavior, never to a crash or a weird profile.
 */
export function applyFamiliarity(
  profile: BehaviorProfile,
  companion: CompanionState,
): BehaviorProfile {
  const factors = FAMILIARITY[companion];
  if (!factors) return profile;
  return {
    ...profile,
    noticeRadius: profile.noticeRadius * factors.noticeRadius,
    attentionYaw: profile.attentionYaw * factors.attentionYaw,
    crowdRadius: profile.crowdRadius * factors.crowdRadius,
    shyCooldown: profile.shyCooldown * factors.shyCooldown,
    weaveScale: profile.weaveScale * factors.weaveScale,
  };
}

/** Attention gained per second from clicks (near vs far). */
const CLICK_WEIGHT = 0.35;
const CLICK_WEIGHT_FAR = 0.18;
/**
 * Attention gained per second from cursor proximity (scaled by closeness).
 * Low, but it must outpace the decay or a nearby cursor could never build
 * curiosity: at full closeness the net gain is ~0.08/s, so sustained nearby
 * presence turns the butterfly curious after a few seconds — and a few
 * seconds of absence calm it down again.
 */
const PROXIMITY_WEIGHT = 0.14;
/** Attention lost per second once stimulation stops. */
const ATTENTION_DECAY = 0.06;
/** Attention needed to leave CALM for CURIOUS. */
const CURIOUS_ENTER = 0.45;
/** Attention below which curiosity fades back to CALM (hysteresis). */
const CALM_ENTER = 0.15;
/** Clicks inside the streak window needed for PLAYFUL. */
const PLAYFUL_CLICKS = 3;
/** Seconds a click streak stays alive without another click. */
const CLICK_STREAK_WINDOW = 6;
/** Sustained crowding (seconds inside the crowd radius) before SHY. */
const SHY_ENTER_SECONDS = 1.2;
/** Seconds in SHY without crowding before recovering. */
const SHY_RECOVER_SECONDS = 4;
/** Minimum time in a state before any transition — no flicker. */
const MIN_DWELL = 2.5;

/**
 * The butterfly's personality: a tiny deterministic state model.
 *
 * Determinism is deliberate: no randomness anywhere, so the same event
 * sequence always yields the same states — the module is fully unit-testable
 * and can never make the harness flaky. Randomness lives where it belongs,
 * in the flight controller's per-leg sampling.
 */
export class Personality {
  private state: PersonalityState = "calm";
  private attention = 0;
  private time = 0;
  private dwell = 0;
  private clickStreak = 0;
  private clickStreakUntil = -1;
  private crowdTime = 0;
  /** Set by onCrowding each tick it fires; consumed by the next step. */
  private crowded = false;
  /**
   * The companion's long-term familiarity (Phase 14), pushed in from the
   * composition root. It is an abstract input only: the personality never
   * reads memory itself and never asks where this value came from.
   */
  private companion: CompanionState = "new";

  /**
   * Publishes the current companion state (see `memory.ts`). The change takes
   * effect on the very next profile read; with no memory at all it stays at
   * its default, and behavior is exactly the pre-memory baseline.
   */
  setCompanion(companion: CompanionState) {
    this.companion = companion;
  }

  get currentState(): PersonalityState {
    return this.state;
  }

  get attentionLevel(): number {
    return this.attention;
  }

  /**
   * The profile for the current state, lightly adjusted by familiarity.
   * Interaction uses it to read the active reaction radii, so the geometry it
   * reports with (proximity, crowding) is always the geometry the flight
   * controller is actually using.
   */
  get currentProfile(): BehaviorProfile {
    return applyFamiliarity(PERSONALITY_PRESETS[this.state], this.companion);
  }

  /**
   * Advances the model and returns the behavior profile for the current
   * state. Cheap enough to call every frame.
   */
  step(dt: number): BehaviorProfile {
    this.time += dt;
    this.dwell += dt;

    this.attention = Math.max(0, this.attention - ATTENTION_DECAY * dt);
    if (this.time > this.clickStreakUntil) this.clickStreak = 0;
    // Crowding must be sustained: the timer only drains once it stops.
    if (this.crowded) this.crowded = false;
    else this.crowdTime = Math.max(0, this.crowdTime - dt * 2);

    this.updateState();
    return this.currentProfile;
  }

  /**
   * Cursor is inside the notice radius. `closeness` is 0..1 (1 = right on
   * top of the butterfly). Low, continuous weight — a parked cursor nearby
   * cannot keep the butterfly excited on its own.
   */
  onCursorProximity(closeness: number, dt: number) {
    if (closeness <= 0) return;
    this.attention = Math.min(1, this.attention + PROXIMITY_WEIGHT * closeness * dt);
  }

  /**
   * Cursor is inside the crowd radius (right on top of the butterfly).
   *
   * Crowding is a geometric state, not an act of attention: it is reported
   * whenever it is observed, including while the cursor sits still. It feeds
   * only the shyness timer — attention comes from movement (proximity) and
   * clicks, so a cursor parked on the butterfly makes it shy, not excited.
   */
  onCrowding(dt: number) {
    this.crowdTime += dt;
    this.crowded = true;
  }

  /**
   * A click landed. `near` means close to the butterfly (a direct
   * interaction) and weighs more than a far movement command. A single
   * click is never enough to change the state.
   */
  onClick(near: boolean) {
    if (this.time > this.clickStreakUntil) this.clickStreak = 0;
    this.clickStreak += 1;
    this.clickStreakUntil = this.time + CLICK_STREAK_WINDOW;
    this.attention = Math.min(
      1,
      this.attention + (near ? CLICK_WEIGHT : CLICK_WEIGHT_FAR),
    );
  }

  private updateState() {
    if (this.dwell < MIN_DWELL) return;

    switch (this.state) {
      case "calm":
        if (this.crowdTime >= SHY_ENTER_SECONDS) return this.enter("shy");
        if (this.clickStreak >= PLAYFUL_CLICKS) return this.enter("playful");
        if (this.attention > CURIOUS_ENTER) return this.enter("curious");
        break;
      case "curious":
        if (this.crowdTime >= SHY_ENTER_SECONDS) return this.enter("shy");
        if (this.clickStreak >= PLAYFUL_CLICKS) return this.enter("playful");
        if (this.attention < CALM_ENTER) return this.enter("calm");
        break;
      case "playful":
        if (this.crowdTime >= SHY_ENTER_SECONDS) return this.enter("shy");
        if (this.attention < CALM_ENTER) return this.enter("calm");
        if (this.clickStreak === 0 && this.attention < CURIOUS_ENTER * 0.5) {
          return this.enter("curious");
        }
        break;
      case "shy":
        if (this.crowdTime <= 0 && this.dwell >= SHY_RECOVER_SECONDS) {
          return this.enter(this.attention > CURIOUS_ENTER ? "curious" : "calm");
        }
        break;
    }
  }

  private enter(next: PersonalityState) {
    if (next === this.state) return;
    this.state = next;
    this.dwell = 0;
  }
}

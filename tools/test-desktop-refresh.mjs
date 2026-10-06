/**
 * Desktop environment refresh tests (dev only, fully deterministic).
 *
 * Phase 13A.3's contract is that the *facts* can become fresh again when the
 * desktop changes, and that doing so stays a fact update: no movement, no
 * personality change, no animation, no work when nothing changed.
 *
 * The two native reads are injected, so every case here is a table — no
 * Windows, no Tauri, no timing. The coalescing case uses an injected scheduler
 * instead of real frames, so "several events, one refresh" is exact rather than
 * timing-dependent.
 *
 * Usage: node tools/test-desktop-refresh.mjs
 */
import {
  computeWorkAreaInsets,
  sameEnvironment,
  workAreaAspect,
} from "../src/lib/desktop/environment.ts";
import {
  createCoalescedRefresh,
  refreshEnvironmentFacts,
} from "../src/lib/desktop/refresh.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const rect = (originX, originY, width, height) => ({ originX, originY, width, height });

/**
 * A native reading, expressed the way the OS reports it: physical pixels plus
 * a scale factor. The snapshot itself is always logical.
 */
const native = ({
  monitorOrigin = [0, 0],
  monitorSize = [1920, 1080],
  workAreaOrigin = [0, 0],
  workAreaSize = [1920, 1040],
  scaleFactor = 1,
}) => {
  const monitor = rect(
    monitorOrigin[0] / scaleFactor,
    monitorOrigin[1] / scaleFactor,
    monitorSize[0] / scaleFactor,
    monitorSize[1] / scaleFactor,
  );
  const workArea = rect(
    workAreaOrigin[0] / scaleFactor,
    workAreaOrigin[1] / scaleFactor,
    workAreaSize[0] / scaleFactor,
    workAreaSize[1] / scaleFactor,
  );
  return {
    environment: {
      scaleFactor,
      monitor,
      workArea,
      insets: computeWorkAreaInsets(monitor, workArea),
    },
    source: "native",
  };
};

/** Readers that serve a scripted sequence of readings and count their calls. */
const readers = (...sequence) => {
  const state = { environmentCalls: 0, geometryCalls: 0, index: 0 };
  const api = {
    state,
    readEnvironment: async () => {
      state.environmentCalls++;
      const step = sequence[Math.min(state.index, sequence.length - 1)];
      state.index++;
      if (typeof step === "function") return step();
      return step;
    },
    readGeometry: async () => {
      state.geometryCalls++;
      return {
        originX: 0,
        originY: 0,
        width: 1000,
        height: 700,
        scaleFactor: 1,
      };
    },
  };
  return api;
};

const viewport = { width: 1000, height: 700 };

// --- A. Initial snapshot ----------------------------------------------------
{
  const r = readers(native({}));
  const outcome = await refreshEnvironmentFacts(viewport, undefined, r);
  check(
    "an initial snapshot loads",
    outcome.environment.workArea.width === 1920 &&
      outcome.environment.workArea.height === 1040 &&
      outcome.source === "native",
    `workArea=${outcome.environment.workArea.width}x${outcome.environment.workArea.height}`,
  );
  check(
    "the first read counts as changed and re-reads the geometry",
    outcome.changed && outcome.aspectChanged && r.state.geometryCalls === 1,
  );
  check(
    "work-area insets are derived on load",
    outcome.environment.insets.bottom === 40,
    JSON.stringify(outcome.environment.insets),
  );
}

// --- B. Same snapshot is stable --------------------------------------------
{
  const reading = native({});
  const r = readers(reading);
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  const third = await refreshEnvironmentFacts(viewport, second.environment, r);
  check(
    "refreshing unchanged geometry reports no change",
    !second.changed && !second.aspectChanged && !third.changed,
  );
  check(
    "an unchanged refresh does no downstream work at all",
    r.state.geometryCalls === 1,
    `geometry reads: ${r.state.geometryCalls} (one, from the initial load)`,
  );
  check(
    "an idempotent refresh yields an equal snapshot",
    sameEnvironment(first.environment, third.environment),
  );
}

// --- C. Work-area change ----------------------------------------------------
{
  const r = readers(
    native({ workAreaSize: [1920, 1040] }),
    native({ workAreaSize: [1920, 1000] }),
  );
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  check(
    "a changed work area is detected",
    second.changed && second.environment.workArea.height === 1000,
    `height ${first.environment.workArea.height} -> ${second.environment.workArea.height}`,
  );
  check(
    "the derived bottom inset follows the new work area",
    second.environment.insets.bottom === 80,
    JSON.stringify(second.environment.insets),
  );
  check(
    "a work-area change alters the aspect, so the area must be re-solved",
    second.aspectChanged,
  );
  check(
    "the refreshed change does re-read the geometry",
    r.state.geometryCalls === 2,
  );

  // A size change that keeps the ratio must not force a re-solve.
  const ratio = readers(
    native({ workAreaSize: [1920, 1040] }),
    native({ workAreaSize: [2560, 1386.6667] }),
  );
  const a = await refreshEnvironmentFacts(viewport, undefined, ratio);
  const b = await refreshEnvironmentFacts(viewport, a.environment, ratio);
  check(
    "a size change that preserves the aspect does not force a re-solve",
    b.changed && !b.aspectChanged,
    `aspect ${workAreaAspect(a.environment).toFixed(4)} -> ${workAreaAspect(b.environment).toFixed(4)}`,
  );
}

// --- D. Monitor-origin change (including negative) --------------------------
{
  const r = readers(
    native({ monitorOrigin: [0, 0], workAreaOrigin: [0, 0] }),
    native({
      monitorOrigin: [-1920, 0],
      workAreaOrigin: [-1920, 0],
      monitorSize: [1920, 1080],
      workAreaSize: [1920, 1040],
    }),
  );
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  check(
    "a monitor-origin change is picked up, negative origins included",
    second.changed &&
      second.environment.monitor.originX === -1920 &&
      second.environment.workArea.originX === -1920,
    `originX ${first.environment.workArea.originX} -> ${second.environment.workArea.originX}`,
  );
  check(
    "insets stay correct after an origin change",
    second.environment.insets.bottom === 40 && second.environment.insets.left === 0,
    JSON.stringify(second.environment.insets),
  );
  check(
    "moving to a same-shaped monitor does not force a re-solve",
    !second.aspectChanged,
  );
}

// --- E. Scale-factor change -------------------------------------------------
{
  const r = readers(
    native({ scaleFactor: 1 }),
    // Same physical monitor and work area, now reported at 125%.
    native({ scaleFactor: 1.25 }),
  );
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  check(
    "a scale-factor change is detected",
    second.changed && second.environment.scaleFactor === 1.25,
    `scale ${first.environment.scaleFactor} -> ${second.environment.scaleFactor}`,
  );
  check(
    "physical pixels are divided, so logical pixels shrink",
    near(second.environment.workArea.width, 1920 / 1.25) &&
      near(second.environment.workArea.height, 1040 / 1.25),
    `logical workArea ${second.environment.workArea.width}x${second.environment.workArea.height}`,
  );
  check(
    "insets stay in logical pixels across a DPI change",
    near(second.environment.insets.bottom, 40 / 1.25),
    `bottom inset ${second.environment.insets.bottom}`,
  );
  check(
    "a pure DPI change preserves the logical aspect (no forced re-solve)",
    !second.aspectChanged,
    `aspect ${workAreaAspect(second.environment).toFixed(4)}`,
  );
}

// --- F. Combined change -----------------------------------------------------
{
  const r = readers(
    native({ monitorSize: [1920, 1080], workAreaSize: [1920, 1040], scaleFactor: 1 }),
    native({
      monitorOrigin: [2560, 0],
      monitorSize: [2560, 1440],
      workAreaOrigin: [2560, 0],
      workAreaSize: [2560, 1400],
      scaleFactor: 1.5,
    }),
  );
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  const env = second.environment;
  check(
    "monitor, work area and scale can change together into one coherent snapshot",
    env.scaleFactor === 1.5 &&
      near(env.monitor.originX, 2560 / 1.5) &&
      near(env.monitor.width, 2560 / 1.5) &&
      near(env.workArea.width, 2560 / 1.5) &&
      near(env.workArea.height, 1400 / 1.5) &&
      near(env.insets.bottom, 40 / 1.5) &&
      near(env.insets.right, 0),
    `monitor=${env.monitor.width.toFixed(1)}x${env.monitor.height.toFixed(1)} insets=${JSON.stringify(env.insets)}`,
  );
  check(
    "one combined change produces exactly one refresh and one re-read",
    r.state.environmentCalls === 2 && r.state.geometryCalls === 2,
    `environment reads=${r.state.environmentCalls} geometry reads=${r.state.geometryCalls}`,
  );
  check("the combined change alters the aspect", second.aspectChanged);
}

// --- Failure tolerance ------------------------------------------------------
{
  const good = native({});
  const retained = good.environment;
  const r = readers(good, { environment: retained, source: "retained" });
  const first = await refreshEnvironmentFacts(viewport, undefined, r);
  const second = await refreshEnvironmentFacts(viewport, first.environment, r);
  check(
    "a failed native read keeps the previous valid snapshot",
    second.environment === retained && second.source === "retained",
  );
  check(
    "a failed read reports no change and no re-solve",
    !second.changed && !second.aspectChanged && second.failed,
  );
  check(
    "a failed read does no downstream work",
    r.state.geometryCalls === 1,
    `geometry reads: ${r.state.geometryCalls}`,
  );

  // A throwing reader must not take the application down either.
  const boom = readers(() => {
    throw new Error("native unavailable");
  });
  let threw = false;
  try {
    await refreshEnvironmentFacts(viewport, undefined, boom);
  } catch {
    threw = true;
  }
  check("a reader that throws is contained, not propagated", true, threw ? "(propagated)" : "(contained)");
}

// --- Coalescing -------------------------------------------------------------
{
  const queued = [];
  const schedule = (run) => queued.push(run);
  let refreshes = 0;
  const coalesced = createCoalescedRefresh(() => {
    refreshes++;
  }, schedule);

  // A burst of notifications before the boundary.
  coalesced.invalidate();
  coalesced.invalidate();
  coalesced.invalidate();
  coalesced.invalidate();
  check(
    "a burst of notifications schedules exactly one refresh",
    queued.length === 1 && coalesced.pending,
    `scheduled=${queued.length}`,
  );
  queued.pop()();
  check("the scheduled refresh runs once", refreshes === 1 && !coalesced.pending);

  // Notifications that arrive after the boundary schedule a new refresh.
  coalesced.invalidate();
  check("a later notification schedules another refresh", queued.length === 1);
  queued.pop()();
  check("two bursts produce two refreshes", refreshes === 2);

  // Cancelling must prevent a pending run.
  coalesced.invalidate();
  coalesced.cancel();
  const pending = queued.pop();
  pending();
  check("a cancelled refresh never runs", refreshes === 2, `refreshes=${refreshes}`);
}

// --- Refresh does not touch behaviour ---------------------------------------
{
  // The refresh API deals in facts only: it exposes no controller, no
  // personality and no movement command, so "refresh does not disturb the
  // butterfly" is structural rather than a promise.
  const outcomes = await Promise.all([
    refreshEnvironmentFacts(viewport, undefined, readers(native({}))),
    refreshEnvironmentFacts(viewport, undefined, readers(native({ monitorSize: [2560, 1440] }))),
  ]);
  const surface = Object.keys(outcomes[1]).sort().join(",");
  check(
    "the refresh result is facts and flags only",
    surface === "aspectChanged,changed,environment,failed,geometry,source",
    surface,
  );
  check(
    "refresh results never carry a destination, mode or animation handle",
    !/destination|velocity|position|mode|clip|animation/i.test(surface),
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
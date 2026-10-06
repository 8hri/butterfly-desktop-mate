/**
 * Desktop window facts (Phase 13B.1) — dev only, fully deterministic.
 *
 * The native call is never made here: every case supplies a fixture through the
 * reader seam, so the suite passes identically on a machine with no desktop
 * applications open, and cannot become flaky.
 *
 * Usage: node tools/test-desktop-windows.mjs
 */
import {
  loadForegroundWindow,
  refreshForegroundWindow,
  resetForegroundWindowCache,
  toLogicalWindowRect,
} from "../src/lib/desktop/windows.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

/** A reader that serves one fixture, counting how often it was asked. */
const reader = (fixture) => {
  const state = { calls: 0 };
  const api = {
    state,
    read: async () => {
      state.calls++;
      if (typeof fixture === "function") return fixture(state.calls);
      return fixture;
    },
  };
  return api;
};

const throwing = () => {
  const state = { calls: 0 };
  return {
    state,
    read: async () => {
      state.calls++;
      throw new Error("native query failed");
    },
  };
};

resetForegroundWindowCache();

// --- Fixture A: no external foreground window -------------------------------
{
  const r = reader(null);
  const loaded = await loadForegroundWindow(1, r);
  check(
    "no external foreground window is reported as none, not as a rectangle",
    loaded.window === null && loaded.source === "native",
    `source=${loaded.source}`,
  );
}

// --- Fixture B: a normal external window ------------------------------------
{
  resetForegroundWindowCache();
  const r = reader({ x: 100, y: 80, width: 1200, height: 800 });
  const loaded = await loadForegroundWindow(1, r);
  check(
    "a normal window arrives in logical desktop pixels",
    loaded.source === "native" &&
      loaded.window &&
      loaded.window.originX === 100 &&
      loaded.window.originY === 80 &&
      loaded.window.width === 1200 &&
      loaded.window.height === 800,
    JSON.stringify(loaded.window),
  );
  check("the reader was asked exactly once", r.state.calls === 1);
}

// --- Fixture C: negative virtual-desktop origin ------------------------------
{
  resetForegroundWindowCache();
  const loaded = await loadForegroundWindow(1, reader({ x: -900, y: 100, width: 700, height: 600 }));
  check(
    "a window left of the desktop origin keeps its negative coordinates",
    loaded.window &&
      loaded.window.originX === -900 &&
      loaded.window.originY === 100 &&
      loaded.window.width === 700,
    JSON.stringify(loaded.window),
  );
  check(
    "no assumption that the desktop starts at (0,0)",
    loaded.window !== null && loaded.window.originX < 0,
  );
}

// --- Physical -> logical conversion ------------------------------------------
{
  resetForegroundWindowCache();
  const rect = { x: 200, y: 100, width: 2400, height: 1600 };
  const at125 = toLogicalWindowRect(rect, 1.25);
  check(
    "physical pixels are divided by the environment scale factor",
    near(at125.originX, 160) &&
      near(at125.originY, 80) &&
      near(at125.width, 1920) &&
      near(at125.height, 1280),
    JSON.stringify(at125),
  );
  const atOne = toLogicalWindowRect(rect, 1);
  check("a scale factor of 1 is the identity", atOne.originX === 200 && atOne.width === 2400);
  const defensive = toLogicalWindowRect(rect, 0);
  check(
    "a nonsensical scale factor cannot produce infinities",
    Number.isFinite(defensive.width) && defensive.width === 2400,
    JSON.stringify(defensive),
  );

  // The same conversion applied through the reader, end to end.
  resetForegroundWindowCache();
  const scaled = await loadForegroundWindow(1.25, reader(rect));
  check(
    "the loader applies the conversion exactly once",
    scaled.window && near(scaled.window.width, 1920) && near(scaled.window.originX, 160),
    JSON.stringify(scaled.window),
  );
}

// --- Zero-sized / invalid native rectangles ---------------------------------
{
  resetForegroundWindowCache();
  // A minimised window reported as 0x0 by the native layer.
  const zero = await loadForegroundWindow(1, reader({ x: 10, y: 10, width: 0, height: 0 }));
  check("a zero-sized native rectangle yields no fact", zero.window === null);

  // A non-finite coordinate must never become NaN in the environment layer.
  resetForegroundWindowCache();
  const broken = await loadForegroundWindow(1, reader({ x: Number.NaN, y: 0, width: 10, height: 10 }));
  check("a non-finite native rectangle yields no fact", broken.window === null);
}

// --- Fixture D + failure retention -------------------------------------------
{
  resetForegroundWindowCache();
  const good = reader({ x: 100, y: 80, width: 1200, height: 800 });
  const first = await loadForegroundWindow(1, good);
  check("a valid fact is established", first.window !== null && first.source === "native");

  // The next read fails: the good fact must survive.
  const failed = await loadForegroundWindow(1, throwing());
  check(
    "a failed read retains the previous valid fact",
    failed.source === "retained" && failed.window !== null,
    `source=${failed.source}`,
  );
  check(
    "the retained fact is the same rectangle, not a new one",
    failed.window &&
      failed.window.originX === 100 &&
      failed.window.originY === 80 &&
      failed.window.width === 1200 &&
      failed.window.height === 800,
    JSON.stringify(failed.window),
  );
  check("a failure is never turned into 'no window'", failed.window !== null);

  // A failure with nothing valid to keep says so honestly.
  resetForegroundWindowCache();
  const orphan = await loadForegroundWindow(1, throwing());
  check(
    "a first failure with no valid fact reports unavailable",
    orphan.source === "unavailable" && orphan.window === null,
    `source=${orphan.source}`,
  );

  // Recovery: a later good read replaces the retained one.
  const recovered = await refreshForegroundWindow(1, reader({ x: 0, y: 0, width: 640, height: 480 }));
  check(
    "a later successful read replaces the retained fact",
    recovered.source === "native" &&
      recovered.window !== null &&
      recovered.window.width === 640,
    JSON.stringify(recovered.window),
  );

  // And a success reporting "no window" is real information, not a failure.
  const none = await refreshForegroundWindow(1, reader(null));
  check(
    "a successful read of 'no foreground window' is native, not retained",
    none.source === "native" && none.window === null,
    `source=${none.source}`,
  );
}

// --- The fact cannot become behaviour ---------------------------------------
{
  resetForegroundWindowCache();
  const module = await import("../src/lib/desktop/windows.ts");
  const surface = Object.keys(module).sort().join(",");
  check(
    "the module exposes facts and the reader seam only",
    surface ===
      "currentForegroundSnapshot,loadForegroundWindow,refreshForegroundWindow,resetForegroundWindowCache,tauriForegroundWindowReader,toLogicalWindowRect,watchForegroundChanges",
    surface,
  );
  check(
    "no movement, personality, animation or click-through surface",
    !/seekTo|aimAt|notice|setArea|setBehaviorProfile|pickDestination|step\(|clip|animation|ignoreCursor/i.test(
      surface,
    ),
  );
  // The fact must not depend on any timer: 13B.3 owns refreshing.
  const source = (await import("node:fs")).readFileSync("src/lib/desktop/windows.ts", "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  check(
    "the module imports neither the flight controller, personality nor React",
    !imports.some((specifier) =>
      /flight|personality|react|awareness/i.test(specifier),
    ),
    imports.join(", ") || "none",
  );
  check(
    "the module contains no polling",
    !/setInterval|setTimeout|requestAnimationFrame/.test(source),
  );
  check(
    "the native command name is used verbatim",
    source.includes('"foreground_window"'),
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
